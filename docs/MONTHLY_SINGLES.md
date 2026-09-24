# Monthly best-selling singles

The private **Reports → Monthly singles** page at
`/reports/monthly-singles` ranks up to 50 Shopify singles by net copies sold in
one calendar month. It reads Defy's Shopify orders, including POS, website, and
other Shopify sales channels. It is separate from the older Defy sales ledger;
combining those ledgers could count the same transaction twice.

The current month is shown by default. Choosing a month or refreshing the report
performs a fresh read. No Scrydex or TCGplayer API calls are involved. The report
does not receive stock, adjust inventory, create orders, or change prices.

## Calculation

- Month boundaries use **America/Los_Angeles**, the verified Redmond shop timezone,
  including daylight saving time. Orders belong to their creation month.
- Paid and partially refunded orders are eligible. Test, cancelled, unpaid, and
  fully refunded orders are excluded.
- Copies sold use Shopify `LineItem.currentQuantity`, which excludes refunded and
  removed units. A later return updates the original order's month when refreshed;
  this is not a cash-flow report grouped by refund date.
- Item sales use Shopify `priceAfterAllDiscountsBeforeTaxesSet`: the remaining
  line's value after all discounts and before taxes. Shipping, fees, costs, and
  order-level refunds not assigned to a line are not allocated to individual cards.
  This value is not profit or the store's accounting net revenue.
- Each Shopify variant is ranked separately, retaining its SKU and variant label.
  Different conditions, finishes, and printings are not merged by card name.
- Explicit product types or singles tags identify singles. Unclassifiable and
  deleted products are reported as exclusions rather than guessed from titles.
- POS and website counts use Shopify's `pos` and `web` order sources; remaining
  sources are shown as Other. Totals include all qualifying singles; the ranking
  displays the top 50.

The backend reads every order and line-item page for the requested month before
returning a ranking. Bounded request time and page limits fail with a clear error
instead of returning a truncated leaderboard. Results include the calculation
time and excluded-record counts. A CSV export contains the displayed ranking.

## Access and release

`GET /api/reports/monthly-singles?month=YYYY-MM` requires the existing authorized
Defy session and returns `Cache-Control: private, no-store`. Responses contain
aggregate card sales, never customer names, addresses, email, or payment data.

The existing Defy Receiving app needs **read_orders**. The Git/Vercel release
deploys the report, but cannot grant this Shopify permission. The prepared
`shopify-pos/shopify.app.toml` retains existing scopes and adds `read_orders`.
After separate authorization, release this existing app through Shopify, approve
its permission update if prompted, and verify the actual granted scopes with a
fresh app token. Until then the report shows **Order access required**, not zero
sales. Inventory synchronization can remain in its current inventory-only mode;
this report performs independent read-only requests.

Shopify normally exposes only the last 60 days of orders. The backend rejects
months starting outside that accessible window unless the installed app already
has `read_all_orders`. This task does not request or grant that wider permission.
The report does not promise a permanent archive of past months; export the CSV
while a month is available. Historical access can be added as a separately
approved extension.

Validate with `npm test` and `npm --prefix shopify-pos test`. Use the development
Neon branch for signed-in app testing and fixture-based Shopify queries for
refunds, pagination, DST, scope gates, and incomplete responses. Production
verification is read-only. Do not create test purchases in the production shop.

References: [Shopify LineItem](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/LineItem),
[Shopify Order](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order).
