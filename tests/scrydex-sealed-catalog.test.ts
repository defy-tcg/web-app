import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getSealedCatalogProduct, searchSealedCatalog, type SealedCatalogGame } from "../lib/scrydex-sealed-catalog.ts";
import { ScrydexError } from "../lib/scrydex.ts";

function config(t: TestContext) {
  const originalKey = process.env.SCRYDEX_API_KEY;
  const originalTeam = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-only-secret";
  process.env.SCRYDEX_TEAM_ID = "test-only-team";
  t.after(() => {
    if (originalKey === undefined) delete process.env.SCRYDEX_API_KEY; else process.env.SCRYDEX_API_KEY = originalKey;
    if (originalTeam === undefined) delete process.env.SCRYDEX_TEAM_ID; else process.env.SCRYDEX_TEAM_ID = originalTeam;
  });
}
const raw = (overrides: Record<string, unknown> = {}) => ({ type: "raw", condition: "U", currency: "USD", market: 7.13, ...overrides });
function candidate(overrides: Record<string, unknown> = {}) {
  // The Pokémon sealed documentation fixture has language on the expansion.
  return { id: "me1-s1", name: "Mega Evolution Booster Pack", type: "Booster Pack",
    expansion: { id: "me1", name: "Mega Evolution", language: "English", language_code: "EN", is_online_only: false },
    images: [{ type: "front", medium: "https://images.scrydex.com/pokemon/me1-s1/medium" }],
    variants: [{ name: "normal", prices: [raw()] }], ...overrides };
}
function provider(payload: unknown, status = 200) {
  const calls: { url: URL; init: RequestInit & { next?: { revalidate?: number | false } } }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    return Response.json(payload, { status });
  };
  return { calls, fetch: fetcher };
}
const searchResult = (data: unknown[], total = data.length) => ({ status: "success", data, total_count: total });
const code = (wanted: string) => (error: unknown) => error instanceof ScrydexError && error.code === wanted;

test("documented English sealed fixtures return bounded identity, package, image and raw market without internal credentials", async t => {
  config(t);
  for (const game of ["pokemon", "onepiece", "riftbound"] as SealedCatalogGame[]) {
    const item = candidate({ id: game === "pokemon" ? "me1-s1" : game === "onepiece" ? "OP01-s1" : "OGN-s1" });
    const f = provider(searchResult([item]));
    const result = await searchSealedCatalog({ game, query: "Booster pack" }, f);
    assert.deepEqual(result, { products: [{ id: item.id, game, name: item.name, setName: "Mega Evolution", language: "English",
      unit: "Booster pack", imageUrl: "https://images.scrydex.com/pokemon/me1-s1/medium", marketCents: 713 }], hasMore: false });
    assert.equal(f.calls[0].url.pathname, `/${game}/v1/sealed`);
    assert.doesNotMatch(JSON.stringify(result), /test-only|apiKey|teamId|barcode|\bsku\b/);
  }
});

test("search escapes each term across product, set and package fields and fixes English scope and request bounds", async t => {
  config(t);
  const f = provider(searchResult([]));
  await searchSealedCatalog({ game: "pokemon", query: ' Paldean Fates") OR name:* ' }, f);
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url.origin, "https://api.scrydex.com");
  assert.equal(url.searchParams.get("q"), String.raw`((name:"Paldean" OR expansion.name:"Paldean" OR type:"Paldean") AND (name:"Fates\"\)" OR expansion.name:"Fates\"\)" OR type:"Fates\"\)") AND (name:"OR" OR expansion.name:"OR" OR type:"OR") AND (name:"name\:\*" OR expansion.name:"name\:\*" OR type:"name\:\*")) AND (language_code:EN OR expansion.language_code:EN OR language:"English" OR expansion.language:"English")`);
  assert.equal(url.searchParams.get("page"), "1"); assert.equal(url.searchParams.get("page_size"), "20");
  assert.equal(url.searchParams.get("include"), "prices"); assert.equal(url.searchParams.get("casing"), "snake");
  assert.equal(init.redirect, "error"); assert.equal(init.next?.revalidate, 86_400); assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, { "X-Api-Key": "test-only-secret", "X-Team-ID": "test-only-team", Accept: "application/json" });
});

