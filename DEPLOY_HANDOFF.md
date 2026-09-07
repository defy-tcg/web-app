# Defy Store OS deployment handoff

This package contains the tested, secret-free Next.js source for Defy Store OS.

## Deployment target

- Vercel team: `defy3` (Defy)
- Vercel project: `defy-store-os`
- Target: production
- Framework: Next.js 16 App Router
- Production URL: `https://defy-store-os.vercel.app/`
- Current production deployment: `dpl_8vjA4Lpi3cE4KXk2zBmQmQuWsHVe`

On August 19, 2026, an unrelated eight-file static inventory build
(`dpl_8SahFp1uQmi762NnJhr6kj7oMdsE`) accidentally replaced the full app on the
production aliases. The full authenticated Defy OS source in this package was
rebuilt and restored to both production aliases. Post-deploy checks confirmed
the sign-in page and auth session endpoint, with no runtime errors.

On August 19, 2026, the product-picture pipeline was made database-backed and
deployed. All 71 live product rows now have a stored catalog/image link. The 13
new rows that previously had no picture were matched to verified TCGplayer
products, and all 71 images loaded successfully in the production inventory.
Future add/import/sheet-sync flows use exact, fail-closed catalog matching or an
explicit image URL. Inventory also has a `Picture` correction action with a
preview.

On August 19, 2026, this recovery package was updated with an owner-only
TCGplayer sales CSV importer. The production database migration for
`products.sheet_quantity` was applied and backfilled, and deployment
`dpl_98hinzJFZWcV8YqiPCfs6jndMq7v` promoted the feature to both production
aliases. The importer adds a preview-first Sales workflow, skips
duplicate/canceled/pending orders, records marketplace fees only when the export
contains a fee column, and deducts stock only for exact product matches.
Unmatched products still enter the sales ledger after an explicit warning,
without changing inventory.

On August 19, 2026, deployment `dpl_HJjWzJeE1ycAH3cBwdFYAWPsG3Ms` extended
the sales importer to accept `.xlsx` and `.csv` order files. Excel parsing is
lazy-loaded with exact-pinned `read-excel-file@9.3.10`, preserves numeric order
identifiers and money as text, scans the first 25 rows of each worksheet for the
order header, and safely converts the selected worksheet through the existing
CSV validation pipeline. Workbooks with multiple order worksheets are rejected
instead of guessing. At that deployment, aggregate Sales Summary and Sales Tax
reports were rejected because they do not contain individual order numbers;
the later dedicated Seller Tax summary support below supersedes that limitation.

On August 19, 2026, deployment `dpl_vpVcH1Rrx19st5tGBZHuEczkpM2U` added a
persistent light/night mode. The pre-paint theme initializer uses the saved
device preference or the system color preference without flashing the wrong
theme. Desktop, mobile, authentication, tables, scanner, modals, and importer
surfaces are covered. Thermal-label previews and product-image backings remain
white. The Android WebView inherits the selected theme from the production web
app and stores its preference locally.

On August 19, 2026, deployment `dpl_H45MZPq8E4MCgdKGPF1pjXQgJAEX` refined
night mode around softer charcoal surfaces, a calmer Defy green, clearer
surface elevation, and accessible secondary text. It also fixed dark semantic
styles that previously lost the CSS cascade and exposed pale light-mode
success, error, and warning cards. Desktop/mobile navigation, auth, scanner,
checkout, charts, importer, forms, focus states, and quick actions now share the
same dark palette. Print labels and product-image canvases remain intentionally
white.

On August 19, 2026, deployment `dpl_2aihA9hQ9eB4izXuuZiJt6XoxJMf` added a
dedicated summary path for TCGplayer's exact Seller Tax Report `.xlsx` format.
The supplied `01/01/2025 - 08/19/2026` report reconciled to 89 orders, 3
refunds, $4,364.67 gross product-and-shipping revenue, $78.00 refunds,
$4,286.67 net revenue, and $307.69 net tax. Defy records one protected period
summary, excludes tax from revenue, and creates no item rows, inventory
movements, COGS, fee expenses, or payout data. Imports fail closed on invalid
channels, broken row identities, revised duplicate totals, detailed-order
overlap, partial summary overlap, or an overlap created while committing.
Multi-day summaries appear only when the selected reporting range contains the
entire summary period, are excluded from daily charts, count their represented
orders for average-order value, and mark profit as incomplete wherever they are
included. Other aggregate workbook formats remain unsupported.

On August 19, 2026, deployment `dpl_4CSA6cjenQKrgKUZ8h7Q9QYgYkCr` upgraded
Next.js and `eslint-config-next` from 16.2.6 to patched 16.2.11, removing the
App Router proxy-bypass advisory from the audit. A short-lived AI assistant
introduced in that build was later removed at the owner's request.

