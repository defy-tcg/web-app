# Local development, GitHub, Vercel, and Neon

ChatGPT/Codex edits and tests this checkout, then automatically commits its
completed, validated task changes locally. You review the commit and push it to
[defy-tcg/web-app](https://github.com/defy-tcg/web-app). Vercel's Git connection
builds that commit. The application reads and writes its data through Neon
Postgres.

## Connect the existing project

The destination is Vercel team `defy3`, project `defy-store-os`. Its existing
Neon database is already linked. The remaining connection is the GitHub
repository; establish it in the existing project's
[Settings → Git](https://vercel.com/defy3/defy-store-os/settings/git).
Vercel currently shows no available GitHub namespace and requests installation
of its GitHub application. Authorize it for `defy-tcg/web-app`, then connect
that repository here. Once connected, confirm `defy-tcg/web-app` appears as the repository.
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

No sheet, pricing, or cron API key is referenced by the restored source. The
master spreadsheet ID/tab are in `lib/master-inventory-sheet.ts`; pricing and
image matching use public TCGCSV/TCGplayer resources. Authenticated app startup
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

Before its automatic local commit, ChatGPT/Codex runs the applicable checks
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

## Automatic local commits and your release

After completing and validating a task, ChatGPT/Codex reviews the diff, confirms
that secrets and generated files are ignored, and automatically creates a local
commit. It stages only its task changes, selecting specific files or hunks so
unrelated edits and previously staged work stay out of the commit. It reports
the commit hash and validation results when finished.

Review the resulting commit and working tree, then push when you are ready.
For a commit on `main`, run these commands yourself or use GitHub Desktop:

```bash
git show --stat --oneline HEAD
git show HEAD
git status --short
git push origin main
```

Once the repository connection is active, check the Vercel **Deployments** page
for the matching commit and a successful build. Verify the updated production
app after the deployment becomes ready. This workflow uses your GitHub pushes
for releases. ChatGPT/Codex does not push, merge, or trigger a deployment unless
you explicitly request it. No separate CLI production deployment is needed.

For changes that need a deployed preview, push a feature branch, verify its
preview with its Neon branch, then merge it into `main` yourself.

## Database and schema changes

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
