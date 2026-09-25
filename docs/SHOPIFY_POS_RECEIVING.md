# Receive stock in Shopify POS

Use the existing **Defy Receiving → Receive sealed stock** tile to receive sealed
products. Open the tile before scanning. Scanning in the regular POS cart finds
products for a sale; it does not receive a delivery.

1. Add **Apps → Defy Receiving** to the POS smart grid if its receiving tile is
   not already present. Confirm that POS is using the receiving store location.
2. Open **Receive sealed stock**, then scan the manufacturer's barcode on the
   unit you sell: a bundle, box, pack, or case. UPC and its equivalent EAN format
   resolve to the same barcode identity.
3. Check the matched product and selling unit. For an unknown barcode, search the
   existing Shopify catalog or search **Scrydex** by game and product name.
   Select the exact English package, review any existing store matches, and
   confirm the physical selling unit before registering a new product. Existing
   products keep their SKU; new registrations reserve a new store SKU.
4. Enter the quantity being added and cost **per selling unit**, plus the
   supplier, received date, and notes as needed. For example, receiving six boxes
   at $120 each means quantity 6 and unit cost 120.00. Enter **Store price per
   selling unit** to set the Shopify selling price, for example 149.99 per box.
   This optional field is separate from acquisition cost; leaving it blank keeps
   the current price. Existing products show their current Shopify price.
5. Save once and wait for **Receipt saved**. If confirmation is interrupted,
   recover or retry that same receipt. Starting a new receipt for the same
   delivery would add the stock again.
6. In DefyOS, open **Shopify stock & receiving**. Its inventory shows Shopify's
   current counts at the configured location; receiving history shows the
   confirmed receipt quantity and costs. Refresh the view after saving a receipt.

The quantity field adds units; it is not an absolute stock count. Enter only stock
not already included in Shopify. A pack barcode and a box barcode identify
different selling units. The current receiving tile requires a manufacturer GTIN;
custom single-card QR labels use DefyOS's separate SKU label workflow.

## What each system records

Shopify is the source for the stock shown in this view. DefyOS stores a read-only
inventory projection and updates it from product/inventory webhooks. Receiving
adds stock once in Shopify; synchronization copies the resulting absolute count
instead of adding the receipt quantity a second time. Later Shopify sales change
that same inventory count.

Receipt history reads this app's immutable `$app:receiving_applied` Shopify
metaobjects through an authenticated server endpoint. Costs are acquisition costs
from each receipt, not retail prices or a calculated average inventory cost.
The receiving app does not change Shopify's `inventoryItem.unitCost`.
An entered store price updates only the selected variant's Shopify selling price
before stock is added. It uses the shop currency, accepts up to two decimal places,
and is preserved in the immutable receipt. Enter 0 only for a free selling price.
The cost totals and DefyOS receiving-history cost columns remain acquisition costs.
History is paginated in batches of 25 source records and filtered to the configured
location. It is read-only and does not replay receipts or create expenses.

The older DefyOS inventory, spreadsheet balances, and sales ledger remain a
separate source. Do not add those quantities to Shopify quantities as if they
were different physical stock. Moving an existing balance to Shopify requires an
explicit count reconciliation; this receiving connection does not migrate it.

New receiving registrations remain drafts until their product details and Point
of Sale availability have been reviewed. If no store price was entered, review
the retail price as well. Recording a receipt does not publish a product.
The entered price is the Shopify variant price, not a permanent pricing override:
a later applicable Scrydex price refresh or Defy Pricing action can replace it.

The chosen store price is frozen with the receipt before any Shopify write. A
confirmed price is not applied again during inventory recovery or completed
receipt replay. If a price update is interrupted, recovery checks Shopify for the
requested price before continuing. When that price cannot be confirmed, the
receipt stays pending for owner review; do not start a second receipt for the
delivery. This avoids repeating a price write whose result is uncertain.
After reviewing the pending receipt, the owner can set that exact variant's price
to the saved store price in Shopify and retry the same receipt to finish receiving.

