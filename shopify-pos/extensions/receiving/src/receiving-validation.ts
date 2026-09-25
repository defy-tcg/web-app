/** Sealed manufacturer barcodes only. Never coerce a scan through Number. */
export class ReceivingError extends Error {
  code: string;
  retryable: boolean;
  committedPossible: boolean;
  pending?: unknown;
  definitelyUncommitted = false;
  constructor(
    code: string,
    message: string,
    retryable = false,
    committedPossible = false,
    pending?: unknown,
  ) {
    super(message); this.name = 'ReceivingError';
    this.code = code; this.retryable = retryable; this.committedPossible = committedPossible; this.pending = pending;
  }
}

export function validation(message: string): never {
  throw new ReceivingError('VALIDATION', message);
}

export function text(value: unknown, label: string, limit: number, required = false): string {
  if (value == null) value = '';
  if (typeof value !== 'string') validation(`${label} must be text.`);
  const result = (value as string).trim();
  if (required && !result) validation(`${label} is required.`);
  if (result.length > limit) validation(`${label} is too long (maximum ${limit} characters).`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) validation(`${label} contains unsupported control characters.`);
  return result;
}

export function validBarcode(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:\d{12}|\d{13}|\d{14})$/.test(value)) return false;
  let sum = 0;
  for (let i = value.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += Number(value[i]) * weight;
  return (10 - sum % 10) % 10 === Number(value[value.length - 1]);
}

export function scanBarcode(value: unknown): string {
  if (typeof value !== 'string') validation('Scan the barcode as text so leading zeroes are preserved.');
  const result = (value as string).trim();
  if (/^\d{8}$/.test(result)) validation('Use the full 12- or 13-digit barcode; compressed 8-digit codes need scanner configuration.');
  if (!validBarcode(result)) validation('Rescan a valid 12-, 13- or 14-digit manufacturer barcode. Do not guess or change its check digit.');
  return result;
}

export function barcodeKey(barcode: string): string {
  if (validBarcode(barcode) && barcode.length === 13 && barcode[0] === '0') return `upc:${barcode.slice(1)}`;
  if (validBarcode(barcode) && barcode.length === 12) return `upc:${barcode}`;
  return `exact:${barcode}`;
}

export function barcodeAliases(barcode: string): string[] {
  scanBarcode(barcode);
  if (barcode.length === 12) return [barcode, `0${barcode}`];
  if (barcode.length === 13 && barcode[0] === '0') return [barcode, barcode.slice(1)];
  return [barcode];
}

export function quantity(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value).trim())) validation('Quantity must be a positive whole number.');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2147483647) validation('Quantity must be a positive whole number within Shopify’s supported range.');
  return result;
}

export function money(value: unknown, label = 'Unit cost'): string {
  if (typeof value !== 'string' && typeof value !== 'number') validation(`Enter ${label.toLowerCase()}, including 0.00 for free stock.`);
  const result = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(result)) validation(`${label} must be a nonnegative decimal with at most two decimal places.`);
  const [whole, decimal = ''] = result.split('.');
  const cents = Number(whole) * 100 + Number((decimal + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) validation(`${label} is too large.`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function optionalStorePrice(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') validation('Store price must be text.');
  if (!value.trim()) return undefined;
  const result = money(value, 'Store price');
  if (Number(result) > 1_000_000) validation('Store price cannot exceed 1,000,000.00.');
  return result;
}

export function isoDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) validation('Received date must use YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) validation('Received date is not a valid calendar date.');
  return value as string;
}

export function gid(value: unknown, kind: string): string {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value, `${kind} ID`, 120, true);
  if (/^[1-9]\d*$/.test(result)) return `gid://shopify/${kind}/${result}`;
  if (!new RegExp(`^gid://shopify/${kind}/[1-9]\\d*$`).test(result)) validation(`A valid Shopify ${kind} ID is required.`);
  return result;
}

/** Fixed key order is intentional: a retry must keep identical mutation inputs. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
