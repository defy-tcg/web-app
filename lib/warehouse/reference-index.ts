import { eligible, FEATURE_ALGORITHM, type Card, type Reference, type Signature } from './model.ts';

/** A source fingerprint, not a product/SKU identity. Shared by unchanged images only. */
export function referenceSourceKey(card: Card): string {
  return JSON.stringify([FEATURE_ALGORITHM, card.image_url, card.front_asset || '', card.image_match || '']);
}
export function canIndex(card: Card): boolean {
  return eligible(card) && card.image_is_exact === '1' && Boolean(card.image_url);
}
export type ReferenceAttempt = { masterId: string; sourceKey: string; status: string };
export type ReferenceWork = { sourceKey: string; masterId: string; masterIds: string[]; imageUrl: string; name: string };
export type ReferencePlan = {
  version: string; algorithm: string; total: number; eligible: number; exact: number;
  prepared: number; failed: number; manualOnly: number; pending: number;
  ready: boolean; work: ReferenceWork[];
};
export type ReferenceResult = { sourceKey: string; signature?: Signature | null; error?: string };
export function planReferenceWork(version: string, cards: Card[], refs: Reference[], attempts: ReferenceAttempt[]): ReferencePlan {
  const usable = cards.filter(eligible);
  const exact = usable.filter(canIndex);
  const readyIds = new Set(refs.filter(r => r.signature.algorithm === FEATURE_ALGORITHM && r.signature.values.length === 192).map(r => r.masterId));
  const failedKeys = new Set(attempts.filter(a => a.status === 'failed').map(a => JSON.stringify([a.masterId, a.sourceKey])));
  const groups = new Map<string, ReferenceWork>();
  let prepared = 0, failed = 0, pending = 0;
  for (const card of exact) {
    if (readyIds.has(card.master_id)) { prepared++; continue; }
    const sourceKey = referenceSourceKey(card);
    if (failedKeys.has(JSON.stringify([card.master_id, sourceKey]))) { failed++; continue; }
    pending++;
    const group = groups.get(sourceKey);
    if (group) group.masterIds.push(card.master_id);
    else groups.set(sourceKey, { sourceKey, masterId: card.master_id, masterIds: [card.master_id], imageUrl: card.image_url, name: card.card_name });
  }
  return { version, algorithm: FEATURE_ALGORITHM, total: cards.length, eligible: usable.length, exact: exact.length, prepared, failed,
    manualOnly: usable.length - exact.length + failed, pending, ready: pending === 0 && prepared > 0, work: [...groups.values()] };
}
