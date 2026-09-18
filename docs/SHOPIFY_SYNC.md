# Shopify inventory and order synchronization

Shopify owns online sellable stock and order state. DefyOS receives singles into
the existing Shopify product/variant/inventory-item identities and reads Shopify
back into a separate dashboard at `/shopify`. The storefront continues to read
the same Shopify products. Sync never adjusts Shopify stock, creates sales in the
legacy POS ledger, or changes spreadsheet inventory. Receiving remains the only
workflow in this integration that adds stock.

The separate [Scrydex pricing refresh](SHOPIFY_PRICING.md) updates existing
Shopify selling prices for POS and online use. It has its own daily schedule,
manual refresh panel, and durable progress; stock/order projection stays read-only.

## Configure and enable

1. Review the current database baseline. Apply `db/migrations/shopify-sync.sql`
   on a development Neon branch and run the integration checks below. This SQL
   only creates the six `shopify_*` tables/indexes; it does not migrate legacy
   inventory or overwrite existing store balances. Apply that reviewed additive
   migration to production only as part of an authorized release.
2. Configure server-only `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`,
   `SHOPIFY_CLIENT_SECRET`, and `SHOPIFY_LOCATION_ID` for the existing installed
   Shopify app. The approved production shop is `n4a7aa-fi.myshopify.com`.
   The only alternate allowed domain is `defy-receiving-test.myshopify.com`.
   `SHOPIFY_LOCATION_ID` is the complete `gid://shopify/Location/...` ID of the
   receiving/store location. Only that location's inventory is projected.
3. Grant `read_products`, `read_inventory`, `read_locations`, and `read_orders`.
   Existing write scopes used by receiving remain necessary for receiving.
   Shopify order access/approval must be granted where required. Reconciliation
   imports orders created in the last 59 days; Shopify's default access window
   is 60 days. Older order access requires approval for `read_all_orders`.
   Permission errors remain visible; no empty successful order snapshot is
   fabricated when Shopify denies access.
4. Set `SHOPIFY_WEBHOOK_SECRET` to the signing secret for the app/subscriptions
   sending these deliveries. For app-owned subscriptions, use that app's client
   secret. Use the configured webhook secret for an Admin-created subscription.
   Set `SHOPIFY_SYNC_ORIGIN` to the trusted HTTPS DefyOS origin, for example
   `https://defy-store-os.vercel.app`. Set `CRON_SECRET` for the protected retry
   endpoint (or `SHOPIFY_SYNC_CRON_SECRET` when calling it separately).
5. Set `SHOPIFY_SYNC_ENABLED=true` only after the migration and credentials are
   ready. It defaults off, and GET status never initializes tables or calls
   Shopify. Changing Vercel environment variables requires a new deployment.
6. Register HTTPS webhooks to `https://<defyos-host>/api/shopify/webhooks` for:
   `products/create`, `products/update`, `products/delete`,
   `inventory_levels/update`, `inventory_levels/connect`,
   `inventory_levels/disconnect`, `orders/create`, `orders/updated`,
   `orders/paid`, `orders/cancelled`, and `orders/delete`.
   Subscription setup is an explicit operational step; enabling this feature
   does not silently create or alter Shopify app subscriptions.
7. Open the Shopify dashboard and explicitly run reconciliation through its
   final page. Continue any paused run. Confirm known products, stock, and
   recent order totals against Shopify. For a receiving test, use development
   data/test Shopify first. Do not create an extra stock adjustment merely to
   test a production webhook.

## Delivery, ordering, and retries

The webhook handler caps the streamed raw body at 2 MB, verifies its SHA-256 HMAC
with constant-time comparison, enforces the exact configured shop, and validates
topic/resource/event IDs. It stores only the topic, IDs, and timestamp in the
durable inbox before responding. It does not save the webhook body or customer
names, email addresses, shipping addresses, or notes. A database write failure
returns a non-2xx response so Shopify can retry delivery.

After the response, a bounded worker leases pending inbox rows, fetches current
Shopify objects, and atomically marks the delivery complete alongside projection
updates. Duplicate webhook delivery IDs share one inbox record; the fallback
event identity also includes topic, resource, and location. Workers use a 90-second
lease, so abandoned work becomes retryable. Failures receive exponential retry
delays up to one hour and remain visible in the dashboard. The protected
`GET`/`POST /api/shopify/sync/drain` endpoint accepts `Authorization: Bearer
<CRON_SECRET>` and drains up to three due deliveries. The configured daily cron
is a fallback for interrupted requests; normal deliveries start immediately
using Next.js `after()`. A scheduler calling the protected endpoint more often
can reduce fallback delay when the hosting plan permits it. Manual reconciliation
also drains one due delivery after each completed page.

