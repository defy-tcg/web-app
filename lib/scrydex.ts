import { cardLanguageForGame, gameFromAlias } from "./tcg-games.ts";

/** Server-side only. Credentials are read on demand and never returned with prices. */
export function getScrydexConfig() {
  const apiKey = process.env.SCRYDEX_API_KEY?.trim();
  const teamId = process.env.SCRYDEX_TEAM_ID?.trim();
  if (!apiKey || !teamId) {
    throw new ScrydexError("not_configured", "Scrydex requires SCRYDEX_API_KEY and SCRYDEX_TEAM_ID.");
  }
  return { apiKey, teamId };
}

export function scrydexConfigured() {
  return Boolean(process.env.SCRYDEX_API_KEY?.trim() && process.env.SCRYDEX_TEAM_ID?.trim());
}

export type ScrydexErrorCode = "not_configured" | "unsupported" | "incomplete_identity" | "not_found" | "ambiguous" | "price_unavailable" | "upstream_error";
export class ScrydexError extends Error {
  readonly code: ScrydexErrorCode;
  constructor(code: ScrydexErrorCode, message: string) {
    super(message);
    this.name = "ScrydexError";
    this.code = code;
  }
}

export type ScrydexProduct = {
  name: string;
  game: string;
  setName: string;
  cardNumber: string;
  productType: string;
  condition: string;
  finish: string;
  tcgplayerId?: number | null;
  tcgplayerUrl?: string | null;
};

export type ScrydexPrice = {
  cents: number;
  matchedName: string;
  groupName: string;
  variation: string;
  imageUrl?: string;
  scrydexId: string;
  url: string;
};

const API_BASE = "https://api.scrydex.com";
const PAGE_SIZE = 100;
const GAME_PATHS: Record<string, string> = {
  pokemon: "pokemon", "pokemon-japanese": "pokemon", "one-piece": "onepiece", mtg: "magicthegathering",
  riftbound: "riftbound", gundam: "gundam", lorcana: "lorcana",
};
const SEALED_GAMES = new Set(["pokemon", "onepiece", "riftbound"]);
const CONDITIONS: Record<string, string> = {
  nm: "NM", "near mint": "NM", lp: "LP", "lightly played": "LP",
  mp: "MP", "moderately played": "MP", hp: "HP", "heavily played": "HP",
  dm: "DM", dmg: "DM", damaged: "DM",
};

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function identity(value: unknown) { return text(value).normalize("NFKC").replace(/\s+/g, " ").toLowerCase(); }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function finishKey(value: unknown) {
  const key = identity(value).replace(/[\s-]/g, "");
  // The QR importer uses these same plain-finish aliases; named editions stay distinct.
  return key === "nonfoil" ? "normal" : key === "holofoil" ? "foil" : key === "reverseholofoil" ? "reverseholo" : key;
}
function numberKey(value: unknown) {
  return identity(value).replace(/\s+/g, "").replace(/(^|[-/])0+(?=\d)/g, "$1");
}

