/**
 * session-failure.ts – reacts to a pi-durable Session failure.
 *
 * Since pi-durable 1.2.0 any Storage error closes the Session for good:
 * `harness.closed` settles with `{ reason: "failed", error }` and later calls
 * reject with SessionFailed. The daemon cannot recover in-process, so it logs
 * one stderr line and exits with code 1; the app's reconnect restarts it.
 */

import { describeError } from "./describe-error.js";

/** Minimal shape of `Harness.closed` (SessionEnd) the daemon needs. */
export type SessionEndLike = { reason: "closed" } | { reason: "failed"; error: unknown };

export function exitOnSessionFailure(
  closed: Promise<SessionEndLike>,
  deps: { shutdown: (code: number, logLine: string) => void | Promise<void> },
): void {
  closed.then(
    (end) => {
      if (end.reason !== "failed") return;
      void deps.shutdown(
        1,
        `[hydra-daemon] Session failed: ${describeError(end.error)}. Exiting.\n`,
      );
    },
    () => {
      // `closed` is not expected to reject; treat it as a failure too.
      void deps.shutdown(1, "[hydra-daemon] Session closed promise rejected. Exiting.\n");
    },
  );
}
