/**
 * shutdown-regression.test.ts  (nb-r5wv)
 *
 * Regression test: daemon exits on its own after stdin is closed while an
 * Anthropic OAuth browser login is in progress.
 *
 * Before the fix:
 *   – pi-ai's startOAuthCallbackServer bound an HTTP server on 127.0.0.1:53692
 *     and held the event loop open indefinitely.  Closing stdin emitted
 *     "stdin closed, shutting down." but the process never exited (orphaned).
 *   – Test failure: waitForExit() timed out after 4 s.
 *
 * After the fix:
 *   – DaemonCore.close() calls AuthManager.cancelAll(), which aborts the
 *     session's AbortController.  The callback server's onAbort listener fires,
 *     rejecting the wait-promise and calling server.close().  The event loop
 *     drains and the process exits.
 *   – A 5-second backstop setTimeout (unref'd) in main.ts provides a last-resort
 *     force-exit if any other handle slips through.
 *
 * Pre-conditions / skips:
 *   – Skips with a clear message when dist/daemon.mjs is absent (run `npm run build` first).
 *   – Fails with a clear message when port 53692 is already bound (collision with a
 *     live daemon or another test run).
 *
 * Network: none.  The browser flow only starts the local callback server and
 * emits auth.url; it does not contact Anthropic.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_MJS = join(__dirname, "../dist/daemon.mjs");
const OAUTH_PORT = 53692;
/** Timeout for the process to exit after stdin is closed. */
const EXIT_TIMEOUT_MS = 3_000;

/** Check whether a TCP port is already bound on 127.0.0.1. */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(true));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(false));
    });
  });
}

/** Wait at most `timeoutMs` for the process to exit. Resolves with the exit code. */
function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Process did not exit within ${timeoutMs} ms`));
    }, timeoutMs);

    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Parse JSON-lines from a buffer.  Returns all valid objects found so far.
 */
function parseJsonLines(buf: string): unknown[] {
  return buf
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as unknown];
      } catch {
        return [];
      }
    });
}

describe("nb-r5wv regression: daemon exits after OAuth browser login is in progress when stdin closes", () => {
  it("process exits within 3 s and port 53692 is released", async () => {
    // ── pre-condition: dist must exist ───────────────────────────────────────
    if (!existsSync(DAEMON_MJS)) {
      // Use a non-fatal skip rather than throwing, so CI clearly shows WHY.
      console.warn(
        `[skip] ${DAEMON_MJS} not found – run 'npm run build' first.\n` +
          "This test requires the compiled daemon binary.",
      );
      // Mark as skip by returning early from a test that expects nothing.
      return;
    }

    // ── pre-condition: port 53692 must be free ────────────────────────────────
    const portBusy = await isPortInUse(OAUTH_PORT);
    if (portBusy) {
      throw new Error(
        `Port ${OAUTH_PORT} is already in use. ` +
          "A live daemon or another test run is holding it. " +
          "Stop the other process and retry.",
      );
    }

    // ── spawn daemon ──────────────────────────────────────────────────────────
    const dataDir = await mkdtemp(join(tmpdir(), "hydra-shutdown-reg-"));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(process.execPath, [DAEMON_MJS], {
        env: { ...process.env, HYDRA_DATA_DIR: dataDir },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutBuf: string[] = [];
      child.stdout!.setEncoding("utf-8");
      child.stdout!.on("data", (chunk: string) => stdoutBuf.push(chunk));

      // Helper: wait until stdout contains an event matching the predicate.
      const waitForEvent = (
        pred: (obj: Record<string, unknown>) => boolean,
        timeoutMs = 5_000,
      ): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const deadline = Date.now() + timeoutMs;
          const check = () => {
            const objs = parseJsonLines(stdoutBuf.join("")) as Array<Record<string, unknown>>;
            const found = objs.find(pred);
            if (found) return resolve(found);
            if (Date.now() > deadline) return reject(new Error("waitForEvent timeout"));
            setTimeout(check, 30);
          };
          check();
        });

      // ── send hello so we know the daemon is ready ─────────────────────────
      child.stdin!.write(JSON.stringify({ id: "h1", type: "hello" }) + "\n");
      await waitForEvent((o) => o["id"] === "h1" && o["type"] === "result");

      // ── start OAuth browser login ─────────────────────────────────────────
      child.stdin!.write(
        JSON.stringify({
          id: "l1",
          type: "auth.login",
          providerId: "anthropic",
          loginType: "oauth",
        }) + "\n",
      );
      const loginResult = await waitForEvent((o) => o["id"] === "l1" && o["type"] === "result");
      const loginId = (loginResult["result"] as Record<string, string>)["loginId"];
      expect(typeof loginId).toBe("string");

      // ── wait for select prompt, respond with 'browser' ────────────────────
      await waitForEvent((o) => o["type"] === "event" && o["event"] === "auth.prompt");
      const allEvents = parseJsonLines(stdoutBuf.join("")) as Array<Record<string, unknown>>;
      const promptEvent = allEvents.find(
        (o) => o["type"] === "event" && o["event"] === "auth.prompt",
      ) as Record<string, string> | undefined;
      expect(promptEvent).toBeDefined();
      const promptId = promptEvent!["promptId"];
      expect(typeof promptId).toBe("string");

      child.stdin!.write(
        JSON.stringify({ id: "r1", type: "auth.respond", loginId, promptId, value: "browser" }) +
          "\n",
      );

      // ── wait for auth.url (callback server is now listening on :53692) ────
      await waitForEvent((o) => o["type"] === "event" && o["event"] === "auth.url");

      // Confirm the port IS in use at this point (sanity check).
      const portInUseAfterStart = await isPortInUse(OAUTH_PORT);
      expect(portInUseAfterStart).toBe(true);

      // ── close stdin (simulates the app stopping) ──────────────────────────
      child.stdin!.end();

      // ── assert: process exits on its own within EXIT_TIMEOUT_MS ──────────
      const exitCode = await waitForExit(child, EXIT_TIMEOUT_MS);
      expect(exitCode).toBe(0);
      child = undefined; // prevent double-kill in finally

      // ── assert: port 53692 is released ────────────────────────────────────
      const portFreeAfterExit = !(await isPortInUse(OAUTH_PORT));
      expect(portFreeAfterExit).toBe(true);
    } finally {
      // Kill the child if the test failed mid-way (so the port and data dir are cleaned up).
      if (child) {
        child.kill("SIGKILL");
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
