# Bulk Warehouse integration

## Daily use

Open **Inventory → Bulk Warehouse** to view physical copies scanned in the
native Defy Warehouse Manager. The **Store inventory** tab retains the existing
store products. Bulk copies are stored separately and are not included in the
master-sheet import or automatically published as Shopify products.

Keep Warehouse Manager open and unlocked with an approved Defy account. Each
game workspace has its own persistent source ID. The integration preserves the
card's master ID, copy serial, printing, condition, finish, language, physical
location, and availability. Scan review and finalization do not make a card
available: the existing explicit physical-putaway step still controls that.

In Store OS, select available copies from one warehouse to **Remove copies** or
**Record sale**. Review the exact copy IDs before submitting. A sale records an
amount already paid; this screen does not collect payment. Commands remain
pending until the Mac validates and confirms the exact copies. A stale selection
is rejected as a whole. A confirmed sale reserves the native order for the usual
picking and shipping steps; it does not pretend those physical steps happened.

The **Native orders awaiting a sale amount** section lists shipped native orders
that do not yet have an actual recorded sale. **Record sale amount** accepts the
complete receipt amounts and actual sale date. This creates one financial record
for the order without moving its cards again. An order total is not divided into
invented per-card prices, and these aggregate orders are excluded from product
price rankings. Orders without amounts are identified in reporting and contribute
no fabricated revenue.

Use **All inventory**, **Store inventory**, or **Bulk Warehouse** in sales and
reports to include or exclude bulk sales. Charts, loaded sales, and CSV exports
use the same selection. Blank card costs remain unknown and mark profit as
incomplete. Shared expenses are not arbitrarily assigned to a source. The reports
identify when the loaded history limit or missing sale lines prevents a complete
period total.

Physical cancellation, shipping, or return changes do not themselves prove that
money was collected or refunded. Recorded financial amounts remain historical
facts; a physical return is not automatically recorded as a refund.

## Offline and retry behavior

Warehouse Manager owns physical stock. Closing or locking the Mac pauses sync;
Store OS retains the last confirmed inventory and shows each source's last sync.
New Store OS stock actions wait for a later authorized connection.

The browser saves the exact request ID and body before sending a stock action or
an order sale. A lost response can be retried with the same request. Reloading a
page never automatically submits a saved request. A valid rejected request is
durable, so it can be safely resolved before making another selection.

The native journal uses immutable, sequential events and durable command
receipts. Events and receipts are replay-safe. Competing Store OS requests hold
the selected copies while the native app is offline. The native app rechecks the
copy fingerprint and availability before accepting a command. The cloud commits
a stock change and its priced sale together only after the matching physical
stock event has arrived.

## Data and security boundaries

- `defy_bulk` contains the warehouse projections, immutable change history,
  command receipts, holds, native-order metadata, and bulk sales. Existing
  `public.products`, ordinary store sales, Shopify, and account tables retain
  their existing purposes.
- Browser endpoints require the existing approved Store OS session. Write
  endpoints additionally require the same origin.
- `/api/native-warehouse/sync` authenticates a native device credential and its
  current approved account. It is the only additional exact proxy exemption.
  An invalid bearer token cannot fall back to browser authentication.
- The native credential remains in the macOS Keychain and Swift process. It is
  never included in Python IPC, database records, files, or logs.
- The persisted workspace ID survives staff-account changes. The deployment is
  one shared store; approved staff can operate the same workspace. Each accepted
  event also records its authenticated actor on the server.
- Sync transmits card metadata and order details, not original scan images,
  recognition caches, or local filesystem paths.
- No Shopify product creation or additional paid connector is required for this
  integration. Shopify's published standard plans include unlimited products;
  catalog creation rate limits are a separate issue from listing fees.

## Protocol

`POST /api/native-warehouse/sync` accepts protocol `1`, a persistent workspace UUID,
the game workspace, a display name, the last locally acknowledged sequence,
up to 250 sequential events, and up to 100 command receipts. The request body is
bounded at 2 MB.

Event kinds are `copy`, `delete`, `order`, and `order_delete`. Copy and order
fingerprints identify the exact revision reviewed by the operator. Orders retain
their source creation timestamp; it is never substituted for a sale date. A
native order is linked to a Store OS sale only when its source, command ID, and
exact copy set match.

Responses include the acknowledged sequence, bounded pending stock commands,
and final receipt statuses. A receipt whose stock events have not all arrived
remains pending. A replay with a different event payload or a reused request ID
with a different body is rejected rather than silently replacing history.

`GET /api/bulk-warehouse` provides server-side search, game/availability filters,
100-copy pagination, source connection status, recent stock actions, and a
bounded list of native orders awaiting pricing. `POST` queues an exact-copy
stock action. `/api/bulk-warehouse/orders/sale` validates and records a shipped
native order's actual financial totals without another stock command.

## Migration and verification

`db/bulk-warehouse.sql` is an explicit additive baseline for the new schema. Apply
it to an isolated Neon branch and validate it before applying the same reviewed
SQL to the existing production branch. Do not generate a migration that tries to
rebuild the recovered application's existing tables.

Run the normal `npm test` gate. The additional real-Postgres integration runner
is guarded by an explicit test branch ID and expected database hostname:

```bash
NODE_USE_ENV_PROXY=1 NATIVE_SOURCE_ROOT="$PWD" \
  node --env-file=.env.local \
  --import ./scripts/native-warehouse-test-resolver.mjs \
  --experimental-strip-types scripts/bulk-warehouse.integration.mjs
```

The runner uses isolated random warehouse IDs, verifies concurrency and replay
behavior, and removes only its own fixture rows. It must never target production.
Native validation uses temporary warehouse fixtures, plus readable backups and
business-table hashes to check that the release preserves real inventory.

Official Shopify references:

- [Features on all plans](https://help.shopify.com/en/manual/intro-to-shopify/pricing-plans/plans-features/features-on-all-plans)
- [Shopify pricing](https://www.shopify.com/pricing)
