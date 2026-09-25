# Permanent QR codes in Shopify POS

Saving a new TCGplayer card or a manual QR card in DefyOS queues its permanent QR
for Shopify POS. Defy matches the exact existing Shopify card and variant, or
creates the missing listing, saves the QR as a Shopify barcode, and publishes to
the **Point of Sale** channel. Riftbound cards also publish their product and exact
variant to the **Defy TCG website** Headless channel, including manual cards and
special finishes. This does not add other online sales channels. Pokémon and
Pokémon (Japanese) singles are **in-store only**: linking removes their existing and scheduled publications from
every non-POS catalog, then verifies the result. A public site may display these
cards through a read-only catalog feed, but they are not published for online
checkout. Other games keep their existing channel behavior. Production use
requires the one-time Shopify app permission release
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

In **SKU labels → Saved card details → Change inventory**, select **Add copies**
to receive additional stock or **Set total available** to correct the current
Shopify count. A total of zero is allowed. **Refresh count** retrieves the live
count without changing stock. These controls keep the original QR and do not
change the older Defy ledger, cost, price, or original starting-stock receipt.
For multiple labels, select the card to update first. A pending Shopify link must
be resolved before inventory can be changed.

Each inventory change has its own durable receipt. Retrying a lost response or
reloading the page resumes the same request. Absolute totals use Shopify's
`changeFromQuantity` comparison against the count displayed when the total was
entered. If another sale or stock update changes that count, the correction is
rejected; refresh, check the new count, and enter the total again. An uncertain
request keeps its original comparison and idempotency key, so a retry cannot
overwrite a later sale. Unconfirmed requests past the safe retry window require
review rather than a fresh mutation.

TCGplayer links identify cards; their listed prices are not trusted selling
prices. Linking requires an exact, positive Scrydex USD quote. The existing policy
adds 6% for Riftbound singles and uses the raw market price for other supported
games. Manual cards require a positive entered sale price. An unavailable,
unsupported, ambiguous, or nonpositive price blocks readiness instead of
publishing a free item. Entered acquisition cost remains separate from market
price. Existing price-refresh and Defy Pricing behavior remain separate from
initial QR registration.

Riftbound links use a quoted name search bounded by the saved collector number
and English language, alongside the exact marketplace-ID alternative. This
handles provider capitalization such as **Seal of Discord** versus **Seal Of
Discord**, which Scrydex's case-sensitive exact-name search can miss. The lookup
still makes one request and verifies the complete name, set, collector number,
language, finish, and condition before pricing. Other printings, including
Overnumbered cards, remain separate; the 6% Riftbound markup is unchanged.

Some Riftbound Legend records split the character from the printed title. For
example, Scrydex's **Voidreaver** with character **Kha'Zix** can match TCGplayer's
**Kha'Zix, Voidreaver (Overnumbered)** only with the exact selected-variant
TCGplayer ID. The Overnumbered label additionally requires Showcase rarity and
a numeric collector number above the set's printed total, with the complete
printed number verified. Regular, alternate, and Signature printings remain
distinct; a Signature collector number such as **236*/219** cannot supply the
price for **236/219**.

Pokémon imports can use different catalog labels from Scrydex. The matcher
recognizes a trailing collector number in the card name only when it agrees with
the saved number. It also recognizes Pokémon's **Full Art**, **Alternate Full
Art**, **Alt Full Art**, **Alternate Art**, and **Alt Art** name annotations
(including their **Alternate Art Secret** forms),
including when the annotation and collector number appear in either order.
For example, **Umbreon V (Alternate Full Art)** can match Scrydex's **Umbreon V**
only when the exact TCGplayer ID, collector number, set, language, finish, and
condition confirm that printing. A regular-art card cannot supply its price.
**Secret / Secret Rare** and **Rainbow / Rainbow Rare** labels can also differ
from Scrydex's name. These labels require explicit matching Scrydex rarity
metadata as well as the exact selected-variant TCGplayer ID. Missing or
conflicting rarity fields keep the card blocked; art and collector-number
aliases cannot bypass that check.
TCGplayer's Secret label covers both Scrydex **Rare Secret** and **Rare Rainbow**;
an explicit Rainbow label accepts only the latter. Parenthetical collector
numbers such as **(176)** must agree with the saved number, whose full printing
identity is still checked. This keeps rainbow and gold cards distinct even when
their base names are identical.
Other parenthetical labels, such as Promo, First Edition, or stamped editions,
remain part of the required identity instead of being removed indiscriminately.
English Pokémon set labels such as **SV: Black Bolt** match
Scrydex's **Black Bolt** automatically when their exact set title, series prefix,
and marketplace ID agree. Known series prefixes (SV, SWSH, SM, XY, BW, ME) and
full series names are supported; a numbered prefix must also identify the same
Scrydex expansion. New sets following these conventions do not need a per-set
code change or extra discovery requests. Exceptional existing 151, promo, and
Mega Evolution aliases retain their stricter verified metadata checks.
Colons separating a set and its gallery are treated as spaces when comparing
their complete titles: **SWSH: Crown Zenith: Galarian Gallery** can match
**Crown Zenith Galarian Gallery**. Every title component remains required, so a
gallery cannot silently match its main set or a different gallery.
English Pokémon searches include the saved collector number and language, plus
an exact marketplace-ID alternative, so common names such as Pikachu do not
overflow the result limit before identity verification.
Ancient Mew is a verified exception for an unnumbered promo: TCGplayer product
**108589** uses catalog number **1** in **Miscellaneous Cards & Products**, while
Scrydex record **miscp-1** uses **Miscellaneous** and explicit null collector
numbers. This mapping pins the exact card, Promo rarity, expansion metadata,
English language, and selected-variant marketplace ID. Its search adds the known
name and expansion in the same request. It does not relax number checks for
other cards or combine the English promo with Japanese printings.
Pokémon Center Exclusive promos retain their stamped edition when TCGplayer
calls the finish Foil. The exact TCGplayer ID must belong to Scrydex's
`pokemonCenterStamp` variant, with the same name, set, collector number,
language, and condition. For example, Eevee #173, TCGplayer **610757**, uses
its stamped quote; the regular holofoil version **610758** cannot supply its price.
**Mew ex - 205/165 (151 Metal Card)**, TCGplayer **519481**, similarly requires
Scrydex's exact `sv3pt5-205` metal variant. TCGplayer's Normal finish for this
metal card does not select the regular holofoil printing. Base Set cards saved
as Normal can select Scrydex's `unlimited` variant only with the exact variant's
TCGplayer ID and verified Base expansion metadata; First Edition and Shadowless
remain separate. Verified set aliases also cover Mega Evolution promos,
McDonald's 2023 promos, and Wizards Black Star Promos without dropping the
edition or year from their identity checks.
These name/set aliases require the exact TCGplayer ID on the selected Scrydex
variant. Plain Foil/Holofoil and Reverse Holo/Reverse Holofoil are equivalent;
named editions remain distinct. Verified language, collector number, condition,
and a positive USD market quote still have to match. A failed link keeps the
original QR and starting receipt for a safe retry after matching is corrected.

