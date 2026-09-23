# Customer buylist

The public storefront's **Sell us your cards!** header link opens `/buylist`.
It displays cash and store-credit offers for the nine approved standard English
Near Mint Riftbound printings. Stacked Deck and Hidden Blade are excluded.
Defy uses its normal/nonfoil printing; the other listed cards use foil.

`GET /api/public/buylist` is the only public Defy OS inventory-adjacent endpoint.
It has a fixed allowlist in `lib/buylist.ts`, accepts no card/price/refresh input,
and does not read or mutate inventory, customer records, receipts, or Shopify.
The Sites worker proxies the response to `/api/buylist`. Scrydex credentials and
price calculation remain exclusively on the Defy OS server.

Offers use verified Scrydex **raw market** cents: 70% cash and 80% store credit,
rounded half up to the cent. The Riftbound retail markup never applies. Only the
resulting offer amounts and public card identity are returned; percentages and
raw market quotes are not displayed. The complete snapshot is cached for 24 hours
and refreshed on demand. Ordinary page loads reuse it rather than issuing fresh
Scrydex requests. Each refresh makes at most nine requests, at concurrency three.
A failed or ambiguous quote is unavailable, without another price feed fallback.
Failures retry at the next daily refresh. Expired offers are hidden in both the
server response and browser while the snapshot refreshes. Final condition and
offer are confirmed in store.

Riftbound discovery includes the exact collector number, set label, and English
language in the same bounded request as its name/marketplace search, because
Scrydex's name index can miss hyphenated names such as Thousand-Tailed Watcher.
The existing selector still verifies complete name, set, number, language,
finish, condition, and marketplace identity. Discovery never changes stock.

Run `npm test` before releasing changes. Test the public response unsigned and
confirm its values, expiry, and exact metadata; authenticated application and
inventory endpoints must remain protected. Publishing website changes uses the
existing Sites source and deployment workflow separately from the OS Git release.