function productSpec(product: ScrydexProduct) {
  const game = GAME_PATHS[gameFromAlias(product.game)?.key ?? ""];
  const language = cardLanguageForGame(product.game);
  if (!game) throw new ScrydexError("unsupported", "Scrydex pricing does not support this game.");
  const kind = identity(product.productType);
  if (kind !== "single" && kind !== "sealed") throw new ScrydexError("unsupported", "Scrydex pricing supports singles and sealed products only.");
  const sealed = kind === "sealed";
  if (language === "Japanese" && (sealed || !Number.isSafeInteger(product.tcgplayerId) || (product.tcgplayerId ?? 0) <= 0)) {
    throw new ScrydexError("unsupported", "Japanese Pokémon pricing requires a single with an exact TCGplayer product ID.");
  }
  if (sealed && !SEALED_GAMES.has(game)) throw new ScrydexError("unsupported", "Scrydex sealed pricing is supported for Pokémon, One Piece, and Riftbound only.");
  if (language === "English" && /\b(?:Japanese|Chinese|Korean|French|German|Spanish|Italian|Portuguese|Simplified|Traditional)\b|[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/i.test(`${product.name} ${product.setName}`)) {
    throw new ScrydexError("unsupported", "Scrydex automatic pricing currently requires an English product and a USD price.");
  }
  if (!text(product.name) || !text(product.setName) || (!sealed && !text(product.cardNumber))) {
    throw new ScrydexError("incomplete_identity", "Scrydex matching requires an exact name and set, plus the collector number for singles.");
  }
  const condition = sealed
    ? ["", "u", "sealed", "unopened"].includes(identity(product.condition)) ? "U" : undefined
    : CONDITIONS[identity(product.condition)];
  if (!condition) throw new ScrydexError("unsupported", "Scrydex requires a recognized raw condition; graded or unspecified single conditions are not supported.");
  const finish = finishKey(product.finish) || (sealed ? "normal" : "");
  if (!finish) throw new ScrydexError("incomplete_identity", "Scrydex matching requires the single's exact finish.");
  return { game, language, sealed, condition, finish, resource: sealed ? "sealed" : "cards" };
}

function english(candidate: ObjectValue) {
  const expansion = object(candidate.expansion);
  const codes = [candidate.language_code, expansion.language_code].map(identity).filter(Boolean);
  const names = [candidate.language, expansion.language].map(identity).filter(Boolean);
  return codes.length + names.length > 0 && codes.every((code) => code === "en") && names.every((name) => name === "english");
}

function japanese(candidate: ObjectValue) {
  const expansion = object(candidate.expansion);
  // Require explicit Japanese codes on both records, and reject contradictory names.
  return identity(candidate.language_code) === "ja" && identity(expansion.language_code) === "ja"
    && [candidate.language, expansion.language].map(identity).filter(Boolean).every(name => name === "japanese");
}

function translatedName(candidate: ObjectValue) {
  return text(object(object(candidate.translation).en).name);
}

function candidateName(candidate: ObjectValue, game: string, language: "English" | "Japanese") {
  if (language === "Japanese") return translatedName(candidate);
  // Lorcana keeps the character's subtitle in a separate documented `version` field.
  return game === "lorcana" && text(candidate.version)
    ? `${text(candidate.name)} - ${text(candidate.version)}` : text(candidate.name);
}

function marketplaceId(variant: ObjectValue, id: number) {
  return array(variant.marketplaces).map(object).some((marketplace) =>
    identity(marketplace.name) === "tcgplayer" && String(marketplace.product_id) === String(id));
}

function productNameWithoutGame(product: ScrydexProduct) {
  const name = product.name.trim();
  const game = gameFromAlias(product.game);
  const prefixes = game ? [...game.aliases, game.name].sort((a, b) => b.length - a.length) : [];
  for (const prefix of prefixes) {
    if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
      const suffix = name.slice(prefix.length);
      if (/^(?:\s|:)/.test(suffix)) return suffix.replace(/^[\s:]+/, "");
    }
  }
  return name;
}

function nameWithoutArtAnnotation(name: string) {
  return name.replace(/\s*\((?:Alternate Art|Alt Art)\)\s*$/i, "");
}

function tcgplayerNameAliases(product: ScrydexProduct, game: string) {
  const name = productNameWithoutGame(product);
  const names = new Set([name, nameWithoutArtAnnotation(name)]);
  if (game === "pokemon" && identity(product.productType) === "single") {
    for (const value of [...names]) {
      const suffix = /\s+-\s+([a-z0-9]+(?:\s*\/\s*[a-z0-9]+)?)$/i.exec(value);
      if (suffix && /\d/.test(suffix[1]) && numberKey(suffix[1]) === numberKey(product.cardNumber)) names.add(value.slice(0, suffix.index));
    }
  }
  return [...names].filter(Boolean);
}

function verifiedName(product: ScrydexProduct, candidate: ObjectValue, game: string, language: "English" | "Japanese") {
  const name = productNameWithoutGame(product);
  if (language === "English" && identity(candidateName(candidate, game, language)) === identity(name)) return true;
  // TCGplayer can append an art label or Pokémon collector number absent from Scrydex's name.
  // Only the exact marketplace ID permits removing those verified annotations.
  return tcgplayerNameAliases(product, game).some(alias => identity(alias) === identity(candidateName(candidate, game, language)))
    && Number.isSafeInteger(product.tcgplayerId) && (product.tcgplayerId ?? 0) > 0
    && array(candidate.variants).map(object).some((variant) => marketplaceId(variant, product.tcgplayerId!));
}

