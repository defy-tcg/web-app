# Defy TCG Store OS

The Defy TCG application source, recovered locally from the existing production
deployment. It includes inventory, scanner checkout, sales, expenses, tournaments,
reporting, TCGplayer pricing and imports, Google Sheets sync, authentication,
price-label printing, and light/night mode.

**Transfer status:** application code and build checks are complete. Five
original PNG brand assets still require authenticated export from Vercel, and
the Vercel GitHub app needs access to this repository before Git deployment can
be connected. See [recovery status](docs/RECOVERY.md) before the first release.

```text
Local ChatGPT/Codex changes → your GitHub commit and push → Vercel → Neon Postgres
```

You review, commit, and push to [defy-tcg/web-app](https://github.com/defy-tcg/web-app).
The existing Vercel project is [defy-store-os](https://vercel.com/defy3/defy-store-os),
and the production app is [defy-store-os.vercel.app](https://defy-store-os.vercel.app).
Follow [the setup and release workflow](docs/WORKFLOW.md) to connect GitHub and
configure local development. Copying this source does not deploy it or copy the
live database into the repository.

## Preserved stack

Next.js 16.2.11 App Router, React 19.2.6, TypeScript 5.9.3, Tailwind CSS 4.2.1,
Drizzle ORM 0.45.2, Neon Postgres, Neon Auth, the Neon serverless driver, and
`read-excel-file` 9.3.10. Use Node.js 22.13 or newer and `npm ci` to install the
versions recorded in `package-lock.json`. `.nvmrc` selects Node 24, matching the
existing Vercel project. `.npmrc` enables legacy peer resolution for the
deployed Neon Auth dependency graph; framework and locked versions are unchanged.

## Local development

1. Copy `.env.example` to the ignored `.env.local` and fill in development
   database, authentication, and authorized-email values.
2. Use a development Neon branch with the existing schema. This app writes to
   its configured database, including automatic sheet synchronization.
3. Run `npm ci`, then `npm run dev`.
4. Run `npm test` before committing. It runs the focused Node tests, lint, and
   production build.

The deployed source did not include Drizzle migration history. The existing
production database is already provisioned; running migrations is not a setup
step for this copied checkout. See [database changes](docs/WORKFLOW.md#database-and-schema-changes)
before using the preserved `db:generate` or `db:migrate` commands.

## Inventory and scanning

Search and filter inventory by game; add products; edit stock, unit cost, market
price, and list price; import or paste inventory CSV; correct product pictures;
and print Code39 labels at 40×30 or 50×30 mm. New SKUs use game-specific codes,
while existing SKUs and printed barcodes remain usable.

The scanner accepts USB scanner input or typed SKUs/barcodes. Its modes support
lookup, receiving, removal, and checkout. Checkout supports inventory and custom
items, price overrides, discounts, tax, payment methods, and sales channels.

## Master inventory sync

Defy reads the public `Inventory` tab in the configured master spreadsheet on
app open, every five minutes while open, and from `Sync sheet`. It applies the
change in sheet quantity since the last sync so subsequent syncs preserve sales
deductions. It also updates unit cost and market price.

Matching products retain their SKU, barcode, TCGplayer link, image, and custom
list price. New rows require a reliable game and a unique exact catalog image
or an explicit image link. Ambiguous rows are reported for review. Missing sheet
rows are never automatically deleted. The spreadsheet ID and tab are configured
in `lib/master-inventory-sheet.ts`.

Product pictures use an exact TCGplayer product ID or verified HTTPS image URL.
When those are omitted, catalog matching must find one exact name-and-set match.
Blank image fields in later CSV imports preserve existing links.

## TCGplayer sales import and reports

From Sales, choose `TCGplayer file` for per-order `.xlsx` or `.csv` exports.
The importer previews orders, skips duplicates and inactive statuses, and
deducts stock only for exact inventory matches. It searches worksheets for the
order header and rejects ambiguous workbooks.

The exact TCGplayer Seller Tax Report `.xlsx` format is also supported as one
protected period summary. It records net product-and-shipping revenue, refunds,
tax, and represented order count without creating individual order items or
changing inventory. Overlapping detail and summary periods are blocked.
Because summaries omit item costs and marketplace fees, affected reports mark
profit as incomplete. Other aggregate workbook formats remain unsupported.

Overview and Reports include revenue, expenses, profit, stock valuations,
channel/category breakdowns, top products, and CSV export. These use the records
loaded by the app; the existing API limits apply as documented in the workflow.

## Source notes

`public/defy-os-icon.png` supplies the header/favicon mark;
`public/defy-os-app-icon.png` supplies launcher artwork. Existing Android
WebViews use the production site; this repository contains the web application.

`DEPLOY_HANDOFF.md` is the original historical deployment record. Its deployment
IDs, data counts, and past verification statements are not a report of this
local copy or a new release.
