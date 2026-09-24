import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { BUYLIST_CARDS, buildBuylistSnapshot, buylistOffers, currentBuylist } from "../lib/buylist.ts";
import type { ScrydexProduct } from "../lib/scrydex.ts";

const now = Date.parse("2026-09-23T20:00:00Z");
const price = (cents: number) => ({ cents, matchedName: "Verified card", groupName: "Origins", variation: "foil / NM", scrydexId: "OGN-001", url: "https://api.scrydex.com/riftbound/v1/cards/OGN-001" });
test("buylist pays from raw market in cents, without the retail markup", () => {
  assert.deepEqual(buylistOffers(10000), {cashCents:7000,creditCents:8000});
  assert.deepEqual(buylistOffers(2873), {cashCents:2011,creditCents:2298});
  assert.deepEqual(buylistOffers(105), {cashCents:74,creditCents:84});
  for (const value of [0,-1,1.5,NaN,Infinity,100_000_001]) assert.throws(()=>buylistOffers(value));
});
test("fixed approved buylist requests only standard English Near Mint cards with bounded concurrency", async () => {
  let active=0,max=0;const requests: ScrydexProduct[]=[];
  const result=await buildBuylistSnapshot(async product=>{requests.push(product);active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return price(10000);},()=>now);
  assert.equal(requests.length,9);assert.equal(max,3);
  for(const product of requests){assert.equal(product.game,"Riftbound");assert.equal(product.condition,"Near Mint");assert.equal(product.productType,"Single");assert(product.tcgplayerId);}
  assert.equal(result.cards.find(c=>c.name==="Defy")?.finish,"Normal");
  assert.equal(result.cards.find(c=>c.name==="Kai'Sa, Survivor")?.tcgplayerId,652812);
  assert.equal(result.cards.some(c=>["Stacked Deck","Hidden Blade"].includes(c.name)),false);
  assert.equal(result.language,"English");assert.equal(result.currency,"USD");
  assert.equal(Date.parse(result.validUntil)-Date.parse(result.updatedAt),86_400_000);
  assert.deepEqual(result.cards.map(c=>c.name),BUYLIST_CARDS.map(c=>c.name));
  for(const card of result.cards){assert.equal(card.cashCents,7000);assert.equal(card.creditCents,8000);assert.equal(card.status,"available");}
  const serialized=JSON.stringify(result);for(const internal of ["marketCents","percent","apiKey","scrydexId","api.scrydex"])assert.equal(serialized.includes(internal),false);
});
test("unmatched or invalid quotes stay unavailable without hiding valid offers or leaking errors", async () => {
  const result=await buildBuylistSnapshot(async product=>{if(product.tcgplayerId===707611)throw new Error("secret token");return price(product.tcgplayerId===652898?0:10000);},()=>now);
  assert.equal(result.cards.length,9);for(const card of result.cards.slice(0,2)){assert.equal(card.cashCents,null);assert.equal(card.creditCents,null);assert.equal(card.status,"unavailable");}
  assert.equal(result.cards[2].cashCents,7000);assert.equal(JSON.stringify(result).includes("secret token"),false);
});
test("expired snapshots lose dollar offers while a fresh snapshot stays intact", async () => {
  const result=await buildBuylistSnapshot(async()=>price(10000),()=>now);
  assert.equal(currentBuylist(result,now+86_399_999),result);
  for(const time of [now-1,now+86_400_000,now+172_800_000]){
    const output=currentBuylist(result,time);assert(output.cards.every(c=>c.cashCents===null&&c.creditCents===null&&c.status==="unavailable"));
    assert.equal(output.cards.length,9);
  }
  assert.equal(result.cards[0].cashCents,7000);
});
test("only the exact public buylist route bypasses inventory authentication",async()=>{
  const source=await readFile(new URL("../proxy.ts",import.meta.url),"utf8");
  const match=source.match(/"(\/\(\(\?!api\/auth[^"\n]+)"/);assert(match);
  const protects=new RegExp(`^${match[1]}$`);
  assert.equal(protects.test("/api/public/buylist"),false);
  for(const path of ["/api/public/buylist/admin","/api/public/buylist-extra","/api/inventory","/api/prices/refresh","/api/sku-labels","/sku-labels"])assert.equal(protects.test(path),true,path);
});
