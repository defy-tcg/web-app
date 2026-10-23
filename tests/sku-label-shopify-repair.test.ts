import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runSkuRepairPage, type SkuRepairDependencies } from "../lib/sku-label-shopify-repair.ts";
import { skuLinkOriginAllowed, skuLinkRequestSkus } from "../lib/sku-label-shopify-service.ts";
import { canAutomaticallyRecoverSkuLink } from "../lib/sku-label-link-recovery.ts";

function fixture() {
  let value: Awaited<ReturnType<SkuRepairDependencies["read"]>>["value"] = null;
  let revision = 0;
  let now = 100;
  const linked: number[] = [];
  const rows = [1, 2, 3].map(id => ({ id, recoverable: id !== 1, link: async () => { linked.push(id); } }));
  const deps: SkuRepairDependencies = {
    read: async () => structuredClone({ value, digest: revision ? String(revision) : null }),
    cas: async (snapshot, next) => {
      if (snapshot.digest !== (revision ? String(revision) : null)) return false;
      value = structuredClone(next); revision++; return true;
    },
    page: async after => rows.filter(row => row.id > after).slice(0, 12),
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

test("repair skips stored-ready verification and human-review blockers while linking recoverable cards", async () => {
  const f = fixture();
  const statuses = [
    { sku: "DEFY-1000000001", status: "ready" as const },
    { sku: "DEFY-1000000002", status: "pending" as const, verificationPending: true },
    { sku: "DEFY-1000000003", status: "blocked" as const },
    { sku: "DEFY-1000000004", status: "pending" as const },
    { sku: "DEFY-1000000005", status: "blocked" as const, automaticRetry: true },
    { sku: "DEFY-1000000006", status: "pending" as const, catalogCorrectionPending: true },
  ];
  f.rows.splice(0, f.rows.length, ...statuses.map((status, index) => ({
    id: index + 1, recoverable: canAutomaticallyRecoverSkuLink(status), link: async () => { f.linked.push(index + 1); },
  })));
  assert.deepEqual(await runSkuRepairPage(f.deps), { busy: false, checked: 6, attempted: 2, complete: true });
  assert.deepEqual(f.linked, [4, 5]);
  assert.equal(f.state()?.afterId, 0);
});

test("discovery that consumes the time budget checkpoints skipped rows before the next recoverable card", async () => {
  const f = fixture();
  let slow = true;
  f.deps.page = async afterId => {
    if (slow) f.advance(171_000);
    return f.rows.filter(row => row.id > afterId).slice(0, 12);
  };
  assert.deepEqual(await runSkuRepairPage(f.deps), { busy: false, checked: 1, attempted: 0, complete: false });
  assert.equal(f.state()?.afterId, 1);
  assert.equal(f.state()?.lease, null);
  assert.deepEqual(f.linked, []);
  slow = false;
  assert.deepEqual(await runSkuRepairPage(f.deps), { busy: false, checked: 2, attempted: 2, complete: true });
  assert.deepEqual(f.linked, [2, 3]);
});

test("successive bounded passes reach later cards rather than restarting the same recoverable prefix", async () => {
  const f = fixture();
  f.rows.splice(0, f.rows.length, ...Array.from({ length: 30 }, (_, index) => ({
    id: index + 1, recoverable: true, link: async () => { f.linked.push(index + 1); },
  })));
  const first = await runSkuRepairPage(f.deps);
  assert.deepEqual(first, { busy: false, checked: 12, attempted: 12, complete: false });
  assert.equal(f.state()?.afterId, 12);
  assert.equal(f.state()?.lease, null);
  assert.deepEqual(await runSkuRepairPage(f.deps), { busy: false, checked: 12, attempted: 12, complete: false });
  assert.equal(f.state()?.afterId, 24);
  assert.deepEqual(await runSkuRepairPage(f.deps), { busy: false, checked: 6, attempted: 6, complete: true });
  assert.deepEqual(f.linked, Array.from({ length: 30 }, (_, index) => index + 1));
  assert.equal(f.state()?.afterId, 0);
});

test("one pass serializes link attempts and rejects oversized or unordered discovery pages", async () => {
  const f = fixture();
  let active = 0, maxActive = 0;
  for (const row of f.rows) row.link = async () => {
    active++; maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    f.linked.push(row.id); active--;
  };
  await runSkuRepairPage(f.deps);
  assert.equal(maxActive, 1);
  for (const invalid of [
    Array.from({ length: 13 }, (_, index) => ({ id: index + 1, recoverable: false, link: async () => {} })),
    [{ id: 2, recoverable: false, link: async () => {} }, { id: 1, recoverable: false, link: async () => {} }],
  ]) {
    const broken = fixture(); broken.deps.page = async () => invalid;
    await assert.rejects(runSkuRepairPage(broken.deps), /Invalid QR repair page/);
    assert.equal(broken.state()?.afterId, 0);
    assert.equal(broken.state()?.lease, null);
  }
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
