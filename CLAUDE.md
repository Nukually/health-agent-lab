# Health Agent Lab contributor guidance

This repository is a standalone H5/Agent technical demonstration. Use synthetic data for tests and demos.

- Keep changes focused; preserve the existing shared/backend/frontend boundaries.
- Configuration and credentials belong in ignored local environment files. Optional external integrations must remain inactive without explicit configuration.
- Centralize features in `packages/shared/src/features.ts`; API responses use `{ success, data?, error? }`.
- Keep native tool calls, shared SSE types, persistence, and frontend rendering consistent. Preserve conversation-prefix stability.
- Server I/O is asynchronous. Never log raw medical data, complete phone numbers, credentials, or verification codes.
- Changes to legal/demo notices must update shared consent versions and retain backend authorization checks.
- Run `pnpm build`, `pnpm test`, and `pnpm check:publication` before committing.
- Database changes: generate migrations, apply to a fresh local database, and verify the actual schema. Keep migration metadata tracked.
- UI changes: inspect the rendered H5 page. Do not publish, deploy, or push unless requested.
- Read `docs/RELEASE_CHECKLIST.md` before preparing a public release.