test("Pokémon retailer branding does not prevent a collection name from matching and never removes the year or package", async t => {
  config(t);
  for (const query of ["Pokemon Day 2026 Collection", "Pokémon Day 2026 Collection", "Poke\u0301mon TCG: Day 2026 Collection", "Day 2026 Collection"]) {
    const f = provider(searchResult([]));
    await searchSealedCatalog({ game: "pokemon", query }, f);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url.searchParams.get("q"), '((name:"Day" OR expansion.name:"Day" OR type:"Day") AND (name:"2026" OR expansion.name:"2026" OR type:"2026") AND (name:"Collection" OR expansion.name:"Collection" OR type:"Collection")) AND (language_code:EN OR expansion.language_code:EN OR language:"English" OR expansion.language:"English")');
  }
  const f = provider(searchResult([]));
  for (const query of ["Pokemon", "Pokémon TCG", "Pokémon TCG:"]) {
    await assert.rejects(searchSealedCatalog({ game: "pokemon", query }, f), code("incomplete_identity"));
  }
  assert.equal(f.calls.length, 0);
});

test("standalone English collection fixtures remain selectable with their USD price and an explicit missing-set label", async t => {
  config(t);
  for (const expansion of [undefined, null]) {
    const item = candidate({ id: "collection-s1", name: "Day 2026 Collection", type: "Collection Box", expansion, language: "English" });
    const result = await searchSealedCatalog({ game: "pokemon", query: "Pokemon Day 2026 Collection" }, provider(searchResult([item])));
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].setName, "No set listed");
    assert.equal(result.products[0].marketCents, 713);
    assert.deepEqual(await getSealedCatalogProduct({ game: "pokemon", id: item.id }, provider({ data: item })), result.products[0]);
  }
  for (const fields of [{}, { language: "Japanese" }, { language: "English", language_code: "JA" }]) {
    const item = candidate({ expansion: null, ...fields });
    assert.equal((await searchSealedCatalog({ game: "pokemon", query: "Day Collection" }, provider(searchResult([item])))).products.length, 0);
  }
});

test("search diagnostics distinguish an empty provider result from filtered products without recording queries or credentials", async t => {
  config(t);
  const log = t.mock.method(console, "info", () => {});
  await searchSealedCatalog({ game: "pokemon", query: "PRIVATE_QUERY" }, provider(searchResult([])));
  await searchSealedCatalog({ game: "pokemon", query: "PRIVATE_QUERY" }, provider(searchResult([candidate({ language_code: "JA" })])));
  assert.deepEqual(log.mock.calls.map(call => JSON.parse(call.arguments[0])), [
    { event: "scrydex.sealed.search", game: "pokemon", returnedCount: 0, acceptedCount: 0, filteredCount: 0, totalCount: 0, hasMore: false },
    { event: "scrydex.sealed.search", game: "pokemon", returnedCount: 1, acceptedCount: 0, filteredCount: 1, totalCount: 1, hasMore: false },
  ]);
  assert.doesNotMatch(JSON.stringify(log.mock.calls.map(call => call.arguments)), /PRIVATE_QUERY|test-only|me1-s1/);
});

test("bad games, query lengths, controls and unsafe detail IDs are rejected before any provider call", async t => {
  config(t);
  const f = provider(searchResult([]));
  for (const game of ["mtg", "Pokemon", "../pokemon", null, {}]) {
    await assert.rejects(searchSealedCatalog({ game, query: "Bundle" }, f), code("unsupported"));
  }
  for (const query of ["", "ab", " ", "a".repeat(101), "box\nset", null, 123]) {
    await assert.rejects(searchSealedCatalog({ game: "pokemon", query }, f), code("incomplete_identity"));
  }
  for (const id of ["", "../me1-s1", "me1/s1", "me1%2Fs1", "me1-s1?include=secret", "a".repeat(101), null, 123]) {
    await assert.rejects(getSealedCatalogProduct({ game: "pokemon", id }, f), code("incomplete_identity"));
  }
  assert.equal(f.calls.length, 0);
});

