import { neon } from '@neondatabase/serverless';
import { randomUUID, createHash } from 'node:crypto';
import { applyOperation, emptyState, eligible, finish, parseCatalog, signature, FEATURE_ALGORITHM, WAREHOUSE_VERSION, type Card, type Command, type Reference, type State } from './model.ts';
import { canIndex, referenceSourceKey, planReferenceWork, type ReferenceResult } from './reference-index.ts';

function database() { const url = process.env.WAREHOUSE_DATABASE_URL || process.env.DATABASE_URL; if (!url) throw new Error('Warehouse database is not configured.'); return neon(url); }
let initialization: Promise<void> | undefined;
export function initializeWarehouse() { if (!initialization) initialization = (async () => { const sql = database(); await sql`CREATE SCHEMA IF NOT EXISTS rift_warehouse`; await sql`CREATE TABLE IF NOT EXISTS rift_warehouse.state (id text PRIMARY KEY, revision integer NOT NULL DEFAULT 0, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`; await sql`CREATE TABLE IF NOT EXISTS rift_warehouse.catalogs (version text PRIMARY KEY, metadata jsonb NOT NULL, cards jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`; await sql`CREATE TABLE IF NOT EXISTS rift_warehouse.images (id text PRIMARY KEY, mime text NOT NULL, bytes bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`; await sql`CREATE TABLE IF NOT EXISTS rift_warehouse.references (catalog_version text NOT NULL REFERENCES rift_warehouse.catalogs(version), master_id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(catalog_version, master_id))`; await sql`CREATE TABLE IF NOT EXISTS rift_warehouse.reference_assets (source_key text PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`; await sql`CREATE TABLE IF NOT EXISTS rift_warehouse.reference_attempts (catalog_version text NOT NULL REFERENCES rift_warehouse.catalogs(version), master_id text NOT NULL, source_key text NOT NULL, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(catalog_version, master_id))`; await sql`INSERT INTO rift_warehouse.state (id, payload) VALUES ('main', ${JSON.stringify(emptyState())}::jsonb) ON CONFLICT (id) DO NOTHING`; })().catch(error => { initialization = undefined; throw error; }); return initialization; }
export type Snapshot = { revision: number; state: State };
export async function readSnapshot(): Promise<Snapshot> { await initializeWarehouse(); const sql = database(); const rows = await sql`SELECT revision, payload FROM rift_warehouse.state WHERE id = 'main'`; return { revision: Number(rows[0].revision), state: rows[0].payload as State }; }
const catalogCache = new Map<string, { cards: Card[]; metadata: Record<string, unknown> }>();
const readyIndexes = new Set<string>();
const poolCache = new Map<string, { until: number; refs: Reference[] }>();
function invalidateReferences(version: string) { readyIndexes.delete(version); for (const key of poolCache.keys()) if (key.startsWith(version + ':')) poolCache.delete(key); }
export async function readCatalog(version: string) {
  if (!/^[a-f0-9]{64}$/.test(version)) throw new Error('Invalid catalog version.');
  const cached = catalogCache.get(version); if (cached) return cached;
  await initializeWarehouse(); const sql = database();
  const rows = await sql`SELECT cards, metadata FROM rift_warehouse.catalogs WHERE version = ${version}`;
  if (!rows.length) throw new Error('Catalog version not found.');
  const result = { cards: rows[0].cards as Card[], metadata: rows[0].metadata as Record<string, unknown> };
  if (catalogCache.size >= 3) catalogCache.delete(catalogCache.keys().next().value!);
  catalogCache.set(version, result); return result;
}
async function readPool(version: string, batchFinish: string, language: string, cards: Card[]): Promise<Reference[]> {
  const key = version + ':' + batchFinish + ':' + language;
  const hit = poolCache.get(key); if (hit && hit.until > Date.now()) return hit.refs;
  const ids = cards.filter(c => canIndex(c) && finish(c.finish) === batchFinish && c.language === language).map(c => c.master_id);
  const sql = database(); const rows = await sql`SELECT master_id, payload FROM rift_warehouse.references WHERE catalog_version = ${version} AND master_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
  const refs = rows.map(r => ({ masterId: String(r.master_id), signature: r.payload }));
  if (poolCache.size >= 8) poolCache.delete(poolCache.keys().next().value!);
  poolCache.set(key, { until: Date.now() + 30_000, refs }); return refs;
}
export class ConflictError extends Error {}
async function saveState(revision: number, state: State, image?: { id: string; base64: string }) { const payload = JSON.stringify(state); if (Buffer.byteLength(payload) > 3_000_000) throw new Error('The supervised pilot has reached its workflow-size limit. No change was saved. Extend paginated storage before adding more stock; do not reset existing data.'); const sql = database(); const rows = image ? await sql`WITH updated AS (UPDATE rift_warehouse.state SET revision = revision + 1, payload = ${payload}::jsonb, updated_at = now() WHERE id = 'main' AND revision = ${revision} RETURNING revision, payload), saved_image AS (INSERT INTO rift_warehouse.images (id, mime, bytes) SELECT ${image.id}, 'image/jpeg', decode(${image.base64}, 'base64') FROM updated) SELECT revision, payload FROM updated` : await sql`UPDATE rift_warehouse.state SET revision = revision + 1, payload = ${payload}::jsonb, updated_at = now() WHERE id = 'main' AND revision = ${revision} RETURNING revision, payload`; if (!rows.length) throw new ConflictError('Another device changed the warehouse. Refresh and retry; nothing was overwritten.'); return { revision: Number(rows[0].revision), state: rows[0].payload as State }; }
export async function executeWarehouse(command: Command, expectedRevision: number, actor: string) { const current = await readSnapshot(); if (current.state.operationIds.includes(command.operationId)) return current; if (current.revision !== expectedRevision) throw new ConflictError('Another device changed the warehouse. Refresh and retry.'); const now = new Date().toISOString();
  if (command.kind === 'importCatalog' || command.kind === 'stageCatalog') { if (typeof command.csv !== 'string') throw new Error('Upload the Sorting Catalog CSV.'); const cards = parseCatalog(command.csv); const version = createHash('sha256').update(command.csv).digest('hex'); const metadata = { version, count: cards.length, sourceFilename: typeof command.filename === 'string' ? command.filename.slice(0, 250) : 'catalog.csv', importedAt: now, releasedEligible: cards.filter(eligible).length, source: 'User-provided reference; release and exactness flags are not a new market verification.' }; const sql = database(); await sql`INSERT INTO rift_warehouse.catalogs (version, metadata, cards) VALUES (${version}, ${JSON.stringify(metadata)}::jsonb, ${JSON.stringify(cards)}::jsonb) ON CONFLICT (version) DO NOTHING`; if (current.state.activeCatalog === version && !current.state.pendingCatalog) return current; const next = structuredClone(current.state); next.pendingCatalog = version; next.audit.push({ id: randomUUID(), at: now, actor, action: 'importCatalog', detail: `Staged ${cards.length} catalog definitions for automatic reference preparation. No stock created. Existing batches retain their prior catalog.` }); next.operationIds.push(command.operationId); return saveState(current.revision, next); }
  if (command.kind === 'activateCatalog') {
    const version = String(command.catalogVersion || '');
    if (current.state.activeCatalog === version && !current.state.pendingCatalog) return current;
    if (current.state.pendingCatalog !== version) throw new Error('This is not the staged catalog. Refresh the Mastersheet.');
    const plan = await readReferencePlan(version);
    if (!plan.ready) throw new Error('The staged catalog is still preparing. The previous catalog remains active.');
    const next = structuredClone(current.state); next.activeCatalog = version; next.pendingCatalog = null;
    next.audit.push({ id: randomUUID(), at: now, actor, action: 'activateCatalog', detail: `Activated ${plan.total} references with ${plan.prepared} indexed printings; ${plan.manualOnly} eligible printings need manual image review. Previous catalog and inventory retained.` });
    next.operationIds.push(command.operationId); return saveState(current.revision, next);
  }
  const batchId = command.batchId || current.state.scans.find(s => s.id === command.scanId)?.batchId;
  const batch = current.state.batches.find(b => b.id === batchId);
  const version = batch?.catalogVersion || current.state.activeCatalog;
  const catalog = version ? await readCatalog(version) : { cards: [] as Card[] };
  let references: Reference[] = [];
  if ((command.kind === 'uploadScan' || command.kind === 'matchScan') && batch && !readyIndexes.has(batch.catalogVersion)) { const plan = await readReferencePlan(batch.catalogVersion); if (!plan.ready) throw new Error('The one-time catalog image update is still running. Scanning unlocks automatically when ready.'); }
  if ((command.kind === 'matchScan' || command.kind === 'uploadScan') && batch) references = await readPool(batch.catalogVersion, batch.finish, batch.language, catalog.cards);
  const next = applyOperation(current.state, command, catalog.cards, actor, now, randomUUID, references);
  let image: { id: string; base64: string } | undefined;
  if (command.kind === 'uploadScan') { if (typeof command.image !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(command.image) || command.image.length > 2_800_000) throw new Error('Use a JPEG scan preview below 2 MB.'); const base64 = command.image.split(',')[1]; const bytes = Buffer.from(base64, 'base64'); if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('The scan preview is not a JPEG.'); image = { id: String(command.scanId), base64 }; }
  return saveState(current.revision, next, image);
}
export async function readImage(id: string) { await initializeWarehouse(); if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid scan image ID.'); const sql = database(); const rows = await sql`SELECT mime, encode(bytes, 'base64') AS data FROM rift_warehouse.images WHERE id = ${id}`; if (!rows.length) return null; return { mime: String(rows[0].mime), bytes: Buffer.from(String(rows[0].data), 'base64') }; }
export async function saveReference(version: string, masterId: string, value: unknown) { const s = signature(value); if (!s) throw new Error('Reference has no image signature.'); const { cards } = await readCatalog(version); const card = cards.find(c => c.master_id === masterId); if (!card || card.image_is_exact !== '1' || !card.image_url) throw new Error('This record has no exact reference image.'); const sql = database(); await sql`INSERT INTO rift_warehouse.references (catalog_version, master_id, payload) VALUES (${version}, ${masterId}, ${JSON.stringify(s)}::jsonb) ON CONFLICT (catalog_version, master_id) DO UPDATE SET payload = excluded.payload`; invalidateReferences(version); return { saved: true, algorithm: FEATURE_ALGORITHM }; }
export async function referenceIds(version: string) { const sql = database(); const rows = await sql`SELECT master_id FROM rift_warehouse.references WHERE catalog_version = ${version}`; return rows.map(r => String(r.master_id)); }
export const release = { version: WAREHOUSE_VERSION, originalSitesSourceRecovered: false, migratedOriginalInventory: false, integration: 'isolated schema; no Shopify or Defy stock mutations' };

/** Durable, shared preparation. Nothing here changes inventory or approves scans. */
export async function readReferencePlan(version: string) {
  const { cards } = await readCatalog(version); const sql = database();
  const entries = cards.filter(canIndex).map(c => ({ id: c.master_id, source_key: referenceSourceKey(c) }));
  await sql`INSERT INTO rift_warehouse.reference_assets (source_key, payload)
    SELECT DISTINCT ON (e.source_key) e.source_key, r.payload
    FROM jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) AS e(id text, source_key text)
    JOIN rift_warehouse.references r ON r.catalog_version = ${version} AND r.master_id = e.id
    WHERE r.payload->>'algorithm' = ${FEATURE_ALGORITHM}
    ON CONFLICT (source_key) DO NOTHING`;
  const reused = await sql`INSERT INTO rift_warehouse.references (catalog_version, master_id, payload)
    SELECT ${version}, e.id, a.payload FROM jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) AS e(id text, source_key text)
    JOIN rift_warehouse.reference_assets a ON a.source_key = e.source_key
    ON CONFLICT (catalog_version, master_id) DO NOTHING RETURNING master_id`;
  if (reused.length) invalidateReferences(version);
  const [rows, attempts] = await Promise.all([
    sql`SELECT master_id, payload FROM rift_warehouse.references WHERE catalog_version = ${version}`,
    sql`SELECT master_id, source_key, status FROM rift_warehouse.reference_attempts WHERE catalog_version = ${version}`,
  ]);
  const plan = planReferenceWork(version, cards, rows.map(r => ({ masterId: String(r.master_id), signature: r.payload })),
    attempts.map(a => ({ masterId: String(a.master_id), sourceKey: String(a.source_key), status: String(a.status) })));
  if (plan.ready) { if (readyIndexes.size >= 12) readyIndexes.delete(readyIndexes.values().next().value!); readyIndexes.add(version); } return plan;
}
export async function saveReferenceResults(version: string, results: ReferenceResult[]) {
  if (!Array.isArray(results) || results.length < 1 || results.length > 40) throw new Error('Submit 1–40 reference results.');
  const { cards } = await readCatalog(version); const groups = new Map<string, string[]>();
  for (const card of cards.filter(canIndex)) { const key = referenceSourceKey(card); groups.set(key, [...(groups.get(key) || []), card.master_id]); }
  const success: { master_id: string; source_key: string; payload: unknown }[] = [];
  const assets: { source_key: string; payload: unknown }[] = [];
  const attempts: { master_id: string; source_key: string; status: string }[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (!result || typeof result.sourceKey !== 'string' || !groups.has(result.sourceKey) || seen.has(result.sourceKey)) throw new Error('Invalid or repeated reference source.');
    seen.add(result.sourceKey); const value = signature(result.signature);
    if (!value && !result.error) throw new Error('A reference needs a signature or an unavailable-image result.');
    if (value) assets.push({ source_key: result.sourceKey, payload: value });
    for (const id of groups.get(result.sourceKey)!) {
      attempts.push({ master_id: id, source_key: result.sourceKey, status: value ? 'ready' : 'failed' });
      if (value) success.push({ master_id: id, source_key: result.sourceKey, payload: value });
    }
  }
  const sql = database();
  await sql`WITH saved_assets AS (
    INSERT INTO rift_warehouse.reference_assets (source_key, payload)
    SELECT source_key, payload FROM jsonb_to_recordset(${JSON.stringify(assets)}::jsonb) AS a(source_key text, payload jsonb)
    ON CONFLICT (source_key) DO NOTHING
  ), saved_refs AS (
    INSERT INTO rift_warehouse.references (catalog_version, master_id, payload)
    SELECT ${version}, master_id, payload FROM jsonb_to_recordset(${JSON.stringify(success)}::jsonb) AS r(master_id text, payload jsonb)
    ON CONFLICT (catalog_version, master_id) DO NOTHING
  ) INSERT INTO rift_warehouse.reference_attempts (catalog_version, master_id, source_key, status)
    SELECT ${version}, master_id, source_key, status FROM jsonb_to_recordset(${JSON.stringify(attempts)}::jsonb) AS a(master_id text, source_key text, status text)
    ON CONFLICT (catalog_version, master_id) DO UPDATE SET source_key = excluded.source_key, status = excluded.status, updated_at = now()`;
  invalidateReferences(version); return { saved: success.length, unavailable: attempts.length - success.length };
}
export async function retryUnavailableReferences(version: string) {
  await readCatalog(version); const sql = database();
  invalidateReferences(version);
  await sql`UPDATE rift_warehouse.reference_attempts SET status = 'pending', updated_at = now() WHERE catalog_version = ${version} AND status = 'failed'`;
  return { scheduled: true };
}
