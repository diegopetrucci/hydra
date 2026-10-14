# hydra

## What this is

A personal-trial macOS app for named chat bots, backed by a local Node daemon on `@earendil-works/pi-durable`. The long-term goal is proactive bots (Grok Bot style).

## Layout

```
daemon/                  TypeScript daemon
Hydra/
  HydraWorkspace.xcworkspace
  Hydra.xcodeproj
  HydraPackage/
.agents/skills/          agent skills
```

## Rules

- **Models.** All model and provider setup stays in `daemon/src/models.ts`.
- **Dependency pin.** `@earendil-works/pi-durable`, `pi-ai`, `chord`, `pi-tui` and `pi-mcp` are pinned exactly to `1.2.0`.
- **Protocol.** The daemon's stdout carries protocol lines only; logs go to stderr.
- **Base system prompt.** Every bot receives the identity/tone prompt defined in `daemon/src/system-prompt.ts` (`hydraExtension`), installed before the web-tools extension so it leads the rendered system prompt.
- **Before writing Swift.** Read `.agents/skills/pfw-pfw/SKILL.md`, then the relevant `pfw-*` skills (Swift 6, TCA, Swift Testing).
- **Xcode.** Open the workspace (`HydraWorkspace.xcworkspace`), not the `.xcodeproj`.
- **Commits.** Never commit without the human's approval.

## Apple developer documentation