## Unknown barcodes and Scrydex

The Scrydex search supports Pokémon, One Piece, and Riftbound sealed products.
It offers English products with one standard (`normal`) edition. Older listings
that combine editions require manual registration of the exact physical edition.
Search uses a product name; Scrydex does not supply the barcode mapping. Staff
must compare the selected name, set, image when available, and selling unit with
the physical package. Refine searches that have more results. Packs, bundles,
displays, and cases must not be treated as interchangeable inventory units.

Selecting a result fetches its exact Scrydex ID again and checks the store for a
previously registered source identity and existing listings by name. Choosing an
existing listing preserves its SKU. A listing with a different valid manufacturer
barcode needs review; an invalid historical barcode requires the existing explicit
replacement confirmation. Manual registration remains available when the source
catalog does not contain the exact product.

The barcode mapping becomes permanent when **Save receipt** succeeds. New
Scrydex registrations store `scrydex:<game>:<id>` as the unique receiving catalog
identity, the manufacturer UPC/EAN identity on the variant, and the English
name/set details in product metadata. They reuse the existing durable receipt
journal, SKU allocator, and Shopify inventory adjustment; retry the same receipt
after an interruption. Older pending receipts retain their original fingerprint
and recovery behavior. Recovery does not depend on Scrydex being online.

New catalog drafts are created with their custom ID before descriptive card
metadata is saved. Recovery first verifies the reserved SKU, barcode, package,
game, name, and draft status, then fills only missing metadata with an atomic
create-if-absent write. Conflicting existing values require review and are never
overwritten. Stock is added only after the complete product identity is verified.
An interrupted draft creation or metadata save resumes the same receipt.

Scrydex market prices shown in the search are USD reference values, may be cached
for 24 hours, and may be unavailable. They do not populate acquisition cost or
the store-price field. Enter actual cost per selling unit and your chosen store
price separately. Newly registered products remain drafts and still require
activation and POS availability review.

`POST /api/shopify/pos/sealed-catalog` accepts either `{game, query}` or
`{game, id}` with a signed Shopify POS session token. It is a read-only server
lookup with bounded input, Shopify extension CORS, and an exact Neon middleware
exception. Credentials stay on the server; neither the extension nor the response
contains Scrydex keys. Existing Shopify and Scrydex environment settings are reused.

## Connection and operation

The existing six `shopify_*` tables support inventory synchronization; this feature
adds no database tables. Production uses the existing Defy Receiving app and
Redmond location. Configure `SHOPIFY_SYNC_ENABLED=true`,
`SHOPIFY_SYNC_ORDERS_ENABLED=false`, the existing Shopify connection variables,
`SHOPIFY_SYNC_ORIGIN`, and `SHOPIFY_WEBHOOK_SECRET` as described in
[SHOPIFY_SYNC.md](SHOPIFY_SYNC.md). Inventory-only mode uses existing product,
inventory, and location permissions. It does not need order-history access.

Register the six product/inventory webhooks using the setup script's reviewed dry
run, then run inventory reconciliation to completion. Shopify writes remain in
the receiving app; DefyOS synchronization never adjusts Shopify stock. The
authenticated receiving-history GET endpoint needs the existing app credentials
and its configured location, independently of the inventory sync switch.

Git/Vercel deploys the DefyOS dashboard, receipt reader, inventory synchronization,
and Scrydex search endpoint. The Scrydex selection UI also requires a separate
release of the existing `defy-receiving` Shopify extension after the backend is
ready. Build and validate with `npm test`, `npm --prefix shopify-pos test`, and
`shopify app build` from `shopify-pos/`. Keep the receiving/pricing extension UIDs,
app metadata definitions, and permissions intact. Follow the repository's release
authorization rule before running `shopify app deploy`.

Verification uses isolated database tests and read-only Shopify checks. A real
receipt already saved in Shopify can verify history without receiving extra
production stock. Physical scanner operation still requires checking the tile
on the POS device.
