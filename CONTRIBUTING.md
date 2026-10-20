# Contributing

Submit focused changes with tests and synthetic fixtures. Contributions are accepted under Apache-2.0; only contribute material you are entitled to license.

Before proposing a change, run `pnpm build`, `pnpm test`, and `pnpm check:publication`. For UI changes, inspect the page in a browser. For schema changes, generate a migration and apply it to an isolated database, then verify the schema.

Keep optional integrations opt-in. Do not attach real credentials, patient records, screenshots containing personal data, or private deployment details to commits or discussions.