function exactSetName(product: ScrydexProduct, candidate: ObjectValue) {
  const expansion = object(candidate.expansion);
  return [expansion.name, expansion.code, expansion.id].some(value => identity(value) === identity(product.setName));
}

const POKEMON_SET_ALIASES: Record<string, { id: string; name: string; series: string; code: string }> = {
  "sv: scarlet & violet 151": { id: "sv3pt5", name: "151", series: "scarlet & violet", code: "mew" },
  "sv: scarlet & violet promo cards": { id: "svp", name: "scarlet & violet black star promos", series: "scarlet & violet", code: "svp" },
  "me01: mega evolution": { id: "me1", name: "mega evolution", series: "mega evolution", code: "meg" },
};

const POKEMON_SERIES_PREFIXES: Record<string, string> = {
  sv: "scarlet & violet", swsh: "sword & shield", sm: "sun & moon",
  xy: "xy", bw: "black & white", me: "mega evolution",
};

function numberedSetIdentity(value: unknown) {
  // Provider codes can pad their numbers (ME02 versus me2), but no other
  // expansion markers are discarded: split sets and special sets stay distinct.
  return identity(value).replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ""));
}

function verifiedPokemonSetLabel(product: ScrydexProduct, expansion: ObjectValue) {
  const label = /^([^:]+):\s*(.+)$/.exec(identity(product.setName));
  if (!label || !text(expansion.id) || label[2] !== identity(expansion.name)) return false;
  const prefix = label[1].trim();
  const numberedPrefix = /^([a-z]+)(\d[a-z0-9]*)$/.exec(prefix);
  const series = POKEMON_SERIES_PREFIXES[prefix]
    ?? (numberedPrefix ? POKEMON_SERIES_PREFIXES[numberedPrefix[1]] : undefined)
    ?? Object.values(POKEMON_SERIES_PREFIXES).find((value) => value === prefix);
  if (!series || identity(expansion.series) !== series) return false;
  // An unnumbered series label covers new sets without a per-set whitelist.
  // Numbered labels must additionally identify the same expansion in full.
  return !numberedPrefix || numberedSetIdentity(prefix) === numberedSetIdentity(expansion.id);
}

function verifiedSetName(product: ScrydexProduct, candidate: ObjectValue, game: string, language: "English" | "Japanese") {
  if (language === "Japanese") {
    const expansion = object(candidate.expansion);
    // This alias is verified against the Japanese category, native set, and English translation.
    return identity(product.setName) === "sv2a: pokemon card 151"
      && identity(expansion.id) === "sv2a_ja" && identity(expansion.code) === "sv2a"
      && identity(expansion.name) === "ポケモンカード151" && identity(expansion.series) === "scarlet & violet"
      && identity(translatedName(expansion)) === "pokémon card 151"
      && array(candidate.variants).map(object).some(variant => marketplaceId(variant, product.tcgplayerId!));
  }
  if (exactSetName(product, candidate)) return true;
  if (game !== "pokemon" || !Number.isSafeInteger(product.tcgplayerId) || (product.tcgplayerId ?? 0) <= 0
    || !array(candidate.variants).map(object).some(variant => marketplaceId(variant, product.tcgplayerId!))) return false;
  const expansion = object(candidate.expansion);
  const alias = POKEMON_SET_ALIASES[identity(product.setName)];
  // Exceptional provider labels retain their complete verified identity. A
  // failed known alias must not fall through to the generic series-label path.
  if (alias) return identity(expansion.id) === alias.id && identity(expansion.name) === alias.name
    && identity(expansion.series) === alias.series && identity(expansion.code) === alias.code;
  return verifiedPokemonSetLabel(product, expansion);
}

function matchesNumber(number: string, candidate: ObjectValue) {
  const wanted = numberKey(number);
  const printed = numberKey(candidate.printed_number);
  if (printed && wanted === printed) return true;
  // A supplied denominator must agree; never discard it to get a looser match.
  if (wanted.includes("/")) {
    if (printed.includes("/")) return false;
    const total = object(candidate.expansion).printed_total;
    return typeof total === "number" && Number.isInteger(total) && total > 0
      && wanted === `${numberKey(candidate.number)}/${total}`;
  }
  return wanted === numberKey(candidate.number);
}