- `developer.apple.com` pages are rendered with JavaScript, so fetch them as Markdown instead.
- For `/documentation` pages, add `.md` to the URL (https://developer.apple.com/documentation/swiftui/view.md).
- For `/design` and `/tutorials` pages, also insert `/tutorials/data` before the path (https://developer.apple.com/tutorials/data/design/human-interface-guidelines/buttons.md).
- A few tutorial pages, such as overviews, have no Markdown version; for those, use `.json` in place of `.md` (https://developer.apple.com/tutorials/data/tutorials/swiftui.json).
- If none of this work, use the `sosumi` MCP server — `searchAppleDocumentation` when you don't know the path, then `fetchAppleDocumentation` / `fetchAppleVideoTranscript` / `fetchExternalDocumentation`.

## Commands

For full validation, follow `VALIDATING.md`.

### Daemon

All commands run from `daemon/`.

```bash
# Install dependencies (once, or after package.json changes)
npm ci

# Type-check
npm run typecheck

# Run tests (no network; uses pi-ai faux provider)
npm test

# Lint with oxlint (warnings denied)
npm run lint

# Format with oxfmt
npm run format

# Check formatting without writing
npm run format:check

# Build the bundled daemon binary
npm run build
# → dist/daemon.mjs

# Run the daemon (reads JSON-lines on stdin, writes JSON-lines on stdout)
# Data dir defaults to ~/Library/Application Support/Hydra/
node dist/daemon.mjs

# Override data dir (useful for testing)
HYDRA_DATA_DIR=/tmp/my-hydra-data node dist/daemon.mjs

# Smoke test
printf '{"id":"1","type":"hello"}\n{"id":"2","type":"bots.list"}\n' \
  | HYDRA_DATA_DIR=$(mktemp -d) node dist/daemon.mjs
```

See `daemon/PROTOCOL.md` for the full JSON-lines protocol reference.

### App

All commands run from `Hydra/`.

```bash
# Build the app (requires Swift 6 / Xcode 26.6+)
xcodebuild -workspace HydraWorkspace.xcworkspace \
  -scheme Hydra \
  -destination 'platform=macOS' \
  -skipMacroValidation \
  -skipPackagePluginValidation \
  build

# Run tests (skips UI tests; also runs DaemonClientTests + AppFeatureTests from the package)
xcodebuild -workspace HydraWorkspace.xcworkspace \
  -scheme Hydra \
  -destination 'platform=macOS' \
  -skipMacroValidation \
  -skipPackagePluginValidation \
  test -skip-testing:HydraUITests

# Run package tests (DaemonClientTests, AppFeatureTests)
cd HydraPackage && swift test
```

> **Signing note**: automatic signing (team L746MNXFYJ). No extra flags needed for local builds.
> **Node path**: resolved from `HYDRA_NODE` env var, then UserDefaults key `HYDRA_NODE`,
> then `/opt/homebrew/bin/node`, then `/usr/local/bin/node`.
> **Daemon path**: resolved from `HYDRA_DAEMON` env var, else derived from `#filePath` at
> build time → `<repo>/daemon/dist/daemon.mjs`. Run `npm run build` in `daemon/` first.

## Manual checks

- Sign in with Claude (OAuth) and with an API key.
- **OAuth select prompt**: The first OAuth step presents a "Browser login / Copy code login" selection. Tap one of the options; the browser URL should appear next.
- Ask a bot something that needs a web search.
- A notification arrives in Notification Center while the app is in the background (send a message to a bot, switch to another app, wait for the reply).
- **Chat open position and focus**: Open an existing long chat; the newest message is visible without scrolling and the message field is focused (typing goes straight in).
- **New bot focus**: Create a new bot; after the sheet closes the message field is focused.
- **Notification window raise**: Tap that notification banner; the main window opens or comes to the front and the correct bot is selected.
- Closing the main window keeps the menu bar item visible; "Open Hydra" in the menu bar reopens the window.
- Clicking the Dock icon while the window is closed reopens the window.
- Quit from the menu bar extra terminates the daemon (check that no `node` process lingers after quit).
- **Window close / notification continuity**: Send a bot a message that needs a long reply (e.g. a web search), then close the main window before the reply finishes. The notification must still arrive. Reopen the window from the menu bar item or Dock icon. The reply should be visible and chat should still work.
- **Bot intro (signed in)**: Create a new bot while signed in. Without sending any message, the bot should introduce itself automatically in the chat view within a few seconds.
- **Bot intro (signed out)**: Create a new bot while signed out. The bot is created successfully but no intro message appears and no error is shown.
- **Scheduled check-in**: Ask a bot "say hi every minute". The bot should schedule it and a greeting should arrive about a minute later, with a notification if the bot isn't the selected chat.
- **Cancel schedule**: Tell the same bot "stop saying hi". The bot should cancel the schedule and no further greetings should arrive.
- **CI watch**: Ask a CI bot to watch your PRs; a summary of currently failing PRs arrives, and a new failure triggers a warning.
- **Connectors**: Open the sidebar ellipsis menu → "Connectors…". For each connector (Sentry, Notion), tap Sign In; the browser opens, finish the sign-in, and the row shows Connected. Cancel a pending sign-in once and confirm the row returns to Not connected. Ask a bot to use the connector (e.g. "list my recent Sentry issues"), then tap Sign Out and confirm the row returns to Not connected.
- **Swarmia and Amplitude**: Open Connectors…; all four rows (Sentry, Notion, Swarmia, Amplitude) show and the sheet doesn't crash. Sign in to Swarmia and Amplitude, then ask a bot a question that needs each.
- **Connector not connected**: With Swarmia signed out, ask a bot a Swarmia question; it replies briefly that it isn't connected and points to ⋯ → Connectors….
- **Schedule persistence**: Ask a bot to check in every minute, then quit and relaunch the app. The schedule should survive and the check-in should still fire after the daemon restarts.
- **Sidebar row hit area**: Click anywhere in a sidebar row, including the empty space after the name or time; that bot is selected.
- **New bot tip**: Sign in with no bots; a tip points at the + button and the detail view says "No Bots Yet" without mentioning the sidebar. Clicking + (or closing the tip) dismisses it for good. To see it again, launch with `-com.apple.TipKit.ResetDatastore 1`.

## Web tools configuration

The daemon gives every bot three web tools: **web_search** (Exa),
**fetch_content**, and **get_search_content**.

### Data directory

At startup the daemon sets `PI_CODING_AGENT_DIR` to
`<HYDRA_DATA_DIR>/web-access` (mode `0700`) unless the variable is already
set in the environment.

### Exa API key

Without a key, keyless Exa is used (lower rate limits, no neural search).

Two ways to supply a key:

1. **Environment variable** – `EXA_API_KEY=your-key`.
2. **Settings file** –
   `<PI_CODING_AGENT_DIR>/extensions/pi-web-access/settings.json`:
   ```json
   { "exaApiKey": "your-key-here" }
   ```