Snapshots compare the object's Shopify `updatedAt`, then the time its read
started. Inventory uses **InventoryLevel.updatedAt**, independently of the
product's version. Older snapshots cannot replace newer ones; a deletion wins
when versions tie. Product/order deletions retain tombstones, and complete
product/order snapshots retire removed variants/lines. Unreadable non-delete
objects remain pending, rather than being mistaken for deleted objects.

Orders store totals, status, timestamps, and line item identities/counts. Their
stock is copied from the current inventory level, never calculated by subtracting
order quantities. Paid, cancelled, refund-related order updates, and repeated
deliveries therefore cannot double-decrement inventory. Money retains Shopify's
decimal strings and currency codes. Dashboard stock prices use the USD store
currency already required by singles receiving.

## Bounded reconciliation and limits

Authenticated `GET /api/shopify/sync` reads projections and status only.
Authenticated `POST` requires JSON, `X-Defy-Sync: 1`, and the configured same
origin, and processes one bounded page: 25 variants at the configured location,
then product/variant identity audits (25 IDs per page), then one recent order per
page and a recent-order identity audit. Its validated continuation cursor is returned as
`nextCursor`. Shopify cursors are only passed as GraphQL variables; they are
never used as SQL or query source. Reconciliation pages also have durable inbox
entries, allowing an interrupted page to be retried safely.

The dashboard shows at most 100 inventory rows and 50 recent orders, while its
summary counts all saved projections. A webhook product snapshot is capped at
100 variants, and each order snapshot is capped at 100 lines to keep requests
within Shopify query cost and server duration limits. Oversized objects fail
explicitly and remain pending for review, rather than saving truncated data.
Inventory for products with more than 100 variants can still be imported by the
25-variant reconciliation pages. Oversized orders are separately queued for
review so they do not block later order pages. A partial page never purges records
omitted from that page. Bounded identity audits verify saved IDs directly and
tombstone confirmed missing products, variants, and orders in the recent access
window, recovering missed delete events. Orders older than 59 days are not
re-audited without a separate approved historical-access workflow. Sync does not replace the
existing store reporting/POS ledger, and projections should not be added to its
sales totals as if they were separate sales.

## Validation

Run the normal `npm test` workflow. Its focused tests cover raw HMAC/tampering,
body limits, allowlists and CSRF checks, duplicates, delayed updates, tombstones,
permission-independent projections, retryability, and absolute inventory.

For the additional real PostgreSQL checks, provide an isolated development Neon
URL as `SHOPIFY_SYNC_TEST_DATABASE_URL`, set `SHOPIFY_SYNC_INTEGRATION=1`, and run:

```sh
node --test --experimental-strip-types tests/shopify-sync-integration.test.ts
```

That test uses a unique `.invalid` fixture shop and only the six additive tables.
It verifies competing leases, duplicate event completion, version ordering,
atomic rollback, and order state, then removes only its fixture rows. It makes
no Shopify requests. Never point it at production.

References: [Shopify webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries),
[InventoryLevel fields](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel),
[Order access](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order).

## Release webhook setup

After the deployed handler, environment, signing secret, and approved scopes are
ready, inspect the setup plan using the intended environment's ignored env file:

```sh
node --env-file=.env.local --experimental-strip-types scripts/setup-shopify-webhooks.ts
```

The default is read-only. It verifies the authenticated shop and required scopes,
checks the exact HTTPS `SHOPIFY_SYNC_ORIGIN`, paginates existing subscriptions,
and prints the missing topic/callback pairs. Before applying, check the Shopify
app configuration for app-scoped subscriptions too: Shopify's listing API exposes
only this app's API-created shop-scoped subscriptions.

Append `--apply` to that same command to create the missing pairs. It uses exactly
`<SHOPIFY_SYNC_ORIGIN>/api/shopify/webhooks`, requests only `id` for product/order
payloads and `inventory_item_id` plus `location_id` for inventory payloads, and
never changes or deletes an existing subscription. Existing conflicting filters,
formats, missing payload identifiers, or duplicate pairs stop setup for review.
After an interrupted run, rerun the dry run; confirmed subscriptions are skipped.
The handler's `SHOPIFY_WEBHOOK_SECRET` must equal this subscribing app's
`SHOPIFY_CLIENT_SECRET`. No credentials are printed. Setup does not enable sync,
change stock, reconcile orders, or verify webhook delivery by making test sales.

[Shopify subscription creation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionCreate),
[subscription listing limits](https://shopify.dev/docs/api/admin-graphql/latest/queries/webhookSubscriptions).
