export const TCG_GAME_REGISTRY = [
  {
    key: "pokemon",
    name: "Pokémon",
    label: "Pokémon",
    code: "PKM",
    tcgplayerCategoryId: 3,
    aliases: ["pokemon", "pokémon", "pokemon tcg", "pokemon trading card game"],
    namePatterns: [
      /\bpok[eé]mon\b/i,
      /\b151 (?:booster|bundle|tin|collection)/i,
      /\b(?:elite trainer box|etb|booster bundle)\b/i,
      /\b(?:prismatic|paldean|journey together|perfect order|chaos rising|ascended heroes)\b/i,
      /\b(?:black bolt|white flare|mega evolution|mega gardevoir|mega greninja|mega kangaskhan|mega gengar)\b/i,
      /\b(?:hop'?s zacian|knockout collection|first partner illustration)\b/i,
    ],
  },
  {
    key: "one-piece",
    name: "One Piece",
    label: "One Piece",
    code: "OPC",
    tcgplayerCategoryId: 68,
    aliases: [
      "one piece",
      "onepiece",
      "one piece tcg",
      "one piece card game",
      "one piece trading card game",
    ],
    namePatterns: [/\bone[ -]?piece\b/i, /\b(?:OP|EB)-?\d{2}\b/i],
  },
  {
    key: "mtg",
    name: "MTG",
    label: "MTG",
    code: "MTG",
    tcgplayerCategoryId: 1,
    aliases: [
      "magic",
      "mtg",
      "magic the gathering",
      "magic: the gathering",
      "magic tcg",
    ],
    namePatterns: [
      /^magic\b/i,
      /\bmagic: the gathering\b/i,
      /\bmtg\b/i,
      /^the lord of the rings:.*\b(?:booster|bundle|box|deck|collector)\b/i,
    ],
  },
  {
    key: "riftbound",
    name: "Riftbound",
    label: "Riftbound",
    code: "RFB",
    tcgplayerCategoryId: 89,
    aliases: [
      "riftbound",
      "riftbound tcg",
      "riftbound league of legends trading card game",
    ],
    namePatterns: [/\briftbound\b/i],
  },
  {
    key: "gundam",
    name: "Gundam",
    label: "Gundam",
    code: "GDM",
    tcgplayerCategoryId: 86,
    aliases: [
      "gundam",
      "gundam tcg",
      "gundam card game",
      "gundam trading card game",
    ],
    namePatterns: [/\bgundam\b/i, /\bGD-?\d{2}\b/i],
  },
  {
    key: "lorcana",
    name: "Lorcana",
    label: "Lorcana",
    code: "LOR",
    tcgplayerCategoryId: 71,
    aliases: ["lorcana", "disney lorcana", "lorcana tcg"],
    namePatterns: [/\blorcana\b/i],
  },
  {
    key: "dragon-ball",
    name: "Dragon Ball",
    label: "Dragon Ball",
    code: "DBS",
    tcgplayerCategoryId: 80,
    aliases: [
      "dragon ball",
      "dragon ball z",
      "dragon ball super",
      "dragon ball super card game",
      "dragon ball fusion world",
      "dbs",
      "dbscg",
    ],
    namePatterns: [/\bdragon ball\b/i, /\bDBS(?:CG)?\b/i],
  },
  {
    key: "other",
    name: "Other",
    label: "Other",
    code: "OTH",
    tcgplayerCategoryId: null,
    aliases: ["other", "misc", "miscellaneous", "sports cards"],
    namePatterns: [/^(?:20\d{2} )?(?:topps|panini)\b/i],
  },
] as const;

export type TcgGame = (typeof TCG_GAME_REGISTRY)[number];
export type TcgGameKey = TcgGame["key"];
export type TcgGameName = TcgGame["name"];

export const TCG_GAME_OPTIONS = TCG_GAME_REGISTRY.map(({ name, label, code }) => ({
  name,
  label,
  code,
}));

function aliasKey(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GAME_BY_ALIAS = new Map<string, TcgGame>();
for (const game of TCG_GAME_REGISTRY) {
  for (const alias of [game.key, game.name, game.label, ...game.aliases]) {
    GAME_BY_ALIAS.set(aliasKey(alias), game);
  }
}

export function gameFromAlias(value: unknown): TcgGame | null {
  const key = aliasKey(value);
  return key ? GAME_BY_ALIAS.get(key) ?? null : null;
}

export function canonicalizeGame(value: unknown): TcgGameName {
  return gameFromAlias(value)?.name ?? "Other";
}

export function gameCode(value: unknown) {
  return gameFromAlias(value)?.code ?? "OTH";
}

export function tcgplayerCategoryIdForGame(value: unknown) {
  return gameFromAlias(value)?.tcgplayerCategoryId ?? null;
}

export function inferGameFromName(name: string): TcgGameName | null {
  const matches = TCG_GAME_REGISTRY.filter((game) =>
    game.namePatterns.some((pattern) => pattern.test(name)),
  );
  return matches.length === 1 ? matches[0].name : null;
}

export function isCanonicalGameName(value: unknown): value is TcgGameName {
  return TCG_GAME_REGISTRY.some((game) => game.name === value);
}