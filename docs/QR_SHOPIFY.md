# Permanent QR codes in Shopify POS

Saving a new TCGplayer card or a manual QR card in DefyOS queues its permanent QR
for Shopify POS. Defy matches the exact existing Shopify card and variant, or
creates the missing listing, saves the QR as a Shopify barcode, and publishes to
the **Point of Sale** channel. Other sales channels are not selected by this
workflow. Production use requires the one-time Shopify app permission release
described below; the source changes and Git deployment alone do not activate it.

## Save, link, and scan

1. Open **SKU labels**. Paste a TCGplayer product link, or enter a manual card's
   details. Select its physical condition and finish.
2. For a genuinely new card, enter the starting quantity that should be received
   in Shopify. TCGplayer imports default to zero. Label copies only control how
   many stickers print; they never determine inventory quantity.
3. Save the card. Defy keeps its QR immediately and starts Shopify linking in the
   background. Keep the saved card if Shopify is temporarily unavailable.
4. Wait for **Shopify POS ready**, then sync or reopen POS before scanning. A
   pending or blocked card keeps its original QR and offers a retry action.

Pasting the same TCGplayer product link again loads the original saved QR/SKU.
Once the card loads, its selected condition and finish automatically control the
label preview, PDF, and print output. Each new selection starts with one copy;
previously selected cards are not included in that print job. Lookup is read-only.
An unsaved variant must be saved before its permanent QR can be printed. Loading
or failed lookups cannot print the previous card's QR. Clearing the link restores
the previous batch; confirming a save replaces it with the server-confirmed card.
The numeric product ID is authoritative regardless of URL slug, tracking query,
or later catalog name changes. Condition and finish distinguish variants. Manual
cards use normalized game, name, set, collector number, condition, and finish.
Retries and simultaneous employee requests reuse the durable identity instead of
creating another card. A conflicting or ambiguous Shopify mapping stops linking
for review; Defy does not guess which listing to replace.

Adding a TCGplayer link to an existing manual card retains its original QR,
Shopify product and variant, and starting-stock receipt. Interrupted creation or
stock responses are reconciled under their original identities before the link
is adopted. Other saved conditions of the same manual card remain usable.

## One identity across systems

The short `DEFY-…` code printed inside the QR remains permanent. Shopify saves it
as a barcode on the exact variant. Existing Shopify SKUs are preserved. A newly
created standard Riftbound variant uses the canonical internal SKU
`DEFY-RFB-{TCGplayer ID}-{NORMAL|FOIL}-EN-{condition code}` so it remains compatible
with the existing singles intake workflow; its printed QR still uses the original
short Defy code. Other new cards use their saved Defy SKU.

Existing Shopify barcodes are retained in their original order, including their
types. Adding a short QR appends an untyped secondary barcode when necessary.
The linking client uses Admin API `2026-10` to read and update the complete barcode
list and verifies the result. Shopify limits a variant to 20 barcodes; a full or
incomplete barcode list requires review. An existing barcode is never silently
replaced to make room for a QR.

Printing, downloading a PDF, clearing a batch, or scanning does not regenerate
the code. The saved-label library works across signed-in devices. Defy's barcode
registration and POS catalog synchronization are separate stages: **ready** means
Shopify confirmed the mapping and publication; the physical device may still
need its catalog refreshed.

## Starting quantity and prices

The starting quantity is a single receipt, not a balance to continually copy from
Defy to Shopify. Defy stores the original intake movement and Shopify keeps a
durable journal for that QR, including the fixed quantity and adjustment identity.
The transfer uses this original receipt, never the card's current Defy quantity.
An interrupted response resumes the same adjustment; it does not issue a new
stock receipt. A repeated link or reprint never receives the starting quantity
again. A zero starting quantity creates no added stock.

After linking, Shopify sales and receiving control Shopify inventory. The older
Defy inventory ledger and spreadsheet balance are not continuously reconciled by
this feature. Do not add a starting quantity for stock already counted in Shopify.
Additional deliveries should use the appropriate receiving workflow, not another
QR or another first-save receipt.

TCGplayer links identify cards; their listed prices are not trusted selling
prices. Linking requires an exact, positive Scrydex USD quote. The existing policy
adds 6% for Riftbound singles and uses the raw market price for other supported
games. Manual cards require a positive entered sale price. An unavailable,
unsupported, ambiguous, or nonpositive price blocks readiness instead of
publishing a free item. Entered acquisition cost remains separate from market
price. Existing price-refresh and Defy Pricing behavior remain separate from
initial QR registration.

