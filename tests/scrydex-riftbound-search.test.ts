import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const product: ScrydexProduct = {
  name: "Seal of Discord", game: "Riftbound", setName: "Origins", cardNumber: "204/298",
  productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 652996,
};
function candidate() {
  // Sanitized identity and NM quote from the live OGN-204 response. Scrydex
  // capitalizes "Of", unlike TCGplayer's saved name.
  return {
    id: "OGN-204", name: "Seal Of Discord", number: "204", printed_number: "204/298",
    language: "English", language_code: "EN", rarity: "Epic",
    expansion: { id: "OGN", name: "Origins", code: "OGN", printed_total: 298, language: "English", language_code: "EN" },
    variants: [{ name: "foil", marketplaces: [{ name: "tcgplayer", product_id: "652996" }],
      prices: [{ type: "raw", condition: "NM", market: 28.73, currency: "USD", source_currency: "USD" }] }],
  };
}
function errorCode(code: ScrydexErrorCode) {
  return (error: unknown) => error instanceof ScrydexError && error.code === code;
}
function config(t: TestContext) {
  const key = process.env.SCRYDEX_API_KEY, team = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-only-riftbound-key";
  process.env.SCRYDEX_TEAM_ID = "test-only-riftbound-team";
  t.after(() => {
    if (key === undefined) delete process.env.SCRYDEX_API_KEY;
    else process.env.SCRYDEX_API_KEY = key;
    if (team === undefined) delete process.env.SCRYDEX_TEAM_ID;
    else process.env.SCRYDEX_TEAM_ID = team;
  });
}

test("Seal of Discord retrieves its differently capitalized provider name in one bounded request", async t => {
  config(t);
  let calls = 0;
  const result = await resolveScrydexPrice(product, { fetch: async (input, options) => {
    calls++;
    const url = new URL(String(input)), query = url.searchParams.get("q")!;
    assert.equal(url.origin, "https://api.scrydex.com");
    assert.equal(url.pathname, "/riftbound/v1/cards");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.equal(url.searchParams.get("include"), "prices");
    assert.equal(url.searchParams.get("casing"), "snake");
    assert.ok(query.includes('name:"Seal of Discord"'));
    assert.equal(query.includes("!name:"), false);
    assert.ok(query.includes('AND (number:"204") AND language_code:EN'));
    assert.ok(query.includes(') OR variants.marketplaces.product_id:"652996"'));
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(url.href.includes("test-only"), false);
    return Response.json({ data: [candidate()], total_count: 1 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.cents, 2873);
  assert.equal(result.scrydexId, "OGN-204");
  assert.equal(result.matchedName, "Seal Of Discord");
  assert.equal(result.groupName, "Origins");
  assert.equal(result.variation, "foil / NM");
});

test("Riftbound search preserves padded collector alternatives and verified art aliases", async t => {
  config(t);
  let calls = 0;
  const result = await resolveScrydexPrice({ ...product, name: "Seal of Discord (Alternate Art)", cardNumber: "0204/0298" }, { fetch: async input => {
    calls++;
    const query = new URL(String(input)).searchParams.get("q")!;
    assert.ok(query.includes('name:"Seal of Discord \\(Alternate Art\\)"'));
    assert.ok(query.includes('OR name:"Seal of Discord"'));
    assert.ok(query.includes('number:"0204" OR number:"204"'));
    assert.ok(query.includes("AND language_code:EN"));
    assert.equal(query.includes("!name:"), false);
    return Response.json({ data: [candidate()], total_count: 1 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.cents, 2873);
});

test("phrase retrieval cannot substitute a different Riftbound name, set, collector, or language", () => {
  const entry = candidate();
  for (const patch of [
    { name: "Seal Of Discord (Overnumbered)" }, { name: "Seal" }, { name: "Seal Of Discord!" },
    { number: "205", printed_number: "205/298" }, { printed_number: "204/221" },
    { printed_number: "204a/298" }, { language_code: "JA" }, { language: "Japanese" },
    { expansion: { ...entry.expansion, id: "SFD", name: "Spiritforged", code: "SFD", printed_total: 221 } },
    { expansion: { ...entry.expansion, language_code: "JA" } },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, ...patch }]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...product, cardNumber: "204/221" }, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(product, [entry, entry]), errorCode("ambiguous"));
});

test("Riftbound search still requires the selected printing, finish, condition, and positive USD market", () => {
  const entry = candidate(), foil = entry.variants[0];
  const wrongPrinting = { ...entry, variants: [
    { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "664931" }] },
    { ...foil, name: "normal" },
  ] };
  assert.throws(() => selectScrydexPrice(product, [wrongPrinting]), errorCode("price_unavailable"));
  for (const patch of [{ tcgplayerId: 664931 }, { finish: "Normal" }, { condition: "Lightly Played" }]) {
    assert.throws(() => selectScrydexPrice({ ...product, ...patch }, [entry]), errorCode("price_unavailable"));
  }
  for (const patch of [{ market: 0 }, { market: -1 }, { currency: "JPY" }, { type: "graded" }]) {
    const variants = [{ ...foil, prices: [{ ...foil.prices[0], ...patch }] }];
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants }]), errorCode("price_unavailable"));
  }
});

