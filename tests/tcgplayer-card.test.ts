import assert from "node:assert/strict";
import test from "node:test";
import { lookupTcgplayerCard, TcgplayerCardLookupError } from "../lib/tcgplayer-card.ts";

const CARD_URL = "https://www.tcgplayer.com/product/517045/pokemon-sv-scarlet-and-violet-151-charizard-ex-199-165?Language=English";

function details(overrides: Record<string, unknown> = {}) {
  return {
    productId: 517045,
    productName: "Charizard ex - 199/165",
    productLineId: 3,
    productLineName: "Pokemon",
    productTypeName: "Cards",
    setId: 23237,
    setName: "SV: Scarlet & Violet 151",
    customAttributes: { number: "199/165" },
    sealed: false,
    foilOnly: true,
    normalOnly: false,
    marketPrice: 999,
    skus: [],
    ...overrides,
  };
}

function fixtures(product: unknown = details(), finishes: unknown = {
  success: true,
  results: [{ productId: 517045, subTypeName: "Holofoil", marketPrice: 999 }],
}) {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, options) => {
    calls.push({ url: String(input), options });
    assert.ok(calls.length <= 2, "lookup must not fan out into unrelated catalog requests");
    return Response.json(calls.length === 1 ? product : finishes);
  };
  return { calls, fetch: fetcher };
}

function statusIs(status: number) {
  return (error: unknown) => error instanceof TcgplayerCardLookupError && error.status === status;
}

test("TCGplayer links return exact card identity through fixed-host requests without source prices", async () => {
  const mock = fixtures();
  const card = await lookupTcgplayerCard(`  ${CARD_URL}  `, mock);
  assert.deepEqual(card, {
    productId: 517045,
    name: "Charizard ex - 199/165",
    game: "Pokémon",
    setName: "SV: Scarlet & Violet 151",
    cardNumber: "199/165",
    imageUrl: "https://tcgplayer-cdn.tcgplayer.com/product/517045_in_1000x1000.jpg",
    productUrl: "https://www.tcgplayer.com/product/517045",
    finishes: ["Foil"],
    warnings: [],
  });
  assert.deepEqual(mock.calls.map((call) => call.url), [
    "https://mp-search-api.tcgplayer.com/v1/product/517045/details",
    "https://tcgcsv.com/tcgplayer/3/23237/prices",
  ]);
  for (const call of mock.calls) {
    assert.equal(call.options?.redirect, "error");
    assert.ok(call.options?.signal instanceof AbortSignal);
    assert.equal(call.options.signal.aborted, false);
  }
  assert.equal("marketPrice" in card, false);
});

test("bare TCGplayer product URLs and copied query/fragment links are accepted", async () => {
  for (const url of [
    "https://tcgplayer.com/product/517045",
    "https://www.tcgplayer.com/product/517045/",
    "https://www.tcgplayer.com/product/517045/charizard/?Condition=Near+Mint#listing",
    "HTTPS://WWW.TCGPLAYER.COM/product/517045",
  ]) {
    assert.equal((await lookupTcgplayerCard(url, fixtures())).productId, 517045, url);
  }
});

test("invalid and hostile links are rejected before making any network request", async () => {
  const fetcher: typeof fetch = async () => assert.fail("invalid links must not reach fetch");
  for (const url of [
    null, undefined, 517045, {}, [CARD_URL], "", "517045", "www.tcgplayer.com/product/517045",
    "http://www.tcgplayer.com/product/517045", "//www.tcgplayer.com/product/517045",
    "https://www.tcgplayer.com.evil.example/product/517045", "https://evil.example/product/517045",
    "https://evil.example@www.tcgplayer.com/product/517045", "https://www.tcgplayer.com@evil.example/product/517045",
    "https://user:password@www.tcgplayer.com/product/517045", "https://www.tcgplayer.com:443/product/517045",
    "https://www.tcgplayer.com:8443/product/517045", "https://store.tcgplayer.com/product/517045",
    "https://www.tcgplayer.com/search/pokemon/product/517045", "https://www.tcgplayer.com/product/0",
    "https://www.tcgplayer.com/product/-1", "https://www.tcgplayer.com/product/1.5",
    "https://www.tcgplayer.com/product/0517045", "https://www.tcgplayer.com/product/2147483648",
    "https://www.tcgplayer.com/product/9007199254740993", "https://www.tcgplayer.com/product/517045evil",
    "https://www.tcgplayer.com/product/517045/slug/extra", "https://www.tcgplayer.com/product/517045/..",
    "https://www.tcgplayer.com/product/517045/%2e%2e", "https://www.tcgplayer.com/foo/../product/517045",
    "https://www.tcgplayer.com\\@evil.example/product/517045", "https://www.tcgplayer.com/pro\nduct/517045",
    `https://www.tcgplayer.com/product/517045/${"x".repeat(2_048)}`,
  ]) {
    await assert.rejects(lookupTcgplayerCard(url, { fetch: fetcher }), statusIs(400), String(url));
  }
});

