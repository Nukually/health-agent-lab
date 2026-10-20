# Candidate validation — 2026-10-20

Verified locally with Node.js 26.0.0, pnpm 11.21.0 and PostgreSQL 16 (pgvector image):

- Frozen-lockfile dependency installation completed.
- `pnpm build`: passed for shared, backend and frontend.
- `pnpm test`: 618 passing tests across all 110 retained test files (546 backend/shared + 72 frontend), no failures or skips.
- Unconfigured doctor/RAG integrations have no built-in URL or credential. Regression tests verify unconfigured RAG performs no network request.
- `pnpm db:generate`: a second run reports no schema changes.
- Fresh database migration: one baseline applied; all 49 tables checked column by column, including vector and pg_trgm extensions.
- Backend health and H5 client-experience proxy: HTTP 200.
- Browser verification: neutral branding, demo notice and data-handling notice render correctly. No agreement accepted or real user data entered for this check.
- Publication pattern check and Gitleaks 8.30.1 scans of distributable source and the new Git history: passed. Company/brand and internal-address review found no remaining original identifiers in the selected source files.
- The source checkout was left unchanged. The new repository contains no source-project Git history.

## Test cleanup before publication

- Removed the six tests for the dormant intervention-effect-followup policy. Its scheduler is not registered or called by the application; the unrelated implementation was left unchanged.
- Removed the layout assertion for the historical UI release that is not distributed in this edition. Client-environment transport coverage now uses the current release.
- Kept tests for active H5/Agent behavior, authorization, compatibility parsing and configurable integrations.
- Replaced the old App invitation fixture with a reserved `.test` URL. The invitation identifier was also replaced in both unpublished commits before the first push.
- Re-ran the complete build and test suite after cleanup. No tests are skipped or excluded to obtain a passing result.

## Scope and remaining review

The runtime smoke check uses a synthetic model key and unreachable local model endpoint; it does not certify real inference, OCR, external RAG, SMS, voice or Push integrations. Configure your own providers to test those features.

The frontend emits a large-chunk warning; Node.js emits a module registration deprecation notice. These did not fail build or tests.

`buffers@0.1.1` has no license declaration/file in its installed package, and optional native image dependencies carry LGPL terms. See `THIRD_PARTY_NOTICES.md`; do not treat the dependency inventory as a completed legal clearance for binary bundles.

The requested publication target is the public `Nukually/health-agent-lab` source repository. Source publication does not deploy a hosted service.
