# Riftbound singles

Open `/singles` from **Inventory → Riftbound singles**. The searchable reference
catalog is separate from owned inventory. It does not create zero-stock Shopify
listings. Shopify holds current singles quantities shared by website and POS.

## Receive a batch

1. Search by card name, collector number, set, or TCGplayer product ID. Check the
   pictured printing and finish against the physical English card.
2. Add the card, choose its condition, and enter the quantity being added, cost
   per card, and selling price. Alternatively, upload/paste the CSV template.
3. Review every row. A quantity is an addition to current Shopify stock, not a
   replacement count. Do not re-enter stock already received through another app.
4. Choose whether to publish to Online Store and Point of Sale. Publishing needs
   a positive selling price and both channel permissions. Draft intake keeps new
   listings unpublished for review.
5. Save. Keep the page's saved receipt if the connection is interrupted; use its
   retry action. Never recreate an uncertain receipt with a new request ID.

Card, exact source product ID, finish, English language, and condition determine
each permanent singles SKU. A separate Shopify product is created for each of
these exact identities so conditions cannot overwrite one another. Restocking
uses the existing identity, updates the explicitly entered price/cost, and adds
quantity. Existing sealed SKUs and the sealed receiving journal remain separate.

## Catalog and pricing

The catalog is a bundled TCGCSV category 89 snapshot with a visible source date.
Market prices are dated USD benchmarks; they are not live or condition-specific.
The system does not automatically turn a benchmark into a selling price.

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

Receipt records and a compare-and-set journal live in the app-owned Shopify
`singles` namespace. Product uniqueness uses the existing app-owned receiving
catalog-ID definition with a separate singles prefix. Inventory additions reuse
their original Shopify idempotency key. Retry of an uncertain addition stops
before Shopify's 24-hour deduplication retention expires. Completed receipts can
still be read without adding stock again.

This flow does not write to the older Neon inventory or spreadsheet quantities.
Use Shopify for singles checkout and on-hand balances. The legacy Defy checkout
does not sell these new Shopify singles.

## Release prerequisites

- Restore the five original PNG assets listed in `docs/RECOVERY.md` before the
  first deployment of this recovered application.
- Connect the existing Vercel project to `defy-tcg/web-app` for Git deployments.
- Add the server-only Shopify connection settings to Production and separate
  development values to Development/Preview.
- Approve `write_publications` for Defy Receiving to enable the optional website
  and POS publishing action. Stock receipt itself uses the existing product and
  inventory permissions.
- Verify development-store receipt, exact replay, and condition separation before
  releasing. Do not populate production quantities until the owner supplies actual
  on-hand cards and confirms the reviewed batch.

## Verification

The development Shopify store was exercised with three exact identities: foil
Near Mint, foil Lightly Played, and normal Near Mint. Each created a separate
draft product with its own tracked inventory and barcode. Replaying the same
receipt preserved its quantity. No production singles quantities were entered.

Browser verification covered alternate-art/promo search, CSV matching, freezing
edits while review loads, interrupted-save recovery after a reload, and editing
only rejected/unsubmitted rows while retaining completed receipt rows. Browser
fault simulation used a temporary local harness that is not shipped.
