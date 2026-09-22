# Scrydex pricing in Shopify POS

Open **Shopify stock & orders → Refresh Scrydex prices** to update existing
Shopify variant prices. Once Shopify POS has synchronized its catalog, scanning
the existing SKU/barcode uses that saved Scrydex-based selling price. Shopify
shares the price with online channels. This is catalog price synchronization,
not a POS extension that intercepts each physical scan or reprices an open cart.
Sync the POS device and remove/re-add an already-carted item to use a new price.

Riftbound singles use Scrydex raw market plus 6%, rounded half-up to cents.
Other supported products, including Riftbound sealed, use raw market without
markup. Exact English printings and positive USD quotes are required. Scrydex
responses retain the existing 24-hour cache; repeated scans do not consume a
fresh provider request each time.

## Matching and scope

Only active variants already published to the Point of Sale channel are checked.
Canonical Riftbound singles SKUs and the old finish-hash SKUs resolve against the
bundled identity catalog. Conflicting catalog IDs, game, condition, finish,
language, or card metadata stop that variant. Other products must match exactly
one existing Defy inventory SKU/barcode with complete pricing identity. This
supports Pokémon, One Piece, and Riftbound sealed products through Scrydex.
Unknown/manual listings without that mapping keep their price and appear in the
review list. The sync does not invent a mapping or create a listing.

Before writing, the service checks Shopify for duplicate scan codes and re-reads
the variant to detect concurrent identity or price changes. Each mutation sets
only the selected variant's price and an app-owned quote audit metafield.
It does not change stock, costs, barcodes, product options, publication, sibling
variants, or order amounts. Shopify confirms the written variant ID and price.
The API has no compare-and-set primitive for variant prices; another independent
price writer should not run at the same time. Existing receiving retains its
price writes and does not acquire this pricing-run lease.

## Scheduling and progress

The protected `/api/shopify/pricing/cron` runs daily at `27 8 * * *` UTC through
Vercel, using the existing server-only `CRON_SECRET`. The existing webhook retry
cron is unchanged. Price sync defaults enabled in production; explicitly set
`SHOPIFY_PRICE_SYNC_ENABLED=false` to disable it. Development's example env file
disables it. Existing Shopify credentials/location, `write_products`, Scrydex
credentials, and the trusted `SHOPIFY_SYNC_ORIGIN` are reused. No migration or
new app permissions are required if the current receiving connection is ready.

Progress is stored in the existing app's shop metafield namespace under
`pos_pricing_sync_v1`. Four variants are checked per page, with a compare-digest
lease preventing overlapping scheduled/manual price runs. Mutation results are
all settled before releasing the lease. An interrupted or failed page retains
its cursor; setting the same absolute price on retry cannot add/remove stock.
Provider outages and unconfirmed mutations stop the page instead of silently
advancing. Ambiguous or unsupported products are counted and shown for review.

Cron work is bounded to the function's 300-second duration. Large catalogs pause
with their cursor saved and resume on the next scheduled call or with the
dashboard's Resume button. The dashboard also pauses after 100 pages and retains
the server checkpoint after reload. A completed daily run is not repeated within
23 hours by another automatic invocation. Manual refresh can start a new run.
The dashboard shows totals, up to 10 confirmed prices, and the first 20 issues.

The owner endpoint requires an authorized Neon session, same-origin JSON and
`X-Defy-Sync: 1`. The cron's narrow middleware exemption still requires its
constant-time bearer-secret check. Neither endpoint returns credentials or the
lease token. GET status never starts a pricing mutation.

## Validation and first run

Run `npm test`. Tests cover exact condition/finish separation, raw sealed pricing,
the singles markup, duplicate/conflicting codes, invalid quotes, price-only writes,
confirmed results, retry checkpoints, concurrent leases, pagination, and cron
authentication. These tests do not change production Shopify stock or prices.

After the production deployment is READY, use the authorized dashboard to run
the initial refresh and inspect confirmed prices/issues. This is an intentional
production price sync, not a test sale. Verify a known product price in Shopify
POS after its catalog sync. The first deployment alone does not prove that every
product was matched or that a physical POS device received the new catalog.

References: [Shopify variant updates](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/productVariantsBulkUpdate),
[POS publication filtering](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/productVariants),
[compare-digest metafields](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/metafieldsSet).
