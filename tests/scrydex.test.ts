import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getScrydexConfig, resolveScrydexPrice, ScrydexError, scrydexConfigured, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const product: ScrydexProduct = {
  name: "Void Gate", game: "Riftbound", setName: "Origins", cardNumber: "296/298",
  productType: "Single", condition: "Near Mint", finish: "Normal",
};
function price(overrides: Record<string, unknown> = {}) {
  return { type: "raw", currency: "USD", condition: "NM", market: 0.29, ...overrides };
}
function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "OGN-296", name: "Void Gate", number: "296", printed_number: "296/298",
    language_code: "EN", language: "English",
    expansion: { id: "OGN", name: "Origins", code: "OGN", printed_total: 298 },
    images: [{ type: "front", medium: "https://images.scrydex.com/riftbound/OGN-296/medium" }],
    variants: [{ name: "normal", prices: [price()] }, { name: "foil", prices: [price({ market: 2.55 })] }],
    ...overrides,
  };
}
function errorCode(code: ScrydexErrorCode) {
  return (error: unknown) => error instanceof ScrydexError && error.code === code;
}
function config(t: TestContext, apiKey = "test-only-key", teamId = "test-only-team") {
  const originalKey = process.env.SCRYDEX_API_KEY;
  const originalTeam = process.env.SCRYDEX_TEAM_ID;
  t.after(() => {
    if (originalKey === undefined) delete process.env.SCRYDEX_API_KEY;
    else process.env.SCRYDEX_API_KEY = originalKey;
    if (originalTeam === undefined) delete process.env.SCRYDEX_TEAM_ID;
    else process.env.SCRYDEX_TEAM_ID = originalTeam;
  });
  process.env.SCRYDEX_API_KEY = apiKey;
  process.env.SCRYDEX_TEAM_ID = teamId;
}

test("exact English printing, finish and condition produce raw market cents without a store markup", () => {
  const result = selectScrydexPrice(product, [candidate()]);
  assert.equal(result.cents, 29);
  assert.equal(result.variation, "normal / NM");
  assert.equal(result.scrydexId, "OGN-296");
  assert.equal(result.url, "https://api.scrydex.com/riftbound/v1/cards/OGN-296");
  assert.equal(result.imageUrl, "https://images.scrydex.com/riftbound/OGN-296/medium");
  assert.equal(selectScrydexPrice({ ...product, finish: "Foil" }, [candidate()]).cents, 255);
  assert.equal(selectScrydexPrice({ ...product, setName: "OGN", condition: "NM", finish: "Non-foil" }, [candidate()]).cents, 29);
});

test("collector-number formatting tolerates leading zeroes without discarding denominator or suffix", () => {
  assert.equal(selectScrydexPrice({ ...product, cardNumber: "0296/0298" }, [candidate()]).cents, 29);
  assert.equal(selectScrydexPrice({ ...product, cardNumber: "296" }, [candidate()]).cents, 29);
  assert.equal(selectScrydexPrice(product, [candidate({ printed_number: undefined })]).cents, 29);
  for (const cardNumber of ["296/300", "296a", "297", "296/298a"]) {
    assert.throws(() => selectScrydexPrice({ ...product, cardNumber }, [candidate()]), errorCode("not_found"));
  }
});

test("a known game-name prefix may differ between store and provider without weakening product identity", () => {
  assert.equal(selectScrydexPrice({ ...product, name: "Riftbound: Void Gate" }, [candidate()]).cents, 29);
  assert.throws(() => selectScrydexPrice({ ...product, name: "Riftbound: Void Gate (Promo)" }, [candidate()]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...product, name: "Pokémon: Void Gate" }, [candidate()]), errorCode("not_found"));
});

test("mismatched metadata, non-English or online-only cards cannot supply a price", () => {
  const mismatches = [
    { name: "Void Gate (Alternate Art)" }, { name: "Void Gate!" }, { number: "295", printed_number: "295/298" },
    { expansion: { name: "Spiritforged", id: "SFD" } }, { language: "Japanese", language_code: "JA" },
    { language: "English", language_code: "JA" }, { language: undefined, language_code: undefined },
    { is_online_only: true }, { expansion: { name: "Origins", is_online_only: true } },
  ];
  for (const mismatch of mismatches) {
    assert.throws(() => selectScrydexPrice(product, [candidate(mismatch)]), errorCode("not_found"));
  }
  assert.throws(() => selectScrydexPrice({ ...product, name: "Void Gate (Japanese)" }, []), errorCode("unsupported"));
});

