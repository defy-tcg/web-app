import type {CatalogProduct} from '../../receiving/src/catalog-client.ts';

export const SEALED_PRICING_URL = 'https://defy-store-os.vercel.app/api/shopify/pos/sealed-pricing';
export type PokemonProduct = CatalogProduct & {game: 'pokemon'};
export type SealedQuote = {
  code: string;
  product: PokemonProduct;
  currency: 'USD';
  fetchedAt: string;
  mappingSource: 'saved' | 'shopify' | 'confirmed';
};
export type ScanResult = {status: 'unmapped'; code: string; suggestedQuery?: string} | {status: 'quoted'; quote: SealedQuote};
export type SavedMatch = {id: string; source: 'saved'};
export class SealedPricingError extends Error {
  readonly match?: SavedMatch;
  constructor(message: string, match?: SavedMatch) {
    super(message);
    this.name = 'SealedPricingError';
    this.match = match;
  }
}
type Transport = {getToken(): Promise<string | null | undefined>; request: typeof fetch};
type Input = {action: 'scan'; code: string} | {action: 'link'; code: string; id: string; expectedId: string | null};
const MAX_RESPONSE_BYTES = 32_000;
const REQUEST_TIMEOUT_MS = 30_000;
const invalid = () => new Error('Scrydex pricing returned incomplete details. Scan the product again.');
const clean = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max
  && (empty || Boolean(value.trim())) && !/[\u0000-\u001f\u007f]/.test(value);
const validId = (value: unknown): value is string => clean(value, 100) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);

export function normalizeSealedCode(value: string): string {
  const code = value.trim();
  if (!clean(code, 128)) throw new Error('Enter a manufacturer SKU, UPC, or EAN between 1 and 128 characters.');
  return code;
}

export function parseSealedQuote(value: unknown, code: string, id?: string): SealedQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const quote = value as Record<string, unknown>;
  if (quote.code !== code || quote.currency !== 'USD' || typeof quote.mappingSource !== 'string' || !['saved', 'shopify', 'confirmed'].includes(quote.mappingSource)
    || !clean(quote.fetchedAt, 40) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(quote.fetchedAt)
    || !Number.isFinite(Date.parse(quote.fetchedAt))) throw invalid();
  if (!quote.product || typeof quote.product !== 'object' || Array.isArray(quote.product)) throw invalid();
  const product = quote.product as Record<string, unknown>;
  if (!validId(product.id) || (id !== undefined && product.id !== id) || product.game !== 'pokemon'
    || !clean(product.name, 300) || !clean(product.setName, 300) || product.language !== 'English' || !clean(product.unit, 80, true)
    || !(product.marketCents === null || (typeof product.marketCents === 'number' && Number.isSafeInteger(product.marketCents)
      && product.marketCents > 0 && product.marketCents <= 100_000_000))) throw invalid();
  if (product.imageUrl !== null) {
    if (!clean(product.imageUrl, 2048)) throw invalid();
    let image: URL;
    try { image = new URL(product.imageUrl); } catch { throw invalid(); }
    if (image.protocol !== 'https:' || image.hostname !== 'images.scrydex.com' || image.username || image.password || image.port) throw invalid();
  }
  return {code, currency: 'USD', fetchedAt: quote.fetchedAt, mappingSource: quote.mappingSource as SealedQuote['mappingSource'],
    product: {id: product.id, game: 'pokemon', name: product.name.trim(), setName: product.setName.trim(), language: 'English',
      unit: product.unit.trim(), imageUrl: product.imageUrl as string | null, marketCents: product.marketCents as number | null}};
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new DOMException('The request was canceled.', 'AbortError'));
    if (signal.aborted) { work.catch(() => undefined); stop(); return; }
    signal.addEventListener('abort', stop, {once: true});
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES || !response.body) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, {once: true});
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { cancel(); throw invalid(); }
      body += decoder.decode(chunk.value, {stream: true});
    }
    return JSON.parse(body + decoder.decode());
  } catch (error) {
    if (signal.aborted) throw error;
    throw invalid();
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Only reads market prices and saves explicit barcode matches; no Shopify product/cart mutations. */
export function createSealedPricingClient(transport: Transport) {
  async function post(input: Input, signal?: AbortSignal): Promise<ScanResult> {
    input = {...input, code: normalizeSealedCode(input.code)};
    if (input.action === 'link' && (!validId(input.id) || (input.expectedId !== null && !validId(input.expectedId)))) throw invalid();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) cancel();
    signal?.addEventListener('abort', cancel, {once: true});
    const timeout = setTimeout(cancel, REQUEST_TIMEOUT_MS);
    try {
      if (controller.signal.aborted) throw new DOMException('Canceled', 'AbortError');
      const token = await abortable(transport.getToken(), controller.signal);
      if (!token?.trim()) throw new Error('Sign in to Shopify POS with permission to use the Defy app.');
      const response = await abortable(transport.request(SEALED_PRICING_URL, {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
        body: JSON.stringify(input), signal: controller.signal,
      }), controller.signal);
      if (response.status === 401 || response.status === 403) throw new Error('Your Shopify POS session could not access sealed pricing. Sign in again or ask the owner to check app access.');
      const body = await readBody(response, controller.signal);
      if (!response.ok) {
        const message = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
        const rawMatch = body && typeof body === 'object' && 'match' in body ? body.match : undefined;
        let match: SavedMatch | undefined;
        if (rawMatch !== undefined) {
          if (!rawMatch || typeof rawMatch !== 'object' || Array.isArray(rawMatch) || !('id' in rawMatch) || !validId(rawMatch.id)
            || !('source' in rawMatch) || rawMatch.source !== 'saved') throw invalid();
          match = {id: rawMatch.id, source: 'saved'};
        }
        throw new SealedPricingError(clean(message, 600) ? message : 'Live sealed pricing is unavailable. Check your connection and try again.', match);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
      const result = body as Record<string, unknown>;
      if (result.status === 'unmapped' && input.action === 'scan') {
        if (result.code !== input.code || (result.suggestedQuery !== undefined && !clean(result.suggestedQuery, 100))) throw invalid();
        return {status: 'unmapped', code: input.code, ...(typeof result.suggestedQuery === 'string' ? {suggestedQuery: result.suggestedQuery} : {})};
      }
      if (result.status !== 'quoted') throw invalid();
      return {status: 'quoted', quote: parseSealedQuote(result.quote, input.code, input.action === 'link' ? input.id : undefined)};
    } catch (error) {
      if (controller.signal.aborted) throw new Error(signal?.aborted ? 'The pricing request was canceled.' : 'Live sealed pricing timed out. Try again.');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  }
  return {
    scan: (code: string, signal?: AbortSignal) => post({action: 'scan', code}, signal),
    async link(code: string, id: string, expectedId: string | null, signal?: AbortSignal): Promise<SealedQuote> {
      const result = await post({action: 'link', code, id, expectedId}, signal);
      if (result.status !== 'quoted') throw invalid();
      return result.quote;
    },
  };
}
