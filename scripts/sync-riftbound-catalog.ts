import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildRiftboundCatalog, type CatalogSource, type CatalogSnapshot, type SourceGroup, type SourcePrice, type SourceProduct } from "../lib/singles/catalog.ts";

// Run manually: node --experimental-strip-types scripts/sync-riftbound-catalog.ts
// TCGCSV docs: https://tcgcsv.com/docs — custom UA, <=10 requests/sec, <=1 full pull/day.
const destination = path.join(process.cwd(), "data", "riftbound-catalog.json");
const headers = { "User-Agent": "DefyTCG-Catalog/1.0" };
async function request(relativePath: string): Promise<Response> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const response = await fetch(`https://tcgcsv.com/${relativePath}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`TCGCSV ${relativePath}: HTTP ${response.status}`);
  return response;
}
async function collection<T>(relativePath: string): Promise<T[]> {
  const response = await request(relativePath);
  const data = await response.json() as { success: boolean; errors?: unknown[]; results: T[] };
  if (!data.success || !Array.isArray(data.results)) throw new Error(`TCGCSV returned an invalid collection for ${relativePath}`);
  return data.results;
}

async function main() {
  let previous: CatalogSnapshot | null = null;
  try { previous = JSON.parse(await readFile(destination, "utf8")) as CatalogSnapshot; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const sourceUpdatedAt = (await (await request("last-updated.txt")).text()).trim();
  if (!Number.isFinite(Date.parse(sourceUpdatedAt))) throw new Error("TCGCSV returned an invalid source timestamp");
  if (previous && Date.parse(sourceUpdatedAt) <= Date.parse(previous.sourceUpdatedAt)) {
    console.log(`Catalog is already current: ${previous.sourceUpdatedAt}`);
    return;
  }
  if (previous && Date.now() - Date.parse(previous.fetchedAt) < 24 * 60 * 60 * 1000) {
    console.log("Skipping full pull: TCGCSV allows one catalog sync every 24 hours.");
    return;
  }
  const groups = await collection<SourceGroup>("tcgplayer/89/groups");
  const source: CatalogSource = { sourceUpdatedAt, fetchedAt: new Date().toISOString(), groups: [] };
  for (const group of groups) {
    const products = await collection<SourceProduct>(`tcgplayer/89/${group.groupId}/products`);
    const prices = await collection<SourcePrice>(`tcgplayer/89/${group.groupId}/prices`);
    source.groups.push({ group, products, prices });
  }
  const snapshot = buildRiftboundCatalog(source);
  if (!snapshot.cards.length) throw new Error("Refusing to replace the catalog with an empty snapshot");
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(temporary, destination);
  console.log(JSON.stringify({ sourceUpdatedAt, ...snapshot.stats }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Catalog sync failed");
  process.exitCode = 1;
});