test("lookups reject wrong product IDs and incomplete identities instead of guessing from a URL slug", async () => {
  for (const product of [
    null, [], {}, details({ productId: 123 }), details({ productId: "517045" }),
    details({ productName: "" }), details({ productName: "x".repeat(241) }), details({ productName: "Bad\u0000card" }),
    details({ setName: "" }), details({ setName: null }), details({ sealed: undefined }),
    details({ productTypeName: undefined }), details({ productLineId: "3" }), details({ productLineId: -1 }),
    details({ productLineName: "" }), details({ setId: "../../private" }), details({ setId: 0 }),
  ]) {
    const mock = fixtures(product);
    await assert.rejects(lookupTcgplayerCard(CARD_URL, mock), statusIs(502));
    assert.equal(mock.calls.length, 1, "invalid identity must not request a finishes feed");
  }
});

test("sealed products, decks and accessories cannot become singles", async () => {
  for (const product of [
    details({ sealed: true }),
    details({ productTypeName: "Sealed Products" }),
    details({ productTypeName: "Decks" }),
    details({ productTypeName: "Supplies" }),
  ]) {
    const mock = fixtures(product);
    await assert.rejects(lookupTcgplayerCard(CARD_URL, mock), statusIs(422));
    assert.equal(mock.calls.length, 1);
  }
});

test("game mappings prefer registry category IDs, then exact aliases, and preserve unsupported category context", async () => {
  for (const [categoryId, categoryName, expected] of [
    [3, "Pokemon", "Pokémon"],
    [1, "Magic: The Gathering", "MTG"],
    [68, "One Piece Card Game", "One Piece"],
    [89, "Riftbound League of Legends Trading Card Game", "Riftbound"],
    [86, "Gundam Card Game", "Gundam"],
    [71, "Disney Lorcana", "Lorcana"],
    [80, "Dragon Ball Super Fusion World", "Dragon Ball"],
    [27, "Dragon Ball Super Card Game", "Dragon Ball"],
    [1, "Unsupported renamed category", "MTG"],
    [2, "YuGiOh", "Other"],
  ] as const) {
    const mock = fixtures(details({ productLineId: categoryId, productLineName: categoryName }));
    const card = await lookupTcgplayerCard(CARD_URL, mock);
    assert.equal(card.game, expected);
    assert.equal(mock.calls[1].url, `https://tcgcsv.com/tcgplayer/${categoryId}/23237/prices`);
    if (expected === "Other") assert.match(card.warnings.join(" "), /YuGiOh.*Other/);
    else assert.deepEqual(card.warnings, []);
  }
});

test("finish choices are scoped to the exact ID, deduplicated by alias, and retain specialized treatments", async () => {
  const mock = fixtures(details(), { success: true, results: [
    { productId: 517046, subTypeName: "Wrong Card Finish" },
    { productId: "517045", subTypeName: "Wrong ID Type" },
    ...["Normal", "Nonfoil", "Non-Foil", "Holofoil", "Foil", "Reverse Holofoil", "Reverse Holo", "Cold Foil", "cold foil", "1st Edition Holofoil", "Unlimited Holofoil", "Etched"].map((subTypeName) => ({ productId: 517045, subTypeName })),
    { productId: 517045, subTypeName: null },
  ] });
  const card = await lookupTcgplayerCard(CARD_URL, mock);
  assert.deepEqual(card.finishes, ["Normal", "Foil", "Reverse Holo", "Cold Foil", "1st Edition Holofoil", "Unlimited Holofoil", "Etched"]);
});

test("missing finishes and card number stay unselected for manual review without guessing foil flags", async () => {
  for (const finishes of [null, {}, { success: false, results: [] }, { success: true, results: [] }, {
    success: true, results: [{ productId: 517045, subTypeName: "Bad\u0000finish" }],
  }]) {
    const card = await lookupTcgplayerCard(CARD_URL, fixtures(details({ customAttributes: {} }), finishes));
    assert.equal(card.cardNumber, "");
    assert.deepEqual(card.finishes, []);
    assert.match(card.warnings.join(" "), /card number/);
    assert.match(card.warnings.join(" "), /finishes could not be confirmed/);
  }
});

test("catalog HTTP, network, timeout and JSON failures return safe actionable errors", async () => {
  const upstreamFailures: Array<[typeof fetch, number]> = [
    [async () => new Response("private upstream error", { status: 404 }), 404],
    [async () => new Response("private upstream error", { status: 429 }), 502],
    [async () => new Response("private upstream error", { status: 503 }), 502],
    [async () => new Response("not json", { status: 200 }), 502],
    [async () => { throw new Error("private upstream error"); }, 502],
    [async () => { throw new DOMException("private upstream error", "TimeoutError"); }, 504],
    [async () => { throw new DOMException("private upstream error", "AbortError"); }, 504],
  ];
  for (const [fetcher, status] of upstreamFailures) {
    await assert.rejects(lookupTcgplayerCard(CARD_URL, { fetch: fetcher }), (error: unknown) => {
      assert.ok(error instanceof TcgplayerCardLookupError);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /private upstream|not json/);
      return true;
    });
  }
});

test("an unavailable optional finish feed keeps verified card identity and asks for a manual finish", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    if (++requests === 1) return Response.json(details());
    throw new DOMException("catalog timed out", "TimeoutError");
  };
  const card = await lookupTcgplayerCard(CARD_URL, { fetch: fetcher });
  assert.equal(card.name, "Charizard ex - 199/165");
  assert.deepEqual(card.finishes, []);
  assert.match(card.warnings.join(" "), /Choose the exact finish/);
});