test("foreign, contradictory, online-only or incomplete identities cannot be selected", async t => {
  config(t);
  const bad = [
    candidate({ language_code: "JA" }), candidate({ language: "Japanese" }), candidate({ expansion: { name: "Mega Evolution" } }),
    candidate({ expansion: { name: "Mega Evolution", language_code: "EN", is_foreign_only: true } }),
    candidate({ is_online_only: true }), candidate({ expansion: { name: "Mega Evolution", language_code: "EN", is_online_only: true } }),
    candidate({ id: "bad/id" }), candidate({ name: "" }), candidate({ type: "" }), candidate({ expansion: { language_code: "EN" } }),
  ];
  const f = provider(searchResult([...bad, candidate()]));
  assert.equal((await searchSealedCatalog({ game: "pokemon", query: "Mega Evolution" }, f)).products.length, 1);
  for (const item of bad) {
    await assert.rejects(getSealedCatalogProduct({ game: "pokemon", id: "me1-s1" }, provider({ data: item })), code("not_found"));
  }
});

test("unknown package types stay explicit and recognized units retain case and packaging distinctions", async t => {
  config(t);
  for (const [type, unit] of [["Booster Pack", "Booster pack"], ["Booster Box", "Booster box"], ["Booster Bundle", "Booster bundle"],
    ["Collection Box", "Collection box"], ["Elite Trainer Box", "Elite Trainer Box"], ["Tin", "Tin"], ["Starter Deck", "Deck"],
    ["Booster Display", "Display"], ["Case", "Case"], ["Mystery Assortment", "Other sealed unit"]]) {
    const result = await getSealedCatalogProduct({ game: "pokemon", id: "me1-s1" }, provider({ data: candidate({ type }) }));
    assert.equal(result.unit, unit);
  }
});

test("case and display names override broad provider types while multipacks require staff to choose the unit", async t => {
  config(t);
  for (const [name, type, unit] of [
    ["Paldean Fates Booster Bundle Display", "Booster Bundle", "Display"],
    ["Paldean Fates Elite Trainer Box Case", "Elite Trainer Box", "Case"],
    ["Paldean Fates Mini Tin Display", "Tin", "Display"],
    ["Paldean Fates Mini Tin (Set of 5)", "Tin", "Other sealed unit"],
    ["Paldean Fates Mini Tin 5-pack", "Tin", "Other sealed unit"],
    ["Paldean Fates 5-pack Display Case", "Tin", "Case"],
    ["Showcase Tin", "Tin", "Tin"],
    ["Displayable Booster Bundle", "Booster Bundle", "Booster bundle"],
  ]) {
    const result = await getSealedCatalogProduct({ game: "pokemon", id: "me1-s1" }, provider({ data: candidate({ name, type }) }));
    assert.equal(result.unit, unit, name); assert.equal(result.name, name);
  }
});

test("catalog identity and market limits match the receiving endpoint", async t => {
  config(t);
  const id = "a".repeat(100);
  const expansion = { name: "s".repeat(300), language_code: "EN" };
  const item = candidate({ id, expansion, variants: [{ name: "normal", prices: [raw({ market: 1_000_000 })] }] });
  const result = await getSealedCatalogProduct({ game: "pokemon", id }, provider({ data: item }));
  assert.equal(result.id.length, 100); assert.equal(result.setName.length, 300); assert.equal(result.marketCents, 100_000_000);
  const tooHigh = candidate({ variants: [{ name: "normal", prices: [raw({ market: 1_000_000.01 })] }] });
  assert.equal((await getSealedCatalogProduct({ game: "pokemon", id: "me1-s1" }, provider({ data: tooHigh }))).marketCents, null);
  const bad = [candidate({ id: "a".repeat(101) }), candidate({ expansion: { ...expansion, name: "s".repeat(301) } })];
  assert.equal((await searchSealedCatalog({ game: "pokemon", query: "Mega" }, provider(searchResult(bad)))).products.length, 0);
});

