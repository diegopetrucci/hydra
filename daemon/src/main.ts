/**
 * main.ts – Hydra daemon entry point.
 *
 * Responsibilities:
 *  1. Resolve the data directory (HYDRA_DATA_DIR or ~/Library/Application Support/Hydra/).
 *  2. Create the data directory with mode 0700.
 *  3. Acquire a PID lock file; exit 1 with a clear message if another instance is running.
 *  4. Open SQLite storage and the Harness.
 *  5. Start DaemonCore (loads bots, starts watchers).
 *  6. Read JSON-lines from stdin and dispatch commands; write JSON-lines to stdout.
 *  7. On stdin close, clean up and exit 0.
 *
 * stdout carries protocol lines only.  All diagnostic output goes to stderr.
 */

import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { ensurePrivateDir } from "./private-dir.js";
import { createShutdown } from "./shutdown.js";
import { exitOnSessionFailure } from "./session-failure.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "./models.js";
import { DaemonCore } from "./daemon-core.js";
import { acquireLock, releaseLock, LockError } from "./lock.js";
import { FileCredentialStore } from "./credential-store.js";
import { FileConnectorStore } from "./connector-store.js";
import { ConnectorManager } from "./connectors.js";
import { attachConnectorTools } from "./connector-tools.js";
import type { ProtocolEvent } from "./protocol.js";
import {
  webToolsExtension,
  ensureWebAccessDir,
  WEB_TOOL_NAMES,
  resetWebToolsBudget,
} from "./web-tools.js";
import { hydraExtension } from "./system-prompt.js";
import { createSchedulesExtension, SCHEDULE_TOOL_NAMES } from "./schedules.js";
import { createCiWatchExtension, CI_TOOL_NAMES } from "./ci-watch.js";
import { describeError } from "./describe-error.js";

const DATA_DIR_ENV = "HYDRA_DATA_DIR";

function resolveDataDir(): string {
  const env = process.env[DATA_DIR_ENV];
  if (env) return env;
  return join(homedir(), "Library", "Application Support", "Hydra");
}

function ensureDataDir(dir: string): void {
  ensurePrivateDir(dir);
}

function writeStdout(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  ensureDataDir(dataDir);

  let lockPath: string;
  try {
    lockPath = acquireLock(dataDir);
  } catch (e: unknown) {
    if (e instanceof LockError) {
      process.stderr.write(`[hydra-daemon] ${e.message}. Exiting.\n`);
      process.exit(1);
    }
    throw e;
  }

  // Release lock on any exit.
  process.on("exit", () => releaseLock(lockPath));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  const dbPath = join(dataDir, "harness.sqlite");
  const storage = await openNodeSqliteStorage(dbPath);
  const registry = createRegistry();
  // Install the base system-prompt extension first so its <hydra> section
  // appears before <web-tools-safety> and <instructions> in the rendered prompt.
  // The default agent selection is every installed extension, so no per-
  // conversation migration is required for either extension.
  registry.install(hydraExtension);
  registry.install(webToolsExtension);

  const { extension: schedulesExtension, setHarness: setSchedulesHarness } =
    createSchedulesExtension(); // production: minIntervalMs=60_000, maxSchedules=5
  registry.install(schedulesExtension);

  const { extension: ciWatchExtension, setHarness: setCiWatchHarness } = createCiWatchExtension(); // production: pollMs=60_000, real gh
  registry.install(ciWatchExtension);

  // Set PI_CODING_AGENT_DIR to <dataDir>/web-access (0700) so that the web
  // tools can locate their settings and cache directory.  A pre-existing
  // PI_CODING_AGENT_DIR env var is respected without modification.
  ensureWebAccessDir(dataDir);

  // File-backed credential store at <dataDir>/credentials.json (mode 0600).
  const credStore = new FileCredentialStore(dataDir);
  const models = createModels(credStore);
  // MCP connectors: OAuth state at <dataDir>/connectors.json (mode 0600).
  // Declared before the shutdown routine so it can close them.
  const connectors = new ConnectorManager(new FileConnectorStore(dataDir), (event) =>
    writeStdout(event),
  );

  // Connector tools, tool_search and their prompt section follow connector state at runtime.
  attachConnectorTools(registry, connectors);

  const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);

  // Track every in-flight handleRequest promise so we can drain them before exit.
  const inFlight = new Set<Promise<void>>();
  // `core` is created below; shutdown can only run after it exists in practice.
  let core: DaemonCore | undefined;

  // One drain-first shutdown routine for stdin close and Session failure.
  const shutdown = createShutdown({
    writeStderr: (line) => process.stderr.write(line),
    inFlight: () => inFlight,
    closeConnectors: () => connectors.close(),
    closeCore: async () => {
      await core?.close();
    },
    closeHarness: () => harness.close(BACKGROUND_CONTEXT),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    forceExit: (code) => process.exit(code),
  });

  // A Storage error closes the Session for good (pi-durable 1.2.0): shut down
  // with code 1 so the app restarts us.
  exitOnSessionFailure(harness.closed, { shutdown });

  // Late-bind the harness to the schedules extension so cancel_schedule can call abortTask.
  setSchedulesHarness(harness);
  setCiWatchHarness(harness);

  const emitEvent = (event: ProtocolEvent): void => writeStdout(event);
  core = new DaemonCore(
    harness,
    models,
    emitEvent,
    BACKGROUND_CONTEXT,
    credStore,
    (p, t, i) => models.login(p, t, i),
    [...WEB_TOOL_NAMES, ...SCHEDULE_TOOL_NAMES, ...CI_TOOL_NAMES],
    resetWebToolsBudget,
    true,
    connectors,
  );
  await core.start();

  process.stderr.write(`[hydra-daemon] Started (pid ${process.pid}, data: ${dataDir})\n`);

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeStdout({
        id: null,
        type: "error",
        error: { code: "parse_error", message: "Invalid JSON" },
      });
      return;
    }

    const p = core
      .handleRequest(parsed)
      .then(writeStdout)
      .catch((e: unknown) => {
        // Never surface raw exception strings: they may contain secrets, HTTP
        // response bodies, or upstream URLs.  Log only the class and code.
        process.stderr.write(`[hydra-daemon] request error: ${describeError(e)}\n`);
        writeStdout({
          id: null,
          type: "error",
          error: { code: "internal_error", message: "Internal error." },
        });
      });

    inFlight.add(p);
    // Remove from the set once settled so it doesn't grow unboundedly.
    p.finally(() => inFlight.delete(p));
  });

  rl.on("close", () => {
    void shutdown(0, "[hydra-daemon] stdin closed, shutting down.\n");
  });
}

main().catch((e: unknown) => {
  // Log only the error class and code, not the raw message which may contain
  // secrets, HTTP response bodies, or upstream URLs.
  process.stderr.write(`[hydra-daemon] Fatal: ${describeError(e)}\n`);
  process.exit(1);
});