If the wrong catalog card was saved, load its blocked label and use **Correct
catalog details**. Review the replacement TCGplayer card, finish, and verified
price before confirming. This correction is available only before Shopify
product creation or stock transfer has begun. The server keeps the original QR,
condition, quantity, cost, location, and initial receipt, rejects duplicate saved
variants, and retains a recoverable correction intent across interrupted requests.
After correction, retry the Shopify link using the same QR. An existing or
uncertain Shopify product cannot be relabeled through this flow.

Gundam imports recognize trailing **C**, **U**, **R**, and **LR** rarity labels,
with or without **+**, only when Scrydex confirms the base rarity and exact
TCGplayer product ID. A **+** card saved as Foil can use Scrydex's **altArt**
variant only when that variant owns the exact product ID and its printing
metadata identifies exactly one matching expansion. For example, **Amuro Ray
(R+)**, GD05-085, uses its alternate-art quote, never the regular holofoil quote.
Set, card number, language, condition, and positive USD price still have to match.
This rule does not turn Foil into a general alias for beta or premium editions,
and it does not modify the saved QR, finish, or starting-stock receipt.
The word **Gundam** is preserved in actual unit names; only an explicit
game prefix followed by a colon is removed for matching.

Pokémon Japan (TCGplayer category 85) is saved as **Pokémon (Japanese)**,
separately from English Pokémon. Japanese pricing requires the exact marketplace
ID, Japanese provider metadata, verified English name translation, printing,
finish, condition, and a native USD quote. Yen prices are never converted or used
as USD. Verified Japanese 151 and SV9 Battle Partners set labels are supported,
with both native and translated set names checked. Shopify receives an
explicit **Japanese** language option, which status, stock, and price refreshes
must continue to match.

Retrying an older Japanese QR saved under Other verifies its TCGplayer category
and complete card identity before correcting only its saved game. An old
English-language linking journal may be corrected only before any product,
variant, creation, or stock intent exists. Its QR, original quantity, and stock
request key remain fixed; existing English mappings require review.

## Recovery and status

The authenticated save routes retain the Defy record before attempting Shopify.
The server loads card identity and the original receipt from the database; clients
cannot choose Shopify product IDs or submit a replacement stock delta. App-owned
Shopify metafields store identity, mapping, lease, adjustment, and status with
compare-and-set writes. No Neon schema change is required.

Library status reads check up to 20 saved journals at a time and verify live
variants in groups of five to stay within Shopify's request budget. A failed
request affects only that group: other confirmed results and specific saved
blockers remain visible. Unverified cards show no stale price, stock count, or
verification timestamp. Status reads never create products or receive stock.

- **Ready:** Shopify confirmed the matching variant, saved barcode, sale price,
  starting receipt, and POS publication. Riftbound also requires live website
  publication of both the product and exact variant. Missing website publication
  becomes pending so the existing retry and nightly recovery can restore it using
  the same QR and stock receipt. Pokémon singles have no current or scheduled
  non-POS publication.
- **Pending:** A request is queued, another employee holds its linking lease, or
  Shopify/pricing has not confirmed the result. Retry the same saved QR.
- **Blocked:** Permissions, pricing, identity, or publication needs correction.
  Correct the reported issue and retry the saved QR; do not create another SKU.

Saving triggers a background attempt. The label page can retry unfinished links,
and a server cron provides nightly reconciliation, including blocked pricing
matches. Once matching or Scrydex data is corrected, these saved cards can link
on a later pass without another SKU or receipt. Recovery processes at most 12
cards per run, so larger backlogs can take multiple nights; Scrydex responses
remain cached for up to 24 hours. The current Vercel team uses
the Hobby plan, which allows a cron job at most once daily and may invoke it
within the scheduled hour. This recovery schedule does not promise immediate
completion during an outage. All retry paths preserve the original QR and receipt.

Pokémon channel verification covers APP, MARKET, COMPANY_LOCATION, and NONE
catalog types, including scheduled publications. An incomplete publication list,
failed removal, or changed card identity prevents readiness. Library status and
stock receiving only check this policy; they never unpublish a product. If a card
is later published outside POS, retry its saved link to restore in-store-only
sales. Repeated policy enforcement leaves its QR, original stock receipt, and
POS publication intact. This policy does not apply to sealed products.

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
[publication removal](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/publishableUnpublish),
[scope updates](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes),
and [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).