test("Riftbound phrase search remains scoped to catalog-linked singles", async t => {
  config(t);
  const cases: Array<{ saved: ScrydexProduct; bounded: boolean; id: boolean; path: string }> = [
    { saved: { ...product, tcgplayerId: undefined }, bounded: false, id: false, path: "/riftbound/v1/cards" },
    { saved: { ...product, tcgplayerId: 0 }, bounded: false, id: false, path: "/riftbound/v1/cards" },
    { saved: { ...product, tcgplayerId: -1 }, bounded: false, id: false, path: "/riftbound/v1/cards" },
    { saved: { ...product, game: "Pokémon" }, bounded: true, id: true, path: "/pokemon/v1/cards" },
    { saved: { ...product, game: "Gundam" }, bounded: false, id: true, path: "/gundam/v1/cards" },
    { saved: { ...product, productType: "Sealed", condition: "Sealed", cardNumber: "" }, bounded: false, id: true, path: "/riftbound/v1/sealed" },
  ];
  for (const { saved, bounded, id, path } of cases) {
    let calls = 0;
    await assert.rejects(resolveScrydexPrice(saved, { fetch: async input => {
      calls++;
      const url = new URL(String(input)), query = url.searchParams.get("q")!;
      assert.equal(url.pathname, path);
      assert.ok(query.includes('!name:"Seal of Discord"'));
      assert.equal(query.includes("AND language_code:EN"), bounded);
      assert.equal(query.includes("variants.marketplaces.product_id:"), id);
      return Response.json({ data: [], total_count: 0 });
    } }), errorCode("not_found"));
    assert.equal(calls, 1);
  }
});

test("Riftbound phrase values stay escaped inside their bounded query", async t => {
  config(t);
  let calls = 0;
  await assert.rejects(resolveScrydexPrice({ ...product, name: 'Seal " OR *:*', cardNumber: '204") OR *:*' }, { fetch: async input => {
    calls++;
    const query = new URL(String(input)).searchParams.get("q")!;
    assert.ok(query.includes(String.raw`name:"Seal \" OR \*\:\*"`));
    assert.ok(query.includes(String.raw`number:"204\"\) OR \*\:\*"`));
    assert.equal(query.includes("*:*"), false);
    assert.ok(query.includes("AND language_code:EN"));
    assert.ok(query.includes(') OR variants.marketplaces.product_id:"652996"'));
    return Response.json({ data: [], total_count: 0 });
  } }), errorCode("not_found"));
  assert.equal(calls, 1);
});

test("incomplete or failed Riftbound searches stop without retries or credential disclosure", async t => {
  config(t);
  for (const mode of ["incomplete", "network", "http"] as const) {
    let calls = 0;
    await assert.rejects(resolveScrydexPrice(product, { fetch: async () => {
      calls++;
      if (mode === "incomplete") return Response.json({ data: [candidate()], total_count: 2 });
      if (mode === "http") return new Response("test-only-riftbound-key test-only-riftbound-team", { status: 500 });
      throw new Error("test-only-riftbound-key test-only-riftbound-team");
    } }), error => {
      assert.ok(error instanceof ScrydexError);
      assert.equal(error.code, mode === "incomplete" ? "ambiguous" : "upstream_error");
      assert.equal(error.message.includes("test-only"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("hyphenated Riftbound names also retrieve by exact set and number in the same request", async t => {
  config(t);let calls=0;
  const saved={...product,name:"Thousand-Tailed Watcher",cardNumber:"116/298",tcgplayerId:652898};
  const entry={...candidate(),id:"OGN-116",name:"Thousand-tailed Watcher",number:"116",printed_number:"116/298",
    variants:[{name:"foil",marketplaces:[{name:"tcgplayer",product_id:"652898"}],prices:[{type:"raw",condition:"NM",currency:"USD",market:20.13}]}]};
  const result=await resolveScrydexPrice(saved,{fetch:async input=>{
    calls++;const query=new URL(String(input)).searchParams.get("q")!;
    assert.ok(query.includes('(number:"116") AND (expansion.name:"Origins" OR expansion.code:"Origins" OR expansion.id:"Origins") AND language_code:EN'));
    return Response.json({data:[entry],total_count:1});
  }});
  assert.equal(calls,1);assert.equal(result.cents,2013);
  assert.throws(()=>selectScrydexPrice({...saved,name:"Different Watcher"},[entry]),errorCode("not_found"));
  assert.throws(()=>selectScrydexPrice({...saved,cardNumber:"116/221"},[entry]),errorCode("not_found"));
});
