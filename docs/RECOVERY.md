# Transfer status

Source: existing production deployment `dpl_HZ3Mac1a42BBAJNxdRTAnqGwZjrf` of
`defy3/defy-store-os`. The older local inventory-only preview was not used.

## Recovered and checked

- All 51 text source files, including complete UI, server routes, schema,
  authentication, import helpers, styles, SVGs, focused tests, package manifest,
  and lockfile, were exported from Vercel's source viewer.
- An independent download of the 4,020-line main application matched the
  recovered file byte for byte. All local imports and client API routes resolve.
- `docs/source-manifest.json` records original source checksums before the
  documented setup-file changes.
- Exact locked dependencies installed with legacy peer resolution; the
  framework versions and `package-lock.json` remain unchanged.
- Six focused tests, ESLint, TypeScript, and the Next.js production build passed.
  Build verification used temporary placeholder Auth configuration, not live
  credentials. It did not connect to a production database.
- Local browser verification confirmed the signed-out redirect, sign-in and
  sign-up screens, and theme toggle. Live login and database mutations were not
  exercised because development credentials are not yet configured.

## Still required before the first release

Five original PNG files could not be exported through the source viewer:

- `public/defy-os-app-icon-source.png`
- `public/defy-os-app-icon.png`
- `public/defy-os-icon-source.png`
- `public/defy-os-icon.png`
- `public/defy-os-logo.png`

The Vercel viewer shows blank/broken image previews and eventually an error;
anonymous app/image URLs return the sign-in page. Failed HTML downloads were
removed rather than stored as PNGs. No substitute artwork was introduced.
Temporary Vercel CLI access was requested to finish exact binary export.
Known source file IDs: app-icon-source
`cf330fcff2237037400766192e0581bc1a7876b0`; app-icon
`364aac26c2680cd6d125699fbdb56ed7a2252f86`.

The original `.env.example` is hidden by Vercel's environment-file preview
restriction. Its local replacement documents all four variables referenced by
the code. Fill an ignored `.env.local` with development values to run locally.

Vercel's Git settings request GitHub app installation; the repository connection
has not been made. Authorize that app for `defy-tcg/web-app`, then connect the
existing project. No commits, pushes, deployments, or database changes were made.

## Local setup additions

Added `.env.example`, `.nvmrc`, `vercel.json`, workflow documentation, and
`AGENTS.md`. Updated `.gitignore` to track only the example environment template
and `.npmrc` to preserve the existing dependency graph during clean installs.
The original historical `DEPLOY_HANDOFF.md` remains as a record of past work.
