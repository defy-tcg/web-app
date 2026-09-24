import { getScrydexConfig, ScrydexError } from "./scrydex.ts";

export type SealedCatalogGame = "pokemon" | "onepiece" | "riftbound";
export type SealedCatalogProduct = {
  id: string; game: SealedCatalogGame; name: string; setName: string; language: "English";
  unit: string; imageUrl: string | null; marketCents: number | null;
};
type Options = { fetch?: typeof fetch; fresh?: boolean };
type ObjectValue = Record<string, unknown>;
const PAGE_SIZE = 20;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const API_BASE = "https://api.scrydex.com";
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, limit = 300): string => typeof value === "string" && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : "";
const key = (value: unknown) => text(value).normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
const upstream = () => new ScrydexError("upstream_error", "Scrydex sealed catalog is unavailable or returned an incomplete response. Retry shortly.");

function game(value: unknown): SealedCatalogGame {
  if (value !== "pokemon" && value !== "onepiece" && value !== "riftbound") {
    throw new ScrydexError("unsupported", "Choose Pokémon, One Piece, or Riftbound for sealed catalog search.");
  }
  return value;
}
function productId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new ScrydexError("incomplete_identity", "Choose a valid Scrydex sealed product ID.");
  return value;
}
function searchTerms(value: unknown, sourceGame: SealedCatalogGame): string[] {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value) || value.trim().length < 3 || value.trim().length > 100) {
    throw new ScrydexError("incomplete_identity", "Enter a product name between 3 and 100 characters.");
  }
  const normalized = value.trim().normalize("NFC");
  // The game is already scoped by the endpoint. Retailer titles often add this
  // prefix even when Scrydex omits it or uses the accented spelling.
  const query = sourceGame === "pokemon"
    ? normalized.replace(/^pok[eé]mon(?:\s+tcg)?(?:\s*:\s*|\s+|$)/iu, "").trim()
    : normalized;
  if (query.length < 3) throw new ScrydexError("incomplete_identity", "Enter a set or product name after Pokémon.");
  return query.split(/\s+/);
}
const quote = (value: string) => `"${value.replace(/[+\-!(){}\[\]^"~*?:\\/|&]/g, "\\$&")}"`;

