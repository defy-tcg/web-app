import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runSkuRepairPage, type SkuRepairDependencies } from "../lib/sku-label-shopify-repair.ts";
import { skuLinkOriginAllowed, skuLinkRequestSkus } from "../lib/sku-label-shopify-service.ts";

function fixture() {
  let value: Awaited<ReturnType<SkuRepairDependencies["read"]>>["value"] = null;
  let revision = 0;
  let now = 100;
  const linked: number[] = [];
  const rows = [1, 2, 3].map(id => ({ id, ready: id === 1, link: async () => { linked.push(id); } }));
  const deps: SkuRepairDependencies = {
    read: async () => structuredClone({ value, digest: revision ? String(revision) : null }),
    cas: async (snapshot, next) => {
      if (snapshot.digest !== (revision ? String(revision) : null)) return false;
      value = structuredClone(next); revision++; return true;
    },
    page: async after => rows.filter(row => row.id > after),
    now: () => now,
  };
  return { deps, linked, rows, state: () => value, advance: (ms: number) => { now += ms; } };
}

test("QR repair skips verified-ready cards and advances its durable cursor through pending cards", async () => {
  const f = fixture();
  assert.deepEqual(await runSkuRepairPage(f.deps), { busy: false, checked: 3, attempted: 2, complete: true });
  assert.deepEqual(f.linked, [2, 3]);
  assert.equal(f.state()?.afterId, 0);
  assert.equal(f.state()?.lease, null);
});

test("overlapping QR repair runs cannot both process pending stock receipts", async () => {
  const f = fixture();
  const results = await Promise.all([runSkuRepairPage(f.deps), runSkuRepairPage(f.deps)]);
  assert.equal(results.filter(result => result.busy).length, 1);
  assert.deepEqual(f.linked, [2, 3]);
});

test("failed QR repair keeps the last confirmed cursor and retries the interrupted identity", async () => {
  const f = fixture();
  let fail = true;
  f.rows[2].link = async () => { if (fail) throw new Error("Network interrupted"); f.linked.push(3); };
  await assert.rejects(runSkuRepairPage(f.deps), /Network interrupted/);
  assert.equal(f.state()?.afterId, 2);
  assert.equal(f.state()?.lease, null);
  fail = false;
  await runSkuRepairPage(f.deps);
  assert.deepEqual(f.linked, [2, 3]);
});

test("QR repair cannot commit results after losing its lease", async () => {
  const f = fixture();
  f.rows[1].link = async () => { f.advance(300_000); };
  await assert.rejects(runSkuRepairPage(f.deps), /lease changed/);
  assert.equal(f.state()?.afterId, 1);
});

test("link requests accept only saved QR codes and require same-origin writes", () => {
  assert.deepEqual(skuLinkRequestSkus(["DEFY-9775456393", "DEFY-9775456393"]), ["DEFY-9775456393"]);
  for (const value of [null, [], ["gid://shopify/Product/1"], Array(101).fill("DEFY-9775456393")]) assert.throws(() => skuLinkRequestSkus(value));
  assert.equal(skuLinkOriginAllowed(new Request("https://defy.test/api/sku-labels/shopify", { headers: { origin: "https://defy.test" } })), true);
  assert.equal(skuLinkOriginAllowed(new Request("https://defy.test/api/sku-labels/shopify", { headers: { origin: "https://other.test" } })), false);
  assert.equal(skuLinkOriginAllowed(new Request("https://defy.test/api/sku-labels/shopify", { headers: { origin: "https://defy.test", "sec-fetch-site": "cross-site" } })), false);
});

test("QR repair cron uses secret authentication while every interactive QR endpoint stays behind the session middleware", async () => {
  const source = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  const matcher = source.match(/"(\/\(\(\?!api\/auth[^"\n]+)"/);
  assert(matcher, "Read the actual configured middleware matcher.");
  const protects = new RegExp(`^${matcher[1]}$`);
  assert.equal(protects.test("/api/sku-labels/shopify/cron"), false);
  for (const path of ["/sku-labels", "/api/sku-labels", "/api/sku-labels/reserve", "/api/sku-labels/shopify", "/api/sku-labels/shopify/cron-extra", "/api/sku-labels/shopify/cron/child"]) assert.equal(protects.test(path), true, path);
});
