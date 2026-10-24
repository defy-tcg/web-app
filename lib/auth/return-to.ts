/** Only native account pages may resume after login. All other inputs use the
 * existing dashboard destination, including encoded URLs and duplicate params. */
export function nativeReturnTo(value: unknown): string {
  if (value === '/native-warehouse') return value;
  return typeof value === 'string' && /^\/native-warehouse\/authorize\?requestId=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) ? value : '/';
}