On August 19, 2026, deployment `dpl_8vjA4Lpi3cE4KXk2zBmQmQuWsHVe` removed
the Defy AI experiment completely. The chat UI, API route, reporting tools,
assistant styles, model dependencies, AI Gateway configuration, and billing
prompt are no longer part of Defy OS. Inventory, checkout, sales reporting,
TCGplayer `.csv`/`.xlsx` imports, Google Sheets sync, and night mode were kept
unchanged. No assistant chats or database tables existed, so no production
business data required deletion.

## Database and authentication

- Neon project: `defy-tcg-inventory`
- PostgreSQL schema migration has already been applied.
- Neon Managed Better Auth has already been provisioned.
- Authorized owner emails:
  - `nottandao@gmail.com`
  - `setchasertcg@gmail.com`

Required server-only Vercel environment variables:

- `DATABASE_URL`
- `NEON_AUTH_BASE_URL`
- `NEON_AUTH_COOKIE_SECRET`
- `AUTHORIZED_EMAILS`

Do not ask the user to paste credentials into chat. Retrieve the Neon connection and auth values through the connected Neon account, generate a fresh cookie secret if needed, and store all four variables directly in Vercel.

## Verification already completed

- `npm run lint` passed.
- `npm run build` passed.
- Production deployment `dpl_8vjA4Lpi3cE4KXk2zBmQmQuWsHVe` reached READY on
  both aliases. Its build manifest contains no assistant route or AI chunks,
  the canonical stylesheet contains no assistant selectors, authentication
  still protects the app, and the new deployment produced no runtime errors.
- CSV parser checks passed for both order-summary and line-item exports,
  including quoted cells, duplicate order grouping, and date normalization.
- XLSX conversion checks passed for title rows before the header, non-first
  order worksheets, dates, currency precision, quoted cells, generic
  aggregate-report rejection, and ambiguous multi-order-sheet rejection.
- The exact Seller Tax workbook passed browser extraction and server parsing
  with the expected 89 orders, 3 refunds, $4,286.67 net revenue, $307.69 tax,
  no line items, and the 596-day reporting warning. Guard checks covered mixed
  summary/detail rows, unsupported channels, broken reconciliation totals, and
  discount-aware order-summary fallback math.
- Local importer fixture checks passed for preview, duplicate detection,
  unmatched-item warnings, and commit results without writing test sales to the
  production database.
- Production database verification after the baseline migration: 71 products,
  0 missing sheet baselines, and 0 initial quantity mismatches.
- The current production deployment compiled successfully with the TCGplayer
  sales route present in the build manifest. The sign-in page returned HTTP
  200, the app root and importer endpoint remained authentication-protected,
  and both production aliases were assigned without error.
- `/auth/sign-in` rendered locally.
- Unauthenticated `/api/inventory` redirected to `/auth/sign-in`.
- All current source files in this package are tracked and contain no `.env.local` or database passwords.
- Google Sheets master sync completed in production: 55 unique spreadsheet products and 213 units.
- Live production inventory verification: 71 product rows / 273 units, 71
  stored image links, 71 loaded thumbnails, and 0 failed thumbnails.
- The final deployment returned only HTTP 200 responses during verification and
  had no application runtime errors.
- Production night-mode verification confirmed the pre-paint initializer,
  persistent toggle controls, dark stylesheet, protected root redirect, healthy
  auth session endpoint, both production aliases, and zero runtime errors.
- Refined night-mode verification confirmed the production CSS contains the
  calmer palette and corrected high-specificity semantic states. Key text pairs
  meet WCAG AA (muted text 6.63:1, placeholders 4.63:1, selected-state accent
  8.85:1), both production aliases are ready, and the deployment reported no
  runtime errors.
- Android v1.0.1 uses the stable production URL and reloads it on resume, so web deployments appear without rebuilding the APK.
- The layered-card Defy OS logo is deployed across desktop, mobile, authentication, and browser icon surfaces.
- Android v1.0.2 is signed with the existing Defy certificate for an in-place update and includes the matching launcher identity.

## Master spreadsheet behavior

- Syncs on app open, every five minutes while open, and from the Inventory `Sync sheet` button.
- Applies only the spreadsheet quantity change since the previous sync, so a
  TCGplayer sale deduction is not overwritten at the next five-minute sync.
- Updates unit cost and market price from the current sheet values.
- Preserves Defy SKUs, barcodes, TCGplayer links, product images, and custom list prices.
- Adds new products with the next `DEFY-######` SKU only after one exact image
  match; otherwise reports the row for picture review.
- Does not automatically delete catalog products that are missing from the sheet.