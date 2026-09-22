import { gameFromAlias, TCG_GAME_REGISTRY, type TcgGameName } from "./tcg-games.ts";

export type TcgplayerCardLookup = {
  productId: number;
  name: string;
  game: TcgGameName;
  setName: string;
  cardNumber: string;
  imageUrl: string;
  productUrl: string;
  finishes: string[];
  warnings: string[];
};

export class TcgplayerCardLookupError extends Error {
  status: 400 | 404 | 422 | 502 | 504;

  constructor(status: TcgplayerCardLookupError["status"], message: string) {
    super(message);
    this.name = "TcgplayerCardLookupError";
    this.status = status;
  }
}

const URL_ERROR = "Paste a full HTTPS TCGplayer card link, such as https://www.tcgplayer.com/product/517045.";
const FINISH_WARNING = "The available finishes could not be confirmed. Choose the exact finish printed on your card.";

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function productIdFromUrl(value: unknown): number {
  if (typeof value !== "string" || value.length > 2_048 || /[\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new TcgplayerCardLookupError(400, URL_ERROR);
  }
  const source = value.trim();
  // Match the original authority too: URL() removes an explicit default :443 port.
  if (!/^https:\/\/(?:www\.)?tcgplayer\.com\//i.test(source)) {
    throw new TcgplayerCardLookupError(400, URL_ERROR);
  }
  let url: URL;
  try { url = new URL(source); } catch {
    throw new TcgplayerCardLookupError(400, URL_ERROR);
  }
  const match = url.pathname.match(/^\/product\/([1-9]\d*)(?:\/[^/]+)?\/?$/);
  const rawPath = source.match(/^https:\/\/[^/]+([^?#]*)/i)?.[1];
  const productId = Number(match?.[1]);
  if (url.protocol !== "https:" || !["tcgplayer.com", "www.tcgplayer.com"].includes(url.hostname) ||
    url.username || url.password || url.port || rawPath !== url.pathname || !match || !positiveId(productId)) {
    throw new TcgplayerCardLookupError(400, URL_ERROR);
  }
  return productId;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sourceText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && Array.from(clean).length <= maximum && !/[\u0000-\u001f\u007f]/u.test(clean) ? clean : null;
}

async function fetchJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { accept: "application/json", "user-agent": "DefyTCGStoreOS/1.0 (single card lookup)" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    next: { revalidate: 86_400 },
  });
  if (!response.ok) {
    if (response.status === 404) throw new TcgplayerCardLookupError(404, "That TCGplayer product was not found. Check the card link.");
    throw new TcgplayerCardLookupError(502, "The card catalog is unavailable. Please try again shortly.");
  }
  return response.json();
}

function finishName(value: unknown): string | null {
  const name = sourceText(value, 80);
  if (!name) return null;
  switch (name.toLowerCase()) {
    case "normal": case "nonfoil": case "non-foil": case "non foil": return "Normal";
    case "foil": case "holofoil": return "Foil";
    case "reverse holo": case "reverse holofoil": return "Reverse Holo";
    default: return name;
  }
}

/** Reads catalog identity and finishes only. Prices and inventory remain unchanged. */
export async function lookupTcgplayerCard(
  url: unknown,
  options: { fetch?: typeof fetch } = {},
): Promise<TcgplayerCardLookup> {
  const productId = productIdFromUrl(url);
  const fetcher = options.fetch ?? fetch;
  let details: Record<string, unknown> | null;
  try {
    // Only trusted fixed hosts and validated integer IDs ever reach fetch.
    details = record(await fetchJson(`https://mp-search-api.tcgplayer.com/v1/product/${productId}/details`, fetcher));
  } catch (error) {
    if (error instanceof TcgplayerCardLookupError) throw error;
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
      throw new TcgplayerCardLookupError(504, "The card catalog took too long to respond. Please try again.");
    }
    throw new TcgplayerCardLookupError(502, "The card catalog could not be read. Please try again shortly.");
  }
  if (!details || details.productId !== productId) {
    throw new TcgplayerCardLookupError(502, "The catalog did not return the requested card. Check the link or try again later.");
  }
  if (details.sealed === true || (typeof details.productTypeName === "string" && !/^cards?$/i.test(details.productTypeName.trim()))) {
    throw new TcgplayerCardLookupError(422, "This link is for a sealed product or accessory. Paste a link to an individual card.");
  }
  const name = sourceText(details.productName, 240);
  const setName = sourceText(details.setName, 120);
  const categoryName = sourceText(details.productLineName, 120);
  if (details.sealed !== false || typeof details.productTypeName !== "string" ||
    !name || !setName || !categoryName || !positiveId(details.productLineId) || !positiveId(details.setId)) {
    throw new TcgplayerCardLookupError(502, "The catalog returned incomplete card details. Please try again later or enter the card manually.");
  }

  const warnings: string[] = [];
  const game = TCG_GAME_REGISTRY.find((candidate) => candidate.tcgplayerCategoryId === details.productLineId)?.name
    ?? gameFromAlias(categoryName)?.name ?? "Other";
  if (game === "Other") warnings.push(`TCGplayer lists this card under ${categoryName}. It will be saved with game Other.`);
  const attributes = record(details.customAttributes);
  const cardNumber = sourceText(attributes?.number, 40) ?? "";
  if (!cardNumber) warnings.push("The catalog did not provide a card number. Add it if printed on the card; otherwise its TCGplayer ID identifies it.");

  const finishes: string[] = [];
  try {
    // TCGCSV publishes finishes in its prices collection; never consume its price fields.
    const body = record(await fetchJson(`https://tcgcsv.com/tcgplayer/${details.productLineId}/${details.setId}/prices`, fetcher));
    if (body?.success !== true || !Array.isArray(body.results)) throw new Error("Invalid finishes");
    const seen = new Set<string>();
    for (const value of body.results) {
      const item = record(value);
      if (item?.productId !== productId) continue;
      const finish = finishName(item.subTypeName);
      if (!finish) continue;
      const key = finish.toLowerCase();
      if (!seen.has(key)) { seen.add(key); finishes.push(finish); }
    }
  } catch {
    // Card identity is still useful when the optional finish catalog is unavailable.
  }
  if (!finishes.length) warnings.push(FINISH_WARNING);

  return {
    productId, name, game, setName, cardNumber,
    imageUrl: `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_in_1000x1000.jpg`,
    productUrl: `https://www.tcgplayer.com/product/${productId}`,
    finishes, warnings,
  };
}
