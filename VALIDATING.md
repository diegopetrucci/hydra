# Validating Hydra changes

Use this document as the repository reference for final validation.

## Daemon (`daemon/`)

Dependencies install from the lockfile with `npm ci`, never from a loose install. Full validation runs from `daemon/`:

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
printf '{"id":"1","type":"hello"}\n{"id":"2","type":"bots.list"}\n' | HYDRA_DATA_DIR=$(mktemp -d) node dist/daemon.mjs
```

The last command is the smoke test against the built daemon.

## Lint and formatting

Oxlint keeps its default rules and registers the anti-slop plugin vendored in `daemon/tools/oxlint/anti-slop` (copied unchanged from the-last-harness at `05c2b54`). `complexity` is capped at 70 and `max-lines` at 2000. The enabled anti-slop rules are listed in `daemon/.oxlintrc.json`; the rest stay commented out for deliberate adoption.

`npm run lint` uses `--deny-warnings`, so any warning fails. Do not use inline disable comments; exceptions go only in per-file `overrides` in `.oxlintrc.json`.

Oxfmt uses default settings. `npm run format` fixes formatting and `npm run format:check` enforces it.

## App (`Hydra/`)

Run from `Hydra/`:

```sh
xcodebuild -workspace HydraWorkspace.xcworkspace -scheme Hydra -destination 'platform=macOS' -skipMacroValidation -skipPackagePluginValidation -derivedDataPath /tmp/hydra-build build
xcodebuild -workspace HydraWorkspace.xcworkspace -scheme Hydra -destination 'platform=macOS' -skipMacroValidation -skipPackagePluginValidation -derivedDataPath /tmp/hydra-build test -skip-testing:HydraUITests
cd HydraPackage && swift test
```

Use a `/tmp` derived-data path. Do not run the UI tests: they launch the app with the real bundle ID.

## CI

`.github/workflows/ci.yml` runs the `oxlint` and `oxfmt` jobs on pull requests and pushes to `main`. After pushing, watch them until green.

## Final validation guidance

The architect puts the exact ordered shell steps in the final-validation `tk` ticket. `test-runner` runs only those steps and reports without editing. Implementation tickets run their own narrow checks.

## Manual checks

See the "Manual checks" list in `AGENTS.md`.