test("unknown or missing identity is rejected instead of using default single conditions and finishes", () => {
  for (const override of [{ name: "" }, { setName: "" }, { cardNumber: "" }, { finish: "" }]) {
    assert.throws(() => selectScrydexPrice({ ...product, ...override }, [candidate()]), errorCode("incomplete_identity"));
  }
  for (const condition of ["", "Mint", "PSA 10", "CGC 9.5", "Unknown"]) {
    assert.throws(() => selectScrydexPrice({ ...product, condition }, [candidate()]), errorCode("unsupported"));
  }
  assert.throws(() => selectScrydexPrice({ ...product, finish: "Unknown" }, [candidate()]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...product, game: "Dragon Ball" }, []), errorCode("unsupported"));
  assert.throws(() => selectScrydexPrice({ ...product, productType: "Slab" }, []), errorCode("unsupported"));
});

test("price matching rejects currency, condition, grade, missing and invalid market values", () => {
  for (const changes of [
    { currency: "JPY" }, { currency: undefined }, { condition: "LP" }, { condition: undefined },
    { type: "graded", grade: "10" }, { type: undefined }, { is_signed: true }, { is_error: true },
    { market: null, low: 2 }, { market: "2.50" }, { market: 0 }, { market: -1 },
    { market: NaN }, { market: Infinity }, { market: 0.001 }, { market: 21_474_836.48 },
  ]) {
    assert.throws(() => selectScrydexPrice(product, [candidate({ variants: [{ name: "normal", prices: [price(changes)] }] })]), errorCode("price_unavailable"));
  }
  const damaged = candidate({ variants: [{ name: "normal", prices: [price({ condition: "DM", market: 1.25 })] }] });
  assert.equal(selectScrydexPrice({ ...product, condition: "Damaged" }, [damaged]).cents, 125);
  assert.throws(() => selectScrydexPrice(product, [damaged]), errorCode("price_unavailable"));
});

test("duplicate printings, variants and prices are rejected even when only one has usable pricing", () => {
  assert.throws(() => selectScrydexPrice(product, [candidate(), candidate({ id: "other", variants: [] })]), errorCode("ambiguous"));
  assert.throws(() => selectScrydexPrice(product, [candidate({ variants: [{ name: "normal", prices: [price()] }, { name: "Normal", prices: [] }] })]), errorCode("ambiguous"));
  assert.throws(() => selectScrydexPrice(product, [candidate({ variants: [{ name: "normal", prices: [price(), price({ market: 5 })] }] })]), errorCode("ambiguous"));
});

test("editions and art variants are never inferred from a generic foil finish", () => {
  for (const name of ["unlimitedHolofoil", "firstEditionShadowlessHolofoil", "altArt", "mangaAltArt", "coldFoil"]) {
    const entry = candidate({ variants: [{ name, prices: [price()] }] });
    assert.throws(() => selectScrydexPrice({ ...product, finish: "Foil" }, [entry]), errorCode("price_unavailable"));
    assert.equal(selectScrydexPrice({ ...product, finish: name }, [entry]).cents, 29);
  }
});

test("TCGplayer marketplace ID can confirm an explicit art annotation but cannot override finish or metadata", () => {
  const withId = { ...product, name: "Void Gate (Alternate Art)", tcgplayerId: 123 };
  const entry = candidate({ variants: [{ name: "normal", marketplaces: [{ name: "tcgplayer", product_id: "123" }], prices: [price()] }] });
  assert.equal(selectScrydexPrice(withId, [entry]).cents, 29);
  assert.throws(() => selectScrydexPrice({ ...withId, tcgplayerId: 456 }, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...withId, finish: "Foil" }, [entry]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...withId, setName: "Different" }, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...withId, name: "A different card" }, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...product, tcgplayerId: 456 }, [entry]), errorCode("price_unavailable"));
});