test("missing, ambiguous or unsuitable market quotes are null while the catalog identity remains usable", async t => {
  config(t);
  const variants = [
    [{ name: "normal" }], [{ name: "normal", prices: [] }],
    [{ name: "normal", prices: [raw(), raw()] }],
    ...[{ market: 0 }, { market: -1 }, { market: "7.13" }, { market: 30_000_000 }, { market: null },
      { condition: "NM" }, { currency: "EUR" }, { type: "graded" }, { is_signed: true }, { is_error: true }, { is_perfect: true }]
      .map(change => [{ name: "normal", prices: [raw(change)] }]),
  ];
  for (const prices of variants) {
    const item = await getSealedCatalogProduct({ game: "pokemon", id: "me1-s1" }, provider({ data: candidate({ variants: prices }) }));
    assert.equal(item.marketCents, null); assert.equal(item.id, "me1-s1");
  }
  const valid = await getSealedCatalogProduct({ game: "riftbound", id: "me1-s1" }, provider({ data: candidate({ variants: [{ name: "normal", prices: [raw({ market: 10.015 })] }] }) }));
  assert.equal(valid.marketCents, 1002);
});

test("multi-edition, non-normal and unspecified editions cannot share a catalog receiving identity", async t => {
  config(t);
  const variants = [undefined, [], [{ name: "firstEdition", prices: [raw()] }], [{ name: "unlimited", prices: [raw()] }],
    [{ name: "firstEdition", prices: [raw()] }, { name: "unlimited", prices: [raw()] }],
    [{ name: "normal", prices: [raw()] }, { name: "firstEdition", prices: [raw()] }],
    [{ name: "normal" }, { name: "normal" }], [{}]];
  const items = variants.map((value, index) => candidate({ id: `jungle-s${index}`, variants: value }));
  const normalWithoutPrice = candidate({ id: "normal-s1", variants: [{ name: "normal" }] });
  const results = await searchSealedCatalog({ game: "pokemon", query: "Booster Box" }, provider(searchResult([...items, normalWithoutPrice])));
  assert.deepEqual(results.products.map(item => item.id), ["normal-s1"]);
  assert.equal(results.products[0].marketCents, null);
  for (const item of items) {
    await assert.rejects(getSealedCatalogProduct({ game: "pokemon", id: item.id }, provider({ data: item })), error => {
      assert.ok(error instanceof ScrydexError); assert.equal(error.code, "ambiguous");
      assert.match(error.message, /edition/); assert.match(error.message, /manual registration/); return true;
    });
  }
});

test("images allow only HTTPS Scrydex image hosts with safe fallback", async t => {
  config(t);
  for (const url of ["http://images.scrydex.com/a", "https://images.scrydex.com.evil.test/a", "https://user:password@images.scrydex.com/a", "https://images.scrydex.com:444/a", "data:image/svg+xml,<svg>"]) {
    const result = await getSealedCatalogProduct({ game: "pokemon", id: "me1-s1" }, provider({ data: candidate({ images: [{ type: "front", medium: url }] }) }));
    assert.equal(result.imageUrl, null);
  }
  const item = candidate({ variants: [{ name: "normal" }],
    images: [{ type: "front", medium: "javascript:bad", small: "https://images.scrydex.com/fallback" }] });
  assert.equal((await getSealedCatalogProduct({ game: "pokemon", id: "me1-s1" }, provider({ data: item }))).imageUrl, "https://images.scrydex.com/fallback");
});

