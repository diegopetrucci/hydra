# Validating Hydra changes

Use this document as the repository reference for final validation.

## Daemon (`daemon/`)

Use a patched Node.js runtime: `^22.23.4 || ^24.22.1 || ^26.12.1`.
Other majors and prereleases are unsupported. Check `node --version` before
installing or validating; npm's engine warning alone does not enforce this policy.

Dependencies install from the lockfile with `npm ci`, never from a loose install. Full validation runs from `daemon/`:

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run build
PI_CODING_AGENT_DIR="$(mktemp -d)" npm test
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

`.github/workflows/ci.yml` runs lint and formatting on Node 22.23.4, plus typecheck, build and tests on Node 22.23.4, 24.22.1 and 26.12.1, on pull requests and pushes to `main`. After pushing, watch them until green.

## Final validation guidance

The architect puts the exact ordered shell steps in the final-validation `tk` ticket. `test-runner` runs only those steps and reports without editing. Implementation tickets run their own narrow checks.

## Manual checks

See the "Manual checks" list in `AGENTS.md`.

## October 2026 Node security update

The [Node security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
fixes native Brotli decoding (CVE-2026-111497), TLS issues and the
[eMudhra CA compromise](https://emudhra.we-have-a-problem.com/).
Hydra's web tools and model/connector clients make HTTPS requests in the Node
daemon. Updating npm packages or macOS alone does not patch that executable.
The pinned pi packages remain at 1.2.0; no npm-only fix replaces the Node update.

The dependency-free `src/main.ts` bootstrap rejects unsupported Node versions
before loading `src/daemon.ts`. The build emits the bootstrap and implementation
separately so dependency imports cannot be hoisted ahead of the check. Keep **all files in `daemon/dist/`**
together when copying a build; `daemon.mjs` remains the app's entry point.
Give web-tools tests an isolated `PI_CODING_AGENT_DIR`, as above.
Build before testing: `test/runtime.test.ts` checks the actual bootstrap with
a missing implementation bundle, unsafe version preloads, and an isolated protocol
smoke test on the current real runtime. No exploit payloads are used.

Operator follow-up: install a patched Node on the machine running Hydra, rebuild
the daemon, then fully quit and relaunch Hydra when ready. The existing app process
continues using its old runtime until relaunched. `HYDRA_NODE` (environment or
UserDefaults) can select a patched executable; the Homebrew fallback paths are
unchanged. Verify that selected executable's `--version`, then run the smoke test
above with that executable. An unsupported runtime writes an actionable error to
stderr (the app's daemon log) and exits without accessing Hydra data.

The version floor assumes the official patched runtime and its default trust
configuration. Operators using system/custom CA stores (`NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_OPTIONS`, or Node CA flags) must also update
and verify those stores separately; do not disable TLS verification. Repository
checks do not prove a running app or a custom trust store has been remediated.
