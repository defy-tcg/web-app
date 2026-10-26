import type { BulkCopy } from './model.ts';

// Presentation only: condition, status, location, prices and comparison fingerprints
// belong to physical copies. Never normalize finish/language or guess identity by name.
export function groupBulkCopies(copies: readonly BulkCopy[]) {
  const groups = new Map<string, { key: string; copies: BulkCopy[]; available: number }>();
  for (const copy of copies) {
    const d = copy.data;
    const key = JSON.stringify([copy.warehouseId, d.masterId || copy.copyId,
      d.name, d.setName, d.cardNumber, d.rarity, d.finish, d.language]);
    let group = groups.get(key);
    if (!group) { group = { key, copies: [], available: 0 }; groups.set(key, group); }
    group.copies.push(copy);
    if (d.available && !copy.pending) group.available++;
  }
  return [...groups.values()];
}
