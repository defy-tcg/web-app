# Customer buylist

The public storefront's **Sell us your cards!** header link opens `/buylist`.
It displays a Pokémon cash buylist alongside cash and store-credit offers for
the ten approved standard English Near Mint Riftbound printings.
Stacked Deck and Hidden Blade are excluded from Riftbound.
Defy uses its normal/nonfoil printing; the other listed cards use foil.
Vex, Apathetic uses the standard Unleashed 150/219 foil printing
(TCGplayer product 685949).

`GET /api/public/buylist` is the only public Defy OS inventory-adjacent endpoint.
It has fixed allowlists in `lib/buylist.ts` and `lib/pokemon-buylist.ts`, accepts
only the optional `game=pokemon` or `game=riftbound` selection and no
card/price/refresh input,
and does not read or mutate inventory, customer records, receipts, or Shopify.
The Sites worker proxies the response to `/api/buylist`. Scrydex credentials and
price calculation remain exclusively on the Defy OS server.

Riftbound offers use verified Scrydex **raw market** cents: 75% cash and 80% store credit,
rounded half up to the cent. The Riftbound retail markup never applies. Only the
resulting offer amounts and public card identity are returned; percentages and
raw market quotes are not displayed. The complete snapshot is cached for 24 hours
and refreshed on demand. Ordinary page loads reuse it rather than issuing fresh
Scrydex requests. Each refresh makes at most ten requests, at concurrency three.
A failed or ambiguous quote is unavailable, without another price feed fallback.
Failures retry at the next daily refresh. Expired offers are hidden in both the
server response and browser while the snapshot refreshes. Final condition and
offer are confirmed in store.

The Pokémon selection contains exactly these English Near Mint holofoil cards:

| Card | Set | TCGplayer product ID |
| --- | --- | --- |
| Mew ex — 053 | Scarlet & Violet Promo Cards | 518871 |
| Mewtwo — 052 | Scarlet & Violet Promo Cards | 518872 |
| Psyduck — 175/165 | Scarlet & Violet 151 | 517035 |
| Pikachu — 173/165 | Scarlet & Violet 151 | 513721 |

`GET /api/public/buylist?game=pokemon` returns only **80% cash** offers calculated
from current verified Scrydex raw USD market cents, rounded half up. It does not
use the website selling price or Pokémon's 1.5% retail markup, and it contains no
store-credit offer. The storefront's `/api/buylist?game=pokemon` proxy passes this
fixed selection through. Pokémon has its own 24-hour snapshot cache and makes at
most four provider requests per refresh, at concurrency three. Its response
includes the game, card identity, condition, language, freshness dates, and
cash amounts; missing or expired quotes have `cashCents: null` and an unavailable
status. It follows the same exact-printing verification and no-fallback policy
as Riftbound. The original endpoint without a game parameter retains the
Riftbound catalog, payout policy, and response shape.

Riftbound discovery includes the exact collector number, set label, and English
language in the same bounded request as its name/marketplace search, because
Scrydex's name index can miss hyphenated names such as Thousand-Tailed Watcher.
The existing selector still verifies complete name, set, number, language,
finish, condition, and marketplace identity. Discovery never changes stock.

Run `npm test` before releasing changes. Test the public response unsigned and
confirm its values, expiry, and exact metadata; authenticated application and
inventory endpoints must remain protected. Publishing website changes uses the
existing Sites source and deployment workflow separately from the OS Git release.
