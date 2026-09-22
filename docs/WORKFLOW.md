# Local development, GitHub, Vercel, and Neon

ChatGPT/Codex edits and tests this checkout, then automatically commits and
pushes its completed, validated task changes to
[defy-tcg/web-app](https://github.com/defy-tcg/web-app). The user has given standing
permission for these commits and pushes, including the Vercel deployments those
pushes trigger. Vercel's Git connection builds the pushed commit. The application
reads and writes its data through Neon Postgres.

## Existing project connection

The destination is Vercel team `defy3`, project `defy-store-os`. Its existing
Neon database and GitHub repository `defy-tcg/web-app` are linked. The Git
connection was verified on September 18, 2026, with `main` as the production
branch. Check the existing project's
[Settings → Git](https://vercel.com/defy3/defy-store-os/settings/git) if a push
does not produce a deployment.

If repository access needs repair, authorize the Vercel GitHub application for
`defy-tcg/web-app` and verify the correct GitHub account is connected under
[Vercel Account → Authentication](https://vercel.com/account/settings/authentication).
Both the app's repository access and the Vercel user's GitHub connection must be
in place before reconnecting the repository in the existing project.
[Vercel GitHub documentation](https://vercel.com/docs/git/vercel-for-github)

Use the repository root, the **Next.js** framework preset, `npm ci` for install,
`npm run build` for build, and the default Next.js output settings. Keep the Node
runtime on Node 24 to match `.nvmrc` and the existing Vercel project. In **Settings → Environments
→ Production → Branch Tracking**, select `main`. A push to `main` creates a
production deployment; other branches receive previews.
[Vercel Git deployments](https://vercel.com/docs/git)

## Environment setup

The source uses these server environment variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection for the selected environment |
| `NEON_AUTH_BASE_URL` | Neon Auth endpoint for that environment |
| `NEON_AUTH_COOKIE_SECRET` | Secret used to protect authentication cookies |
| `AUTHORIZED_EMAILS` | Comma-separated emails permitted to use the store |
| `SCRYDEX_API_KEY` | Server-only Scrydex API credential |
| `SCRYDEX_TEAM_ID` | Team identifier required with every Scrydex API request |

The source has existing owner-email defaults, but set `AUTHORIZED_EMAILS`
explicitly for each environment. None of these variables belongs in a
`NEXT_PUBLIC_` variable or in a Git commit.

Keep the existing values for Production in Vercel. Give Development and Preview
their own Neon branches and corresponding Auth settings. With preview branching
enabled, the Neon integration can provide separate database and authentication
endpoints for preview deployments. [Neon preview databases](https://neon.com/blog/neon-vercel-native-integration),
[Neon Auth on previews](https://neon.com/blog/auth-that-just-works-in-vercel-previews)

For local development, copy `.env.example` to `.env.local` and fill it with
development values. Neon connection details come from **Connect** in the Neon
Console. Environment variables in Vercel are scoped to Production, Preview, or
Development, and changes apply to subsequent deployments.
[Neon connection setup](https://neon.com/docs/guides/vercel-manual),
[Vercel environment variables](https://vercel.com/docs/environment-variables)

The master spreadsheet ID/tab are in `lib/master-inventory-sheet.ts`; image
matching and the bundled Riftbound catalog use public TCGCSV/TCGplayer resources.
Price refreshes and singles intake use Scrydex's raw USD market prices. Only
Riftbound singles receive a 6% customer selling-price markup; other games and
product types, including Riftbound sealed products, sell at the raw market price.
Intake review shows unmarked market prices. Both Scrydex credentials are required;
never expose them through client props, logs, or `NEXT_PUBLIC_` variables. Requests cache price
data for 24 hours. A failed or ambiguous match never substitutes another feed.
The existing Shopify retry cron uses the server-only `CRON_SECRET`.
The Shopify POS **Defy Pricing** tile uses the same Scrydex policy and the
existing Defy Receiving app credentials. Its authenticated backend updates
Shopify variant prices; the separate Shopify extension release and device setup
are documented in [SHOPIFY_POS_PRICING.md](SHOPIFY_POS_PRICING.md).
The existing **Receive sealed stock** tile records quantity and acquisition cost
in Shopify. DefyOS shows its stock and immutable receipt history in **Shopify
stock & receiving**; see [SHOPIFY_POS_RECEIVING.md](SHOPIFY_POS_RECEIVING.md).
Inventory-only sync uses the app's existing product/inventory permissions, with
`SHOPIFY_SYNC_ORDERS_ENABLED=false`; it does not import order history or combine
Shopify quantities with the older spreadsheet inventory.
Authenticated app startup
automatically triggers a sheet-sync write after 2.5 seconds and every five
minutes. Use development data for local interaction tests; change the sheet
source in a development-only change if test inventory must differ from the
existing master sheet.

## Edit and verify locally

```bash
npm ci
npm run dev
```

Open the local URL printed by Next.js. Use the development Neon Auth endpoint
with the local origin configured and sign in with an authorized account.

Before its automatic commit and push, ChatGPT/Codex runs the applicable checks
(`npm test` for application changes) and reviews the diff and working tree:

```bash
npm test
git diff
git status
```

`npm test` preserves the original sequence: focused Node tests with TypeScript
stripping, ESLint, then the production build. The focused tests cover game
normalization, SKU compatibility, CSV identity, and inventory matching. Exercise
the screens affected by your change as well. Authentication configuration is
required to initialize the server; the local environment must be set even when
only building.

The original Neon Auth dependency graph has peer-version conflicts. The project
`.npmrc` uses `legacy-peer-deps=true` so `npm ci` installs the recovered lock
without changing framework or dependency versions.

## Automatic commits, pushes, and Git deployments

After completing and validating a task, ChatGPT/Codex reviews the diff, confirms
that secrets and generated files are ignored, and automatically creates a local
commit and pushes it to the corresponding branch on `origin`. It stages only
its task changes, selecting specific files or hunks so unrelated edits and
previously staged work remain untouched and stay out of the commit. Before
pushing, it checks the commits being sent and does not include unrelated local
commits without explicit authorization. No additional permission is needed for
these task commits, pushes, or the Vercel deployments those pushes trigger.

For a completed task on `main`, the review and push sequence includes:

```bash
git show --stat --oneline HEAD
git show HEAD
git status --short
git push origin main
```

Once the repository connection is active, ChatGPT/Codex checks the Vercel
**Deployments** page for the matching commit and a successful build. It verifies
the affected app behavior after the deployment becomes ready, using a development
Neon branch for interactive tests that write data. It reports the commit hash,
validation results, push and deployment status, and any remaining limitations.
If the Git connection is unavailable, it reports that the push has not produced
a verified deployment.

This workflow uses GitHub pushes for releases. Force pushes, merges, and separate
manual or CLI deployments require an explicit request. For changes that need a
deployed preview, ChatGPT/Codex pushes a feature branch and verifies its preview
with its Neon branch. Merging that branch into `main` remains a separate action.

## Database and schema changes

### Custom QR SKU inventory

The authenticated `/sku-labels` page saves linked-card QR codes automatically and
keeps **Save to Inventory & Print** for manually generated drafts. Both save paths
queue the permanent QR for automatic Shopify POS linking. Game, name, set, card
number, condition, and finish identify a manual card variant; linked cards use
their exact TCGplayer product ID, condition, and finish. Identical copies share
one QR. The print-copy count does not change stock. See
[QR codes and Shopify POS](QR_SHOPIFY.md) for the linking, initial-stock transfer,
pricing, recovery, and one-time Shopify permission release prerequisites.

**Add a single from TCGplayer** accepts a full HTTPS TCGplayer product link,
loads its exact card identity and image, and checks fresh shared inventory.
Existing variants automatically select their original QR for the preview, PDF,
and print output, with one copy by default. Saved conditions and finishes can be
selected directly. Lookup alone never receives stock or writes to Shopify;
**Use saved QR** can confirm or repair the existing link. While loading, after a
failed lookup, or for an unsaved variant, the previous QR is not printable.
Clearing the link restores the previous batch, including unsaved manual drafts.
After the operator chooses condition and finish, **Save QR & link Shopify**
reserves its permanent SKU in shared inventory and replaces the print batch with
that one confirmed label. The authenticated, read-only
`POST /api/sku-labels/lookup` reads TCGplayer's public product-details endpoint
and TCGCSV's source-listed finishes with bounded timeouts and 24-hour caching.
It uses fixed upstream hosts and validated product IDs; it never fetches a
user-supplied URL or uses catalog prices. If finish lookup is unavailable, the
operator must enter the physical card's finish. Sealed and accessory links are
rejected. Games outside the registry are labeled **Other** with an explicit
notice. Catalog availability determines link coverage; manual entry remains
available for cards that cannot be looked up.

Saving a linked card selects its one confirmed label and retains full names up to 240
characters, while printed names remain shortened to fit the label. Cards
without a printed number can use their TCGplayer product ID. Named finishes
and editions remain distinct; known Foil/Holofoil, Normal/Nonfoil, and
Reverse Holo/Reverse Holofoil aliases share duplicate detection. Importing a
saved custom variant loads its original SKU for reprints; existing legacy SKUs
are identified for stock management in Inventory. A new linked card defaults to
zero starting quantity; staff can enter its actual starting quantity on first
save. Shopify receives that original quantity once. Linked-card selling prices
come from an exact Scrydex quote under the existing pricing policy; manual cards
need a positive entered selling price. Clearing the current batch, retrying a
save, and reprinting do not receive more stock.

The label preview's **Add cards to inventory** panel receives additional copies
of a saved card. Enter **Number of cards to add**, then choose **Add stock**.
This is an additive receipt against the live Shopify location, not an absolute
stock count. **Copies per SKU** only controls printing. Starting quantity still
transfers once on first save; looking up an existing link or reprinting never
creates an additional receipt. Multi-card batches require choosing the card
whose stock is being received.

`POST /api/sku-labels/stock` authenticates a same-origin request and loads the
saved QR from Defy. It requires a verified live Shopify link and a confirmed
original starting-stock transfer. A separate Shopify app-owned receipt pins
the request ID, card identity, variant, inventory item, location, and quantity.
CAS and Shopify's idempotency key protect retries; an unconfirmed mutation
outside the safe retry window requires review. This path only adds stock and
does not rewrite selling prices, unit costs, barcodes, or sales channels. It
leaves the original Defy inventory record and initial receipt unchanged; the UI
shows Shopify's available count.

The browser saves a stock request before sending it and retains its original
card and quantity across a lost response, reload, or label change. **Retry stock
addition** uses the same request until Shopify confirms its result. New stock
requests require an explicit click. A damaged or unavailable browser receipt
store blocks new submissions instead of risking an unrepeatable addition.

`POST /api/sku-labels/reserve` authenticates and validates one linked card, then
atomically reuses its saved variant or creates a product and its original
starting-quantity movement in the existing schema. It uses the same products write lock and timeouts as batch saves, so
concurrent requests receive one original SKU. A browser draft's SKU is preferred
when first saving that card, preserving labels already printed from the draft.
The numeric TCGplayer product ID, condition, and normalized finish identify a
linked variant regardless of game-category changes, URL slug, or tracking query
parameters. A matching older unlinked card receives the catalog ID while retaining
its SKU, stock, and prices, so later catalog spelling changes still reuse it.
If older data already contains multiple matching products, the earliest saved
record supplies the original SKU; reservations do not merge or delete those rows.
Unconfirmed requests retain their proposed SKU for retries; a server-confirmed
saved variant always takes precedence. An existing variant never receives a new
starting-quantity movement from a repeated link. The shared
saved-label library includes zero-stock cards and works on another signed-in
device with empty browser storage.

`POST /api/sku-labels` validates the entire batch and atomically creates products
with their initial inventory movements using the existing schema. Retrying a
saved SKU with the same identity reuses it without changing stock or prices;
SKU, barcode, and existing-variant conflicts reject the batch. The transaction
uses a short products write lock with a five-second lock timeout and a
15-second statement timeout. Saved-label reprints only read inventory and keep
the original SKU. Shopify links use an app-owned durable journal and the original
Defy starting-quantity movement, not the card's later inventory balance. Retries
resume that same receipt instead of adding stock again. Custom-label singles are excluded from master-sheet matching
and retirement, even if their pricing source later changes.

Manual drafts are kept in browser storage. Saved labels are loaded from the shared
inventory database and can be reprinted from another signed-in device. Each card
shows whether Shopify POS is ready, pending, or blocked, with a retry action that
keeps the original QR. Saving starts a background attempt; nightly reconciliation
recovers unfinished links within the current Vercel Hobby cron limits. Production
activation additionally requires the approved Shopify app release granting
`write_publications`; a Git deployment alone does not grant that permission.
Physical printing still uses the browser print dialog or downloaded 38 × 13 mm PDF;
saving does not depend on a printer connection or a completed print job.

For thermal labels, set the paper width to **38 mm across the roll** and height
to **13 mm in the feed direction**, at **100% / actual size**, with no margins,
headers, or footers. If Mac Chrome prints sideways or spans several labels,
choose **More settings → Print using system dialog** (**Option + Command + P**),
select the **38 × 13 mm** paper preset, and use **Portrait** with no additional
rotation. The browser cannot force the printer's orientation. Print and scan
one test label before a batch; the downloaded PDF can also be printed in Preview
with these settings.

Mac Chrome can normalize custom paper sizes to short-edge-first, turning a native
38 × 13 mm stock size into 13 × 38 mm. Changing the artwork or printing the PDF in
Chrome does not correct that printer-media setting. The macOS system dialog with
the **Defy 38x13 Upright** preset has been physically verified on the store printer.
Chrome's supported `DisablePrintPreview` preference can make Print open that
dialog directly; it affects Chrome printing generally and requires a browser
restart, so obtain the operator's agreement before changing that local preference.

### Schema baseline

Inventory, sales, expenses, events, and authentication data persist in Neon
independently of Git and Vercel builds. This checkout contains source and schema
definitions, not a copy of production records. Keep Production pointed at the
existing Neon branch to retain its data.

The recovered deployment includes `db/schema.ts` and `drizzle.config.ts`, but
no `drizzle/` migration journal or SQL history. Do not run `db:generate` followed
by `db:migrate` against the existing database as an initial setup: without its
history, generated SQL may try to recreate existing tables. Recover or establish
a reviewed baseline first. A Neon branch of the existing database can supply
the current schema for development while that history is reconciled.

The preserved `db:generate` and `db:migrate` scripts remain available for future
schema work. `drizzle.config.ts` reads `DATABASE_URL` from the process environment;
it does not load `.env.local` itself. Use an environment-loading runner or supply
the variable securely when running these scripts. Test migrations on a
development branch and commit the reviewed schema, SQL, and journal changes.
A code rollback does not undo database changes.

## Existing functional limits

The reporting API loads up to 1,000 sales, 5,000 sale items, 1,000 expenses, and
500 events. Reports and exports reflect the loaded records, including when
`All time` is selected. Seller Tax summaries intentionally show incomplete
profit because they omit costs and marketplace fees. Scanner input supports
USB/keyboard barcodes; camera scanning is not implemented.

Keep `DEPLOY_HANDOFF.md` as historical context. Its old production deployment
IDs, record counts, and verification results should not be read as current
state or confirmation of a new deployment.
