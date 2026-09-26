import {RECEIVING_CATALOG_GAMES} from './receiving-catalog.ts';

export const SEALED_CATALOG_URL = 'https://defy-store-os.vercel.app/api/shopify/pos/sealed-catalog';
export const CATALOG_GAMES = RECEIVING_CATALOG_GAMES;
export const CATALOG_GAME_LABELS = {...CATALOG_GAMES, magicthegathering: 'Magic: The Gathering (MTG)'} as const;
export type CatalogGame = keyof typeof CATALOG_GAMES;
export type CatalogProduct = {
  id: string; game: CatalogGame; name: string; setName: string; language: 'English';
  unit: string; imageUrl: string | null; marketCents: number | null;
};
export type CatalogIdentity = Pick<CatalogProduct, 'game' | 'id' | 'name' | 'setName' | 'language'>;
type Transport = {getToken(): Promise<string | null | undefined>; request: typeof fetch};
const MAX_RESPONSE_BYTES = 128_000;
const invalid = () => new Error('The sealed catalog returned incomplete details. Search again before selecting a product.');
const clean = (value: unknown, max: number, optional = false): value is string => typeof value === 'string' && value.length <= max
  && (optional || Boolean(value.trim())) && !/[\u0000-\u001f\u007f]/.test(value);
const isGame = (value: unknown): value is CatalogGame => typeof value === 'string' && Object.hasOwn(CATALOG_GAMES, value);

export function catalogIdentity(product: CatalogProduct): CatalogIdentity {
  return {game: product.game, id: product.id, name: product.name, setName: product.setName, language: product.language};
}

function parseProduct(value: unknown, game: CatalogGame, id?: string): CatalogProduct {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const p = value as Record<string, unknown>;
  if (!clean(p.id, 100) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(p.id) || (id && p.id !== id)
    || p.game !== game || !clean(p.name, 300) || !clean(p.setName, 300)
    || p.language !== 'English' || !clean(p.unit, 80, true)
    || !(p.marketCents === null || (typeof p.marketCents === 'number' && Number.isSafeInteger(p.marketCents) && p.marketCents > 0 && p.marketCents <= 100_000_000))) throw invalid();
  if (p.imageUrl !== null) {
    if (!clean(p.imageUrl, 2048)) throw invalid();
    let image: URL;
    try { image = new URL(p.imageUrl); } catch { throw invalid(); }
    if (image.protocol !== 'https:' || image.hostname !== 'images.scrydex.com' || image.username || image.password || image.port) throw invalid();
  }
  return {id: p.id, game, name: p.name.trim(), setName: p.setName.trim(), language: 'English', unit: p.unit.trim(), imageUrl: p.imageUrl as string | null, marketCents: p.marketCents as number | null};
}

async function readBody(response: Response): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES) throw invalid();
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw invalid(); }
      body += decoder.decode(chunk.value, {stream: true});
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch { throw invalid(); }
  finally { reader.releaseLock(); }
}

export function createSealedCatalogClient(transport: Transport) {
  async function post(input: {game: CatalogGame; query: string} | {game: CatalogGame; id: string}) {
    if (!isGame(input.game)) throw new Error('Choose Pokémon, One Piece, Riftbound, Gundam, or Magic: The Gathering.');
    if ('query' in input && (!clean(input.query, 100) || input.query.trim().length < 3)) throw new Error('Enter a product name between 3 and 100 characters.');
    if ('id' in input && (!clean(input.id, 100) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.id))) throw invalid();
    const token = await transport.getToken();
    if (!token) throw new Error('Sign in to Shopify POS with permission to use the Defy app.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await transport.request(SEALED_CATALOG_URL, {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
        body: JSON.stringify(input), signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) throw new Error('Your Shopify POS session could not access the catalog. Sign in again or ask the owner to check app access.');
      const data = await readBody(response);
      if (!response.ok) {
        const message = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
        throw new Error(clean(message, 600) ? message : 'The sealed catalog is unavailable. Try again or use the manual Shopify catalog search.');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
      return data as Record<string, unknown>;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('The sealed catalog timed out. Try again or search Shopify manually.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  return {
    async search(game: CatalogGame, query: string) {
      const data = await post({game, query: query.trim()});
      if (!Array.isArray(data.products) || data.products.length > 20 || typeof data.hasMore !== 'boolean') throw invalid();
      const products = data.products.map(value => parseProduct(value, game));
      if (new Set(products.map(product => product.id)).size !== products.length) throw invalid();
      return {products, hasMore: data.hasMore};
    },
    async detail(game: CatalogGame, id: string) {
      const data = await post({game, id});
      return parseProduct(data.product, game, id);
    },
  };
}
