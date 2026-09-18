# Riftbound singles

Open `/singles` from **Inventory → Riftbound singles**. The searchable reference
catalog is separate from owned inventory. It does not create zero-stock Shopify
listings. Shopify holds current singles quantities shared by website and POS.

## Receive a batch

1. Search by card name, collector number, set, or TCGplayer product ID. Check the
   pictured printing and finish against the physical English card.
2. Add the card, choose its condition, and enter the quantity being added, cost
   per card. Alternatively, upload/paste the CSV template; selling price is optional
   and any supplied value is replaced by the verified Scrydex quote.
3. Review every row's Scrydex market price. The review and its total market value
   show the raw provider prices; customer selling prices are kept out of intake
   review. A quantity is an addition to current Shopify stock, not a
   replacement count. Do not re-enter stock already received through another app.
4. Choose whether to publish to Online Store, Point of Sale, and the Defy TCG
   website (Headless). Publishing needs a positive selling price and permission
   for all three publications. Draft intake keeps new listings unpublished for
   review. Publishing a Shopify product affects its other variants too; stocked
   variants without a positive price must be reviewed first.
5. Save. Keep the page's saved receipt if the connection is interrupted; use its
   retry action. Never recreate an uncertain receipt with a new request ID.

The exact TCGplayer product ID, finish, English language, and condition determine
new singles SKUs: `DEFY-RFB-{ID}-{NORMAL|FOIL}-EN-{NM|LP|MP|HP|DMG}`. These are the
same identities used by the storefront. Existing products, variants, and inventory
items keep their Shopify IDs; receiving updates only the selected variant's price,
cost, and added quantity. Existing sealed SKUs and receiving remain separate.

An exact mapping check runs before any stock write. It combines paginated SKU
prefix/tag searches, app-owned unique identities, storefront catalog metadata and
handles, and the nine verified original storefront product IDs. Every candidate's
full variant list is read and checked; card titles are never used for fuzzy
matching. Repeated/missing pagination or conflicting identifiers stop receiving
for review. The original no-SKU Defy normal/Near Mint card uses its verified product,
variant, and inventory-item IDs; that exception cannot apply to another card or
condition. Unknown manual listings without any shared identity require explicit
mapping before being received here.

New printings use a unique app-owned printing ID and Condition / Finish / Language
options; new conditions or finishes append a variant to the existing compatible
product. Creation never runs `productSet` against a pre-existing listing. Existing
product titles, options, SKUs, and sibling variants are not replaced. The first
zero-stock draft variant created by this app may be initialized in place. Old OS
single-variant products and their hashed SKUs remain valid, including frozen
receipts from before this change. Card metadata is exposed for storefront and
deck-builder matching; new product images use the full-size TCGplayer source.

## Catalog and pricing

The identity catalog is a bundled TCGCSV category 89 snapshot with a visible
source date. Its historical market benchmarks do not determine selling prices.
Review fetches a Scrydex quote for each exact English printing, finish, and raw
condition. Intake displays the raw market price and calculates its total as
market price multiplied by quantity. Only Riftbound singles have a customer-facing
selling price of Scrydex market plus 10%, rounded half-up to cents. Other games
and product types, including Riftbound sealed products, sell at the raw market
price. The Riftbound singles selling price is still sent to
Shopify when receiving, but is not displayed in intake review. Quotes require a
positive USD market price and are cached for 24 hours. Missing collector numbers,
unsupported printings, ambiguous matches, and unavailable condition prices block
the affected review; the app does not substitute Near Mint or another finish.

Price reviews use groups of at most ten rows, with at most four concurrent
provider requests. Before a new receipt starts, the server verifies the submitted
sale price against the current quote. A changed price requires another review.
Saved receipts resume their original price even when the provider is unavailable,
preserving inventory idempotency. This updates the selected received variant;
it does not automatically reprice every existing Shopify listing.

TCGCSV does not expose language-level SKUs. English is the configured intake
scope; the operator must confirm the physical card's language. Explicit foreign
language listings, presales, sealed products, and listings without a known finish
are excluded. The snapshot records exclusions and is not a claim of exhaustive
coverage of every promo or printing.

Run `npm run catalog:riftbound` to refresh the snapshot, then run `npm test`,
review the changed data, and release it through the existing Git workflow. The
refresh checks the source timestamp and follows TCGCSV's once-daily full-pull
limit. Catalog refreshes never modify Shopify inventory or sale prices.

## Connection and recovery

The server uses the existing Defy Receiving app's client credentials, stored only
in ignored local environment files or encrypted Vercel environment variables.
See `.env.example`. Configure each environment with its intended Shopify store
and location. Development and preview must use the development store.
Scrydex additionally requires `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` on the server.

Receipt records and a compare-and-set journal live in the app-owned Shopify
`singles` namespace. Product uniqueness uses the existing app-owned receiving
catalog-ID definition with a separate singles printing prefix. This fences OS
product creation; a second independent writer must be disabled for new receipts
during cutover. The website can still recover already-started batches using their
original journal, but their rows must not be re-entered in OS. Inventory additions reuse
their original Shopify idempotency key. Retry of an uncertain addition stops
before Shopify's 24-hour deduplication retention expires. Completed receipts can
still be read without adding stock again.

This flow does not write to the older Neon inventory or spreadsheet quantities.
Use Shopify for singles checkout and on-hand balances. The legacy Defy checkout
does not sell these new Shopify singles.

## Release prerequisites

- Original PNG recovery is complete; all five files match the original source
  hashes recorded in `docs/RECOVERY.md`.
- Connect the existing Vercel project to `defy-tcg/web-app` for Git deployments.
- Add the server-only Shopify connection settings to Production and separate
  development values to Development/Preview.
- Approve `write_publications` for Defy Receiving to enable the optional Online
  Store, POS, and Headless website publishing action. The production website uses
  verified publication `gid://shopify/Publication/202600611926`; development stores
  must have an unambiguous `Defy TCG website` publication. Stock receipt itself uses the existing product and
  inventory permissions.
- Verify development-store receipt, exact replay, and condition separation before
  releasing. Do not populate production quantities until the owner supplies actual
  on-hand cards and confirms the reviewed batch.

## Mapping verification

`ShopifySinglesAdapter.lookupExisting(plannedRow)` is read-only and can verify the
product/variant/inventory-item mapping without creating products or receiving
stock. It returns `null` for an unmapped new variant and throws on conflicting
existing evidence. Automated tests cover paginated mapping, sibling preservation,
legacy no-SKU and hashed-SKU recovery, lost creation responses, exact condition
separation, and publication to all three channels. No test changes production
stock. Pending old receipts use the current verified publication set on retry;
completed receipts still return their saved result without replaying inventory.

## Earlier development verification

The development Shopify store was exercised with three exact identities: foil
Near Mint, foil Lightly Played, and normal Near Mint. Each created a separate
draft product with its own tracked inventory and barcode. Replaying the same
receipt preserved its quantity. No production singles quantities were entered.

Browser verification covered alternate-art/promo search, CSV matching, freezing
edits while review loads, interrupted-save recovery after a reload, and editing
only rejected/unsubmitted rows while retaining completed receipt rows. Browser
fault simulation used a temporary local harness that is not shipped.