test("bounded search reports additional provider results and rejects invalid pagination or duplicate IDs", async t => {
  config(t);
  const page = Array.from({ length: 20 }, (_, index) => candidate({ id: `me1-s${index + 1}` }));
  const result = await searchSealedCatalog({ game: "pokemon", query: "Mega" }, provider(searchResult(page, 21)));
  assert.equal(result.products.length, 20); assert.equal(result.hasMore, true);
  for (const payload of [searchResult([...page, candidate()], 21), searchResult([candidate()], 0), searchResult([], -1),
    { data: [], total_count: "0" }, { data: [] }, { data: {}, total_count: 0 }, searchResult([candidate(), candidate()])]) {
    await assert.rejects(searchSealedCatalog({ game: "pokemon", query: "Mega" }, provider(payload)), code("upstream_error"));
  }
  assert.deepEqual(await searchSealedCatalog({ game: "pokemon", query: "Mega" }, provider({ data: [], totalCount: 0 })), { products: [], hasMore: false });
});

test("exact detail refetch uses validated source game and ID, accepts documented envelopes and rejects a different ID", async t => {
  config(t);
  for (const payload of [candidate(), { status: "success", data: candidate() }]) {
    const f = provider(payload);
    assert.equal((await getSealedCatalogProduct({ game: "pokemon", id: "me1-s1" }, f)).id, "me1-s1");
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url.pathname, "/pokemon/v1/sealed/me1-s1");
    assert.equal(f.calls[0].url.searchParams.get("include"), "prices");
  }
  for (const payload of [{ data: candidate({ id: "me1-s2" }) }, { data: [candidate()] }]) {
    await assert.rejects(getSealedCatalogProduct({ game: "pokemon", id: "me1-s1" }, provider(payload)), code("not_found"));
  }
  await assert.rejects(getSealedCatalogProduct({ game: "pokemon", id: "me1-s1" }, provider({ private: "secret" }, 404)), code("not_found"));
});

test("credentials are required and provider failures are sanitized with no fallback requests", async t => {
  config(t);
  const f = provider(searchResult([])); delete process.env.SCRYDEX_API_KEY;
  await assert.rejects(searchSealedCatalog({ game: "pokemon", query: "Bundle" }, f), code("not_configured"));
  assert.equal(f.calls.length, 0); process.env.SCRYDEX_API_KEY = "test-only-secret";
  for (const fetcher of [provider({ error: "PRIVATE_SECRET" }, 500).fetch,
    provider({ status: "failure", message: "PRIVATE_SECRET" }).fetch,
    (async () => { throw new Error("PRIVATE_SECRET connection details"); }) as typeof fetch,
    (async () => new Response("PRIVATE_SECRET invalid JSON")) as typeof fetch]) {
    let count = 0;
    await assert.rejects(searchSealedCatalog({ game: "pokemon", query: "Bundle" }, { fetch: async (...args) => { count++; return fetcher(...args); } }), error => {
      assert.ok(error instanceof ScrydexError); assert.equal(error.code, "upstream_error");
      assert.doesNotMatch(error.message, /PRIVATE_SECRET|test-only/); return true;
    });
    assert.equal(count, 1);
  }
});

test("live sealed quotes bypass the Next.js cache on every request without changing catalog defaults", async t => {
  config(t);
  const calls: RequestInit[] = [];
  const freshFetch: typeof fetch = async (_url, init) => {
    calls.push(init ?? {});
    return Response.json({ data: candidate({ variants: [{ name: "normal", prices: [raw({ market: calls.length === 1 ? 7.13 : 8.24 })] }] }) });
  };
  const input = { game: "pokemon", id: "me1-s1" };
  assert.equal((await getSealedCatalogProduct(input, { fetch: freshFetch, fresh: true })).marketCents, 713);
  assert.equal((await getSealedCatalogProduct(input, { fetch: freshFetch, fresh: true })).marketCents, 824);
  assert.equal(calls.length, 2);
  for (const init of calls) {
    assert.equal(init.cache, "no-store");
    assert.equal("next" in init, false);
  }
  const cached = provider({ data: candidate() });
  await getSealedCatalogProduct(input, cached);
  assert.equal(cached.calls[0].init.next?.revalidate, 86_400);
});