test("sealed supports only documented games, exact names and sets, unopened condition and explicit editions", () => {
  const sealed = { ...product, name: "Origins Booster Pack", productType: "Sealed", cardNumber: "", condition: "", finish: "" };
  const entry = candidate({ name: sealed.name, variants: [{ name: "normal", prices: [price({ condition: "U", market: 13.32 })] }] });
  for (const game of ["Pokémon", "One Piece", "Riftbound"]) {
    assert.equal(selectScrydexPrice({ ...sealed, game }, [entry]).cents, 1332);
  }
  for (const game of ["MTG", "Lorcana", "Gundam"]) {
    assert.throws(() => selectScrydexPrice({ ...sealed, game }, [entry]), errorCode("unsupported"));
  }
  assert.throws(() => selectScrydexPrice({ ...sealed, condition: "Damaged" }, [entry]), errorCode("unsupported"));
  assert.throws(() => selectScrydexPrice(sealed, [candidate({ name: sealed.name })]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...sealed, name: "Origins Booster Box" }, [entry]), errorCode("not_found"));
});

test("Lorcana requires the documented character version in the full name", () => {
  const entry = candidate({ name: "Minnie Mouse", version: "Daring Defender" });
  assert.equal(selectScrydexPrice({ ...product, game: "Lorcana", name: "Minnie Mouse - Daring Defender" }, [entry]).cents, 29);
  assert.throws(() => selectScrydexPrice({ ...product, game: "Lorcana", name: "Minnie Mouse" }, [entry]), errorCode("not_found"));
});

test("missing and unsafe image URLs do not escape the verified Scrydex image host", () => {
  for (const medium of ["javascript:alert(1)", "https://other.example/card", "https://secret@images.scrydex.com/card", "bad"]) {
    assert.equal(selectScrydexPrice(product, [candidate({ images: [{ type: "front", medium }] })]).imageUrl, undefined);
  }
});

test("configuration is read at call time, and missing configuration never makes an API request", async (t) => {
  config(t, "", "");
  assert.equal(scrydexConfigured(), false);
  assert.throws(getScrydexConfig, errorCode("not_configured"));
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("must not fetch"); };
  await assert.rejects(resolveScrydexPrice(product, { fetch: fetcher }), errorCode("not_configured"));
  assert.equal(calls, 0);
  process.env.SCRYDEX_API_KEY = "test-only-key";
  assert.equal(scrydexConfigured(), false);
  process.env.SCRYDEX_TEAM_ID = "test-only-team";
  assert.deepEqual(getScrydexConfig(), { apiKey: "test-only-key", teamId: "test-only-team" });
});

test("request authenticates only in headers, includes prices, uses daily cache, and never follows redirects", async (t) => {
  config(t);
  let calls = 0;
  const fetcher: typeof fetch = async (input, options) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.scrydex.com");
    assert.equal(url.pathname, "/riftbound/v1/cards");
    assert.equal(url.searchParams.get("include"), "prices");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.equal(url.href.includes("test-only"), false);
    assert.equal(new Headers(options?.headers).get("X-Team-ID"), "test-only-team");
    assert.equal(new Headers(options?.headers).get("X-Api-Key"), "test-only-key");
    assert.equal(options?.redirect, "error");
    assert.equal((options as RequestInit & { next: { revalidate: number } }).next.revalidate, 86_400);
    assert.ok(options?.signal);
    return Response.json({ data: [candidate()], page: 1, page_size: 100, total_count: 1 });
  };
  assert.equal((await resolveScrydexPrice(product, { fetch: fetcher })).cents, 29);
  assert.equal(calls, 1);
});

test("malformed, truncated and duplicate search results fail without a second request", async (t) => {
  config(t);
  for (const payload of [
    { data: [candidate()], total_count: 101 }, { data: [candidate()], totalCount: 2 },
    { data: [candidate()] }, { data: [candidate()], total_count: 0 }, { data: {}, total_count: 0 },
    { data: [candidate()], total_count: 1, status: "error" }, { data: [candidate(), candidate()], total_count: 2 },
  ]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json(payload); };
    await assert.rejects(resolveScrydexPrice(product, { fetch: fetcher }), ScrydexError);
    assert.equal(calls, 1);
  }
});

test("upstream errors and bodies never leak request credentials or retry", async (t) => {
  config(t);
  for (const mode of ["throw", "http", "json"]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (mode === "throw") throw new Error("test-only-key test-only-team");
      return new Response("test-only-key test-only-team", { status: mode === "http" ? 401 : 200 });
    };
    await assert.rejects(resolveScrydexPrice(product, { fetch: fetcher }), (error: unknown) => {
      assert.ok(error instanceof ScrydexError);
      assert.equal(error.code, "upstream_error");
      assert.equal(error.message.includes("test-only"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});