function safeImage(images: unknown): string | undefined {
  const front = array(images).map(object).find((entry) => identity(entry.type) === "front");
  for (const value of [front?.medium, front?.large, front?.small]) {
    try {
      const url = new URL(text(value));
      if (url.protocol === "https:" && url.hostname === "images.scrydex.com" && !url.username && !url.password) return url.href;
    } catch { /* An invalid image must not invalidate a verified price. */ }
  }
}

/**
 * Pure, conservative matching against the documented snake-case Scrydex objects.
 * Marketplace IDs only disambiguate a printing; set, number, finish and condition remain mandatory.
 * Contracts: https://scrydex.com/docs/getting-started/prices and /docs/{game}/cards.
 * Sealed contracts: /docs/pokemon/sealed, /docs/onepiece/sealed, /docs/riftbound/sealed.
 */
export function selectScrydexPrice(product: ScrydexProduct, candidates: unknown[]): ScrydexPrice {
  const spec = productSpec(product);
  const matches = candidates.map(object).filter((candidate) => {
    const expansion = object(candidate.expansion);
    return text(candidate.id) && (spec.language === "Japanese" ? japanese(candidate) : english(candidate))
      && candidate.is_online_only !== true && expansion.is_online_only !== true
      && expansion.is_foreign_only !== true
      && verifiedName(product, candidate, spec.game, spec.language)
      && verifiedSetName(product, candidate, spec.game, spec.language)
      && (spec.sealed || matchesNumber(product.cardNumber, candidate));
  });
  if (!matches.length) throw new ScrydexError("not_found", `No exact ${spec.language} Scrydex match for this name, set, and collector number.`);
  if (matches.length !== 1) throw new ScrydexError("ambiguous", "Multiple Scrydex products match; confirm the exact printing before pricing.");
  const candidate = matches[0];
  const variants = array(candidate.variants).map(object).filter((variant) => {
    if (finishKey(variant.name) !== spec.finish) return false;
    if (spec.language === "Japanese" || identity(candidateName(candidate, spec.game, spec.language)) !== identity(productNameWithoutGame(product)) || !exactSetName(product, candidate)) {
      return Boolean(product.tcgplayerId && marketplaceId(variant, product.tcgplayerId));
    }
    const marketplaces = array(variant.marketplaces).map(object).filter((marketplace) => identity(marketplace.name) === "tcgplayer");
    return !product.tcgplayerId || !marketplaces.length || marketplaceId(variant, product.tcgplayerId);
  });
  if (!variants.length) throw new ScrydexError("price_unavailable", "Scrydex has no exact matching finish or edition; no price was changed.");
  if (variants.length !== 1) throw new ScrydexError("ambiguous", "Multiple Scrydex variants match this finish; no price was changed.");
  const variant = variants[0];
  const prices = array(variant.prices).map(object).filter((price) =>
    price.type === "raw" && price.condition === spec.condition && price.currency === "USD"
    && (spec.language !== "Japanese" || price.source_currency === "USD")
    && price.is_signed !== true && price.is_error !== true && price.is_perfect !== true);
  if (prices.length > 1) throw new ScrydexError("ambiguous", "Multiple Scrydex prices match this condition; no price was changed.");
  const market = prices[0]?.market;
  const cents = typeof market === "number" ? Math.round((market + Number.EPSILON) * 100) : NaN;
  if (typeof market !== "number" || !Number.isFinite(market) || market <= 0 || !Number.isSafeInteger(cents) || cents <= 0 || cents > 2_147_483_647) {
    throw new ScrydexError("price_unavailable", "Scrydex has no valid USD market price for this exact finish and condition.");
  }
  return {
    cents, matchedName: candidateName(candidate, spec.game, spec.language),
    groupName: spec.language === "Japanese" ? translatedName(object(candidate.expansion)) : text(object(candidate.expansion).name),
    variation: `${text(variant.name)} / ${spec.condition}`, scrydexId: text(candidate.id),
    imageUrl: safeImage(variant.images) ?? safeImage(candidate.images),
    url: `${API_BASE}/${spec.game}/v1/${spec.resource}/${encodeURIComponent(text(candidate.id))}`,
  };
}

