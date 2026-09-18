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

## Original image assets restored

All five original PNG assets were downloaded on September 18, 2026 through the
authenticated Vercel CLI API from the original deployment above. Each decoded
file has a valid PNG signature and its SHA-1 exactly matches the deployment's
source manifest file ID. The files are restored unchanged under `public/`:

| File | SHA-1 |
| --- | --- |
| `defy-os-app-icon-source.png` | `cf330fcff2237037400766192e0581bc1a7876b0` |
| `defy-os-app-icon.png` | `364aac26c2680cd6d125699fbdb56ed7a2252f86` |
| `defy-os-icon-source.png` | `7d2a695d8215f6f5882c99a995324e9a5f06ffa7` |
| `defy-os-icon.png` | `9d38af88a1bba7ae78dab6168f97cbd4473c6acc` |
| `defy-os-logo.png` | `b4678bff33d20be7c0f103367aaa6a10b3c5a6db` |

This resolves the original image-export blocker without substitute artwork.
The recovery itself did not deploy the application or change production data.

## Remaining setup and initial recovery history

The original `.env.example` is hidden by Vercel's environment-file preview
restriction. Its local replacement documents all four variables referenced by
the code. Fill an ignored `.env.local` with development values to run locally.

Vercel's Git settings request GitHub app installation; the repository connection
has not been made. Authorize that app for `defy-tcg/web-app`, then connect the
existing project. No commits, pushes, deployments, or database changes were made
during the initial recovery. The recovered files were subsequently committed in
`cdfb430` (`Program Commit`). The current commit and release policy is documented
in `WORKFLOW.md`.

## Local setup additions

Added `.env.example`, `.nvmrc`, `vercel.json`, workflow documentation, and
`AGENTS.md`. Updated `.gitignore` to track only the example environment template
and `.npmrc` to preserve the existing dependency graph during clean installs.
The original historical `DEPLOY_HANDOFF.md` remains as a record of past work.