Pokémon imports can use different catalog labels from Scrydex. The matcher
recognizes a trailing collector number in the card name only when it agrees with
the saved number, and recognizes the verified Scarlet & Violet 151 set label.
These name/set aliases require the exact TCGplayer ID on the selected Scrydex
variant. Plain Foil/Holofoil and Reverse Holo/Reverse Holofoil are equivalent;
named editions remain distinct. English language, collector number, condition,
and a positive USD market quote still have to match. A failed link keeps the
original QR and starting receipt for a safe retry after matching is corrected.

## Recovery and status

The authenticated save routes retain the Defy record before attempting Shopify.
The server loads card identity and the original receipt from the database; clients
cannot choose Shopify product IDs or submit a replacement stock delta. App-owned
Shopify metafields store identity, mapping, lease, adjustment, and status with
compare-and-set writes. No Neon schema change is required.

- **Ready:** Shopify confirmed the matching variant, saved barcode, sale price,
  starting receipt, and POS publication.
- **Pending:** A request is queued, another employee holds its linking lease, or
  Shopify/pricing has not confirmed the result. Retry the same saved QR.
- **Blocked:** Permissions, pricing, identity, or publication needs correction.
  Correct the reported issue and retry the saved QR; do not create another SKU.

Saving triggers a background attempt. The label page can retry unfinished links,
and a server cron provides nightly reconciliation. The current Vercel team uses
the Hobby plan, which allows a cron job at most once daily and may invoke it
within the scheduled hour. This recovery schedule does not promise immediate
completion during an outage. All retry paths preserve the original QR and receipt.

## Connection and one-time release

The server reuses the existing Defy Receiving app and server-only
`SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, and
`SHOPIFY_LOCATION_ID`. Exact pricing also needs `SCRYDEX_API_KEY` and
`SCRYDEX_TEAM_ID`. Scheduled reconciliation uses the existing `CRON_SECRET`.
Never expose these credentials in the browser, extension bundle, Git, or logs.

The existing `shopify-pos/shopify.app.toml` adds `write_publications` alongside
`read_locations`, `write_inventory`, and `write_products`. The write-publications
grant includes publication reads. Backend checks still require the installed app
to have the grant and exactly one identifiable Point of Sale publication.

Release checklist:

1. Validate the application with `npm test` and the Shopify extension package with
   `npm --prefix shopify-pos test`. Build the existing Shopify app and inspect its
   deployment diff, retaining both extension UIDs and all receiving metadata.
2. Commit and push the application changes under the normal Git/Vercel workflow.
3. Obtain the explicit authorization required by [WORKFLOW.md](WORKFLOW.md) before
   the separate `shopify app deploy` release. Release the existing app with the
   added publication scope; do not create another app or run production app dev.
4. Verify the granted scopes using `currentAppInstallation { accessScopes {
   handle } }` with a fresh app token. Shopify documents scope approval during
   release for apps acting only on stores in the same organization; if Shopify
   presents an installation permission update, the owner must approve it.
5. Verify the Point of Sale publication, then retry a saved QR and check the
   complete mapping, barcode, quantity receipt, positive price, and channel state.
   Confirm scanning on the actual POS device after its catalog syncs.

Do not report automatic production linking as active until the application is
deployed, the Shopify app has the publication grant, and verification succeeds.

## Isolated verification

Use `defy-receiving-test.myshopify.com` for Shopify test mutations and the
development Neon branch for any application/database tests. The verified test
location is `gid://shopify/Location/119082418542` (**Shop location**); query it again
before running an integration test. Never substitute the production location or
database. Production remains `n4a7aa-fi.myshopify.com`.

An authenticated Shopify CLI can perform this read-only connection check from
`shopify-pos/` without displaying credentials:

```sh
shopify app execute --store defy-receiving-test.myshopify.com --version 2026-10 \
  --query 'query QrTestConnection { shop { id myshopifyDomain currencyCode } currentAppInstallation { accessScopes { handle } } locations(first: 10) { nodes { id name isActive } } }'
```

Development `.env.local` currently contains the isolated Neon connection but does
not necessarily contain Shopify credentials. Supply test-shop access securely in
the process environment. If the same installed app credentials are reused for a
test, force the test shop and test location before constructing the client, and
verify the authenticated shop domain before any mutation. Do not copy production
database variables into a test process. Clean up only the fixtures created by the
test; leave existing test-store products and receipts intact.

Verification should cover new cards, exact repeated links, simultaneous requests,
an existing Shopify SKU with secondary barcodes, missing pricing or permissions,
and response loss during the first quantity adjustment. Confirm that retries and
reprints preserve variant IDs and never add inventory a second time.

Official references: [Multiple barcodes](https://shopify.dev/changelog/product-variant-barcode-is-being-replaced-by-barcodes),
[metafield compare-and-set](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet),
[publication requirements](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/publishablePublish),
[scope updates](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes),
and [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).