function queryLiteral(value: string) {
  // Escape Lucene metacharacters inside quoted phrases; product input cannot broaden the query.
  return `"${value.trim().replace(/[+\-!(){}\[\]^"~*?:\\/|&]/g, "\\$&")}"`;
}

/** One request at most, no retries/fallback provider, a ten-second timeout, and no redirects. */
export async function resolveScrydexPrice(product: ScrydexProduct, options: { fetch?: typeof fetch } = {}): Promise<ScrydexPrice> {
  const spec = productSpec(product);
  const { apiKey, teamId } = getScrydexConfig();
  const names = [...new Set([product.name.trim(), productNameWithoutGame(product)])];
  if (spec.game === "lorcana" && names[0].includes(" - ")) names.push(names[0].split(" - ")[0]);
  const hasMarketplaceId = Number.isSafeInteger(product.tcgplayerId) && (product.tcgplayerId ?? 0) > 0;
  if (hasMarketplaceId) {
    // Some searches do not index marketplace IDs, and Scrydex omits TCGplayer annotations.
    // Candidate selection still requires the exact marketplace ID and printing metadata.
    for (const alias of tcgplayerNameAliases(product, spec.game)) if (!names.includes(alias)) names.push(alias);
  }
  // Japanese names are native script. Keep that search bounded to the exact collector
  // numerator and language; the matcher still verifies its denominator, translated name,
  // native set metadata, and the selected finish's exact marketplace ID.
  const numbers = [...new Set([product.cardNumber.split("/")[0].trim(), numberKey(product.cardNumber).split("/")[0]])];
  const namesQuery = names.map((name) => `!name:${queryLiteral(name)}`).join(" OR ");
  // Popular Pokémon names exceed a full page. Bound their name fallback to this
  // collector number; marketplace ID, set, language and finish are still verified.
  const englishPokemon = spec.game === "pokemon" && spec.resource === "cards" && spec.language === "English" && hasMarketplaceId;
  const clauses = spec.language === "Japanese"
    ? [`((${numbers.map(number => `number:${queryLiteral(number)}`).join(" OR ")}) AND language_code:JA)`]
    : englishPokemon ? [`((${namesQuery}) AND (${numbers.map(number => `number:${queryLiteral(number)}`).join(" OR ")}) AND language_code:EN)`]
      : names.map((name) => `!name:${queryLiteral(name)}`);
  if (hasMarketplaceId) {
    clauses.push(`variants.marketplaces.product_id:${queryLiteral(String(product.tcgplayerId))}`);
  }
  const q = `(${clauses.join(" OR ")})`;
  const url = new URL(`${API_BASE}/${spec.game}/v1/${spec.resource}`);
  url.search = new URLSearchParams({ q, include: "prices", casing: "snake", page: "1", page_size: String(PAGE_SIZE) }).toString();
  let response: Response;
  let payload: ObjectValue;
  try {
    const requestOptions: RequestInit & { next: { revalidate: number } } = {
      headers: { "X-Api-Key": apiKey, "X-Team-ID": teamId, Accept: "application/json" },
      next: { revalidate: 86_400 }, redirect: "error", signal: AbortSignal.timeout(10_000),
    };
    response = await (options.fetch ?? fetch)(url, requestOptions);
    if (!response.ok) throw new ScrydexError("upstream_error", `Scrydex request failed (HTTP ${response.status}); no price was changed.`);
    payload = object(await response.json());
  } catch (error) {
    if (error instanceof ScrydexError) throw error;
    // Never echo upstream bodies, request headers, or exception messages containing credentials.
    throw new ScrydexError("upstream_error", "Scrydex could not be reached or returned an invalid response; no price was changed.");
  }
  if (!Array.isArray(payload.data) || (payload.status !== undefined && payload.status !== "success")) {
    throw new ScrydexError("upstream_error", "Scrydex returned an invalid search response; no price was changed.");
  }
  const total = payload.total_count ?? payload.totalCount;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0 || total < payload.data.length || payload.data.length > PAGE_SIZE) {
    throw new ScrydexError("upstream_error", "Scrydex returned invalid pagination metadata; no price was changed.");
  }
  if (total > payload.data.length) {
    throw new ScrydexError("ambiguous", "Scrydex search exceeds one complete page; refine the product name before pricing.");
  }
  return selectScrydexPrice(product, payload.data);
}
