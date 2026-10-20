import type { Batch, Candidate, Card, Scan, Signature } from './model.ts';

/** User-configured visual-similarity cutoff; not a calibrated probability. */
export const AUTO_APPROVAL_THRESHOLD = 0.78;
export const AUTO_APPROVAL_ENABLED = true;
export const APPROVAL_POLICY = 'user-cutoff-078-v1';
export const WAREHOUSE_TIMEZONE = 'America/Los_Angeles';
export function warehouseDay(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: WAREHOUSE_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('');
}
export function generatedBatchName(batches: Batch[], now: string, finish: string): string {
  const day = warehouseDay(now);
  let sequence = batches.filter(b => warehouseDay(b.createdAt) === day).length + 1;
  const occupied = new Set(batches.flatMap(b => [b.name, b.code || '']).map(n => n.toLowerCase()));
  let name: string;
  do { name = `RW-${day}-${finish === 'Foil' ? 'F' : 'NF'}-${String(sequence++).padStart(3, '0')}`; }
  while (occupied.has(name.toLowerCase()));
  return name;
}
export function hasVisualDetail(value: Signature | null): boolean {
  if (!value || value.values.length !== 192 || !value.values.every(Number.isFinite)) return false;
  // Reject obviously blank, uniform images rather than approving their nearest color.
  for (let channel = 0; channel < 3; channel++) {
    const values = value.values.filter((_, i) => i % 3 === channel);
    if (Math.max(...values) - Math.min(...values) >= 2) return true;
  }
  return false;
}
export function automaticReviewReason(scan: Scan, batch: Batch, card: Card | undefined,
  candidates: Candidate[], scans: Scan[]): string | null {
  if (scan.manualReviewRequired) return 'Approval was withdrawn. Confirm this copy manually.';
  if (!hasVisualDetail(scan.signature)) return 'The scan has too little visual detail for automatic approval.';
  const best = candidates[0];
  if (!best) return 'No usable match. Select the correct printing.';
  if (!Number.isFinite(best.score) || best.score > 1 || !(best.score > AUTO_APPROVAL_THRESHOLD)) return 'Match score is 0.78 or below.';
  if (!card || card.inventory_eligible !== '1' || card.inventory_count_weight !== '1' ||
    card.release_status !== 'released' || !card.physical_key || card.language !== batch.language ||
    (card.finish === 'Foil' ? 'Foil' : ['Nonfoil','Normal','Non-foil'].includes(card.finish) ? 'Nonfoil' : null) !== batch.finish)
    return 'The exact printing, finish, or language requires review.';
  if (candidates[1] && best.score - candidates[1].score <= 1e-9) return 'Two printings have the same top score. Select the exact printing.';
  if (!scan.duplicateAcknowledged && scans.some(s => s.id !== scan.id && s.sha256 === scan.sha256 && s.status !== 'excluded'))
    return 'Repeated image: confirm that this is another physical copy.';
  return null;
}