function english(candidate: ObjectValue): boolean {
  const expansion = object(candidate.expansion);
  const codes = [candidate.language_code, expansion.language_code].map(key).filter(Boolean);
  const names = [candidate.language, expansion.language].map(key).filter(Boolean);
  return codes.length + names.length > 0 && codes.every(value => value === "en") && names.every(value => value === "english")
    && candidate.is_online_only !== true && expansion.is_online_only !== true && expansion.is_foreign_only !== true;
}
function normalEdition(candidate: ObjectValue): boolean {
  // Receiving identities do not include an edition, so never collapse editions into one SKU.
  return Array.isArray(candidate.variants) && candidate.variants.length === 1 && key(object(candidate.variants[0]).name) === "normal";
}
function unit(type: string, name: string): string {
  // Preserve packaging distinctions. Unknown provider types stay explicit for staff review.
  const units: Record<string, string> = {
    "booster pack": "Booster pack", "booster box": "Booster box", "booster bundle": "Booster bundle",
    "collection box": "Collection box", "elite trainer box": "Elite Trainer Box", tin: "Tin",
    deck: "Deck", "starter deck": "Deck", "theme deck": "Deck", "battle deck": "Deck",
    display: "Display", "booster display": "Display", case: "Case", "booster case": "Case",
  };
  const productName = key(name);
  // The provider often assigns a display or case its contained product's type.
  if (/\bcase\b/.test(productName)) return "Case";
  if (/\bdisplay\b/.test(productName)) return "Display";
  const mapped = units[key(type)] ?? "Other sealed unit";
  if (mapped !== "Case" && mapped !== "Display" && /\b(?:\d+\s*[-–]?\s*packs?|set\s+of\s+\d+)\b/.test(productName)) return "Other sealed unit";
  return mapped;
}
function market(candidate: ObjectValue): number | null {
  const variants = array(candidate.variants).map(object).filter(variant => key(variant.name) === "normal");
  if (variants.length !== 1) return null;
  const prices = array(variants[0].prices).map(object).filter(price => price.type === "raw" && price.condition === "U" && price.currency === "USD"
    && price.is_signed !== true && price.is_error !== true && price.is_perfect !== true);
  if (prices.length !== 1) return null;
  const amount = prices[0].market;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round((amount + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100_000_000 ? cents : null;
}
function image(candidate: ObjectValue): string | null {
  const normal = array(candidate.variants).map(object).filter(variant => key(variant.name) === "normal");
  const images = [...(normal.length === 1 ? array(normal[0].images) : []), ...array(candidate.images)].map(object);
  for (const front of images.filter(item => key(item.type) === "front")) {
    for (const size of [front.medium, front.large, front.small]) {
      try {
        const url = new URL(text(size, 2048));
        if (url.protocol === "https:" && url.hostname === "images.scrydex.com" && !url.username && !url.password && !url.port) return url.href;
      } catch { /* Missing or untrusted images do not invalidate a catalog identity. */ }
    }
  }
  return null;
}
function product(value: unknown, sourceGame: SealedCatalogGame): SealedCatalogProduct | null {
  const candidate = object(value);
  const id = text(candidate.id, 100);
  const name = text(candidate.name);
  // Standalone sealed collections may have no expansion. Keep that absence
  // explicit; language and the exact provider ID are still required below.
  const setName = candidate.expansion == null ? "No set listed" : text(object(candidate.expansion).name, 300);
  const type = text(candidate.type, 100);
  if (!SAFE_ID.test(id) || !name || !setName || !type || !english(candidate) || !normalEdition(candidate)) return null;
  return { id, game: sourceGame, name, setName, language: "English", unit: unit(type, name), imageUrl: image(candidate), marketCents: market(candidate) };
}

/** Credentials, caching and provider requests stay on the server. No barcode lookup is inferred. */
async function request(url: URL, options: Options, detail = false): Promise<ObjectValue> {
  if (typeof window !== "undefined") throw new ScrydexError("unsupported", "Scrydex sealed catalog access is server-only.");
  const { apiKey, teamId } = getScrydexConfig();
  let response: Response;
  let payload: unknown;
  try {
    const init: RequestInit & { next?: { revalidate: number } } = {
      headers: { "X-Api-Key": apiKey, "X-Team-ID": teamId, Accept: "application/json" },
      ...(options.fresh ? { cache: "no-store" as const } : { next: { revalidate: 86_400 } }),
      redirect: "error", signal: AbortSignal.timeout(10_000),
    };
    response = await (options.fetch ?? fetch)(url, init);
    if (detail && response.status === 404) throw new ScrydexError("not_found", "This Scrydex sealed product is no longer available.");
    if (!response.ok) throw upstream();
    payload = await response.json();
  } catch (error) {
    if (error instanceof ScrydexError) throw error;
    throw upstream();
  }
  const result = object(payload);
  if (!Object.keys(result).length || (result.status !== undefined && result.status !== "success")) throw upstream();
  return result;
}

export async function searchSealedCatalog(input: { game: unknown; query: unknown }, options: Options = {}): Promise<{ products: SealedCatalogProduct[]; hasMore: boolean }> {
  const sourceGame = game(input?.game);
  const terms = searchTerms(input?.query, sourceGame);
  const url = new URL(`${API_BASE}/${sourceGame}/v1/sealed`);
  // A set name or package type may be separate from the provider's product
  // title. Every descriptive term still has to match; staff confirm the ID.
  const q = `(${terms.map(term => `(name:${quote(term)} OR expansion.name:${quote(term)} OR type:${quote(term)})`).join(" AND ")}) AND (language_code:EN OR expansion.language_code:EN OR language:"English" OR expansion.language:"English")`;
  url.search = new URLSearchParams({ q, include: "prices", casing: "snake", page: "1", page_size: String(PAGE_SIZE) }).toString();
  const result = await request(url, options);
  const total = result.total_count ?? result.totalCount;
  if (!Array.isArray(result.data) || result.data.length > PAGE_SIZE || typeof total !== "number" || !Number.isSafeInteger(total) || total < result.data.length) throw upstream();
  const products = result.data.map(value => product(value, sourceGame)).filter((value): value is SealedCatalogProduct => value !== null);
  if (new Set(products.map(value => value.id)).size !== products.length) throw upstream();
  const hasMore = total > result.data.length;
  console.info(JSON.stringify({ event: "scrydex.sealed.search", game: sourceGame,
    returnedCount: result.data.length, acceptedCount: products.length, filteredCount: result.data.length - products.length,
    totalCount: total, hasMore }));
  return { products, hasMore };
}

export async function getSealedCatalogProduct(input: { game: unknown; id: unknown }, options: Options = {}): Promise<SealedCatalogProduct> {
  const sourceGame = game(input?.game);
  const id = productId(input?.id);
  const url = new URL(`${API_BASE}/${sourceGame}/v1/sealed/${encodeURIComponent(id)}`);
  url.search = new URLSearchParams({ include: "prices", casing: "snake" }).toString();
  const result = await request(url, options, true);
  // Single-resource responses may wrap the documented object in `data`.
  const value = result.data === undefined ? result : result.data;
  const candidate = object(value);
  if (candidate.id === id && english(candidate) && !normalEdition(candidate)) {
    throw new ScrydexError("ambiguous", "This sealed product has multiple, unsupported, or unspecified editions. Use manual registration with the exact edition; catalog registration supports one normal edition only.");
  }
  const selected = product(value, sourceGame);
  if (!selected || selected.id !== id) throw new ScrydexError("not_found", "This exact English sealed product could not be verified in Scrydex.");
  return selected;
}
