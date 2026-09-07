# Defy TCG workflow

- Make and validate application changes locally in this repository.
- Preserve the existing Next.js, React, Tailwind, TypeScript, Drizzle, Neon Auth,
  and Neon Postgres architecture and the complete store functionality.
- Automatically commit and push completed task changes after appropriate
  validation. The user has given standing permission for these GitHub pushes
  and the Vercel deployments they trigger. Stage only changes made for the task;
  leave unrelated user work untouched. Report the commit hash, push result, and
  any remaining limitations.
- Do not force-push, merge, or trigger a separate manual deployment unless the
  user explicitly requests it.
- Vercel deploys from the connected `defy-tcg/web-app` repository. Use the
  existing `defy3/defy-store-os` project and its existing production data.
- Keep secrets in ignored `.env.local` locally and in Vercel environment
  variables remotely. Commit only the placeholder `.env.example`.
- Use a development Neon branch for interactive testing. Loading the signed-in
  app automatically writes through master-sheet sync.
- Run `npm test` for application changes. Keep the locked dependency versions;
  `.npmrc` supplies the resolution needed by the existing Neon Auth packages.
- The recovered source has schema definitions but no migration history.
  Establish a reviewed baseline before applying schema changes to existing data.
- Follow `docs/WORKFLOW.md` for setup and releases.
