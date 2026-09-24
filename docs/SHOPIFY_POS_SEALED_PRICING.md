# Pokémon sealed prices in Shopify POS

The **Pokémon Sealed** tile checks a manufacturer's printed barcode or SKU
against an exact Scrydex sealed product and displays its latest available USD
market price. Hardware scanning, the device camera, and manual code entry work
inside the tile. Open the tile before scanning.

## At the counter

1. Add **Apps → Defy Receiving → Pokémon Sealed** to the POS smart grid after
   the Shopify extension release.
2. Scan the manufacturer barcode. A saved match or verified existing Shopify
   identity returns the price, product, set, packaging, image when available,
   and the time the quote was fetched.
3. For an unrecognized code, search by product name. Choose the exact package
   and confirm it before saving the match. Future scans on devices using the
   same app installation reuse that match.
4. **Refresh price** fetches again. **Change matched product** lets staff
   confirm a correction. **Next product** clears the current lookup.

Check the physical package: packs, boxes, bundles, displays, and cases are
different products. Some assortments share one barcode across different tin or
box designs. One code remembers one match; verify the displayed identity each
time and do not treat shared codes as unique identifiers of the contents.
Valid UPC/EAN leading-zero forms share a match; a nonzero GTIN-14 case indicator
stays distinct. Arbitrary SKU text preserves case and leading zeroes.

This version supports **English Pokémon sealed products with one normal edition
and an unambiguous raw USD market price**. Japanese, multi-edition vintage, and
products without usable prices return an unavailable result. Failed lookups
never substitute another product, zero price, or another pricing provider.

Name search accepts a leading `Pokemon` / `Pokémon` (and optional `TCG`)
and matches the remaining words across the product name, set name, and package
type. The year and package words remain required. A standalone product with
explicit English language metadata but no expansion displays **No set listed**;
staff still confirm its exact product and package before saving the barcode.
Missing language, conflicting language, and unsupported editions remain excluded.

## Price freshness

Every successful scan, confirmation, and refresh retrieves the exact product
with `include=prices` and `cache: "no-store"`, bypassing Defy's ordinary 24-hour
catalog cache. The displayed timestamp describes when Defy fetched the quote;
Scrydex determines when its underlying market data changes. Internet access
and Scrydex API credits are required. Search previews keep their existing cache,
and confirming a match obtains a fresh price.

Server logs record `scrydex.sealed.search` result counts to distinguish an empty
Scrydex result from products excluded by validation. These logs omit search
text, barcodes, product data, and credentials; they are not API billing counters
because catalog responses may be cached.

Checking a price does not change Shopify selling prices, inventory, acquisition
costs, or the cart. Keep **Defy Pricing** for the existing selling-price/cart
workflow and **Receive sealed stock** for stock intake.

## Matching and security

Scrydex documents product IDs and name search, not manufacturer barcode lookup.
The checker resolves a staff-confirmed mapping first, then looks for an exact
Shopify SKU/barcode and coherent English Pokémon sealed metadata. Existing
Receiving links use `$app:receiving.catalog_id = scrydex:pokemon:<id>` and
`card.scrydex_id`. Duplicate or truncated Shopify barcode results require review.

Confirmed matches use individual JSON app-data metafields on the existing app
installation, namespace `defy_sealed_prices`, keyed by a hash of the canonical
code. Only the owning app can access them. Shopify `compareDigest` prevents
concurrent overwrites; retrying an already completed confirmation reuses its
mapping. Uninstalling the app can remove installation-owned data. No Neon schema
change is required.

`POST /api/shopify/pos/sealed-pricing` accepts either:

```json
{ "action": "scan", "code": "012345678905" }
```

```json
{ "action": "link", "code": "012345678905", "id": "me1-s1", "expectedId": null }
```

For a correction, `expectedId` is the previous app-saved Scrydex ID. Use null
for the first app-saved match, including overriding an inferred Shopify match.
Device-supplied prices, game changes, and unknown fields are rejected. Existing
Shopify session JWT verification precedes provider access and mapping writes.
CORS permits only supported Shopify extension origins; responses disable caching.
The exact route bypasses Neon login middleware and authenticates independently.

Existing server credentials are reused: `SHOPIFY_SHOP_DOMAIN`,
`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_LOCATION_ID` (required by
the shared transport), `SCRYDEX_API_KEY`, and `SCRYDEX_TEAM_ID`. Secrets remain
in ignored `.env.local` and Vercel variables. No additional scope or product
metafield definition is required. Barcode connections use the existing 2026-10
Admin API path.

## Validation and release

```sh
npm test
npm --prefix shopify-pos test
```

Git push releases the backend through Vercel. The native tile also requires an
explicitly authorized Shopify app release. Build and release from the existing
linked app, preserving Receiving and Defy Pricing and their UIDs. Exclude any
unrelated pending permission changes. Shopify CLI assigns the new extension's
UID on first release; retain it in source.

Before counter use, verify hardware/camera scans, unknown-code confirmation,
refresh, and repeat scanning on another device in the development shop. API and
controller tests cannot emulate the native POS host. Use development Neon data
if opening the authenticated Defy web app because startup triggers inventory
sync. The checker itself has no Neon database writes.

References: [Scrydex sealed API](https://scrydex.com/docs/pokemon/sealed),
[pricing data](https://scrydex.com/docs/getting-started/prices),
[Shopify Scanner API](https://shopify.dev/docs/api/pos-ui-extensions/latest/target-apis/platform-apis/scanner-api),
[app-data metafields](https://shopify.dev/docs/apps/build/metafields), and
[compare-and-set](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet).
