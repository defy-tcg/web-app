# Shopify integration release status

## Validated locally on 2026-09-18

- The five original DefyOS PNG assets were recovered from the original Vercel
  deployment and verified against its source-manifest SHA1 hashes.
- DefyOS uses the storefront's canonical SKU format and reuses verified Shopify
  product, variant, and inventory-item IDs. Read-only production checks resolved
  Defy, Treasure Trove, and Mirror Image to their existing listings.
- The additive migration was tested on development Neon branch
  `br-shiny-mud-afd6okid`. Schema comparison found only the six new Shopify tables
  and their indexes. Production schema and inventory were not changed.
- `npm test` passed: 82 focused tests, ESLint, and the production build. The
  separately enabled PostgreSQL integration test passed against the development
  branch, including concurrent leases, atomic rollback, deferred deliveries,
  and deletion/version ordering.
- Isolated dashboard browser checks passed at desktop and phone widths, including
  pause/resume, error recovery, and GET-only initial loading. Mock records were
  used; this was not a production order-sync test.
- Production read-only inventory queries returned valid snapshots. Requested
  query costs were 32 for an inventory page and 48 for a product snapshot. The
  order query requested cost 23 but access was denied by Shopify's current scopes.

## Required activation sequence

1. Original PNG recovery is complete (see `RECOVERY.md`). Connect the existing Vercel
   `defy3/defy-store-os` project to `defy-tcg/web-app`; do not create a replacement
   project or trigger a separate manual deployment.
2. Extend the existing Shopify app with `read_orders` and
   `read_publications`/`write_publications`, keeping its existing scopes. Use the
   same production shop and location already verified by receiving. Do not ask
   for historical `read_all_orders` or customer-profile access for this release.
3. Recheck the production baseline and apply only
   `db/migrations/shopify-sync.sql`. Configure the server-only variables listed
   in `.env.example` in the existing Vercel project. Keep Development/Preview
   isolated. Enable sync only when the tables and credentials are ready.
4. Verify the Git-triggered deployment, its authenticated receiving/sync routes,
   and independently authenticated webhook/cron endpoints. Run webhook setup's
   dry run, review the exact callback/topic list, then use `--apply` as documented
   in `SHOPIFY_SYNC.md`. Existing subscriptions are never deleted by this script.
5. Run reconciliation to completion. Verify stock and permitted recent orders
   against Shopify. Do not test by creating production orders or adding stock.
6. The storefront's default-off receiving switch and legacy-variant display
   compatibility are published as Sites version 36 (`44ca8b6`), with production
   receiving still in legacy mode. Confirm `card.condition`, `card.finish`, and
   `card.language` are readable by Storefront API. Set the storefront receiving
   mode to `drain`, resolve started/uncertain old receipts using their original
   journal, and only then select `os` after verifying DefyOS is ready. Keep legacy
   receipt recovery available. Never replay old rows as new OS stock receipts.
7. Confirm the website still reads Shopify and checkout stays disabled. Verify
   Headless publication along with Online Store and POS when publishing a real,
   owner-reviewed receiving batch later.

## Operating limits

Shopify stock/orders are separate synchronized records in `/shopify`; the older
spreadsheet POS/reporting ledger is preserved and is not an additional source of
Shopify sales. Orders beyond the default 60-day access window are not imported.
Orders over 100 lines remain queued for review without blocking subsequent pages.
Normal webhooks process immediately; the daily cron is a fallback for interrupted
workers. More frequent scheduled retries depend on the hosting plan.

Until activation is verified, the live storefront retains its current receiving
workflow and this integration must not be described as live.
