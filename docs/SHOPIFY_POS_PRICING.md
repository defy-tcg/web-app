# Shopify POS pricing from Scrydex

The **Defy Pricing** smart-grid tile looks up a scanned Shopify SKU or barcode,
finds the exact card/printing/condition and verified language in Scrydex, and updates that
existing Shopify variant's customer selling price. Open this tile before scanning;
Shopify's standard search/scanner does not call this integration.

Only Riftbound singles receive the 6% increase, rounded to the nearest cent.
Other supported games and sealed products use the raw USD market price. The
singles intake Review screen continues to show the raw market price. POS shows
only the final customer price. The Shopify variant price is shared with its
connected storefronts; this is not a cart-only override.

## Using the tile

1. In Shopify POS, add **Apps → Defy Receiving → Defy Pricing** to the smart grid.
   Keep the existing Defy Receiving tile for stock intake.
2. Open **Defy Pricing** while online. Scan a SKU/barcode with the connected
   scanner, use the camera button when available, or enter the code and tap
   **Look up price**.
3. Check the identified card and customer price, then tap **Add to cart**.
   The extension waits for the POS catalog to report the same price and checks
   the new cart line. If Shopify has not synced, retry after syncing POS.
4. Use **Next card** to scan another card. If the same variant is already in
   the cart, adjust its quantity there or remove it before requesting a fresh
   price. The extension will not merge a fresh quote into an existing line.

Use the SKU for the exact finish and condition. A printed barcode must encode a
unique existing SKU or a barcode saved on that Shopify variant. Existing cards
with a blank barcode can still be found by SKU; this feature does not rewrite
barcodes or generate labels. Unknown or ambiguous codes, incomplete metadata,
unsupported languages, missing prices, and stale POS prices block automatic
addition. No substitute card or custom-sale line is created.

## Identity and price behavior

The backend searches Shopify by SKU and barcode, exact-filters the results, and
rejects duplicates or truncated searches. It checks the active product, USD shop
currency, and complete card metadata. Canonical and legacy Riftbound single SKUs
can be resolved through the bundled catalog only when their options and saved
metadata agree. Other games require complete Shopify `card` metafields: `name`,
`game`, `set`, `number` (singles), plus matching `language`, `condition`, and `finish`
from the variant options or consistent product metadata. Product type must
identify Single or Sealed, optionally prefixed by its matching game name.

English remains the default. **Pokémon (Japanese)** requires an explicit Japanese
language option and an exact TCGplayer-backed Japanese Scrydex match with a raw
USD price. English printings and yen quotes cannot substitute for that card.

After obtaining a quote, the backend rechecks the Shopify identity and changes
only the existing variant's price. It never receives stock, modifies cost,
creates another listing, or publishes products. The item must already be
available in POS to add it. Cart discounts, taxes, and later manual adjustments
remain Shopify's responsibility.

Scrydex lookups reuse the existing 24-hour Next.js cache policy. This is a lookup
on demand, not a scheduled price sweep or a guarantee of a fresh upstream API
call on every scan. Internet access is required.
The separate [scheduled and manual catalog refresh](SHOPIFY_PRICING.md) remains
available for ordinary Shopify POS scans that use the saved catalog price.

## Authentication and deployment

`POST /api/shopify/pos/pricing` accepts only `{ "code": "..." }`. It validates a
short-lived Shopify session JWT against the configured app's client secret,
client ID, and shop before accessing Shopify or Scrydex. It does not accept a
Neon login cookie or any client-supplied price. Only Shopify extension origins
receive CORS permission. The API has an exact middleware exception and its own
authentication; other inventory routes remain protected by Neon Auth.

Production uses the existing Defy Receiving app on
`n4a7aa-fi.myshopify.com` with its existing `write_products` access. Configure
`SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
`SHOPIFY_LOCATION_ID`, `SCRYDEX_API_KEY`, and `SCRYDEX_TEAM_ID` on the server.
Production credentials belong only in Vercel's Production environment. Use the
separate `defy-receiving-test.myshopify.com` shop for development mutations.
No credentials belong in the extension bundle or Git.

The `shopify-pos/` package is separate from the Next.js dependency lock and uses
Shopify API 2026-07. Its app configuration was linked from the existing app. It
also retains the existing `defy-receiving` extension and UID so publishing the
pricing tile preserves stock intake. Do not remove that extension during release.

```sh
npm test
npm --prefix shopify-pos ci
npm --prefix shopify-pos test
cd shopify-pos
shopify app build
shopify app deploy
```

Git/Vercel deploys the backend; Shopify CLI publishes the POS extension separately.
Release the backend first, then the Shopify extension. Check the deployment diff
for unchanged permissions, receiving UID, and app-managed metadata definitions.
Do not run `shopify app dev` against production or let it replace production URLs.
After publishing, verify a scan and cart price on the physical POS device. Remote
API and controller tests cannot verify the physical scanner or catalog sync delay.

Official references: [Scanner API](https://shopify.dev/docs/api/pos-ui-extensions/latest/target-apis/platform-apis/scanner-api),
[Cart API](https://shopify.dev/docs/api/pos-ui-extensions/latest/target-apis/contextual-apis/cart-api),
[Server authentication and CORS](https://shopify.dev/docs/apps/build/pos/communicate-with-server),
[ID token validation](https://shopify.dev/docs/apps/build/authentication-authorization/id-tokens).
