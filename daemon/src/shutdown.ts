/**
 * shutdown.ts – the single drain-first shutdown routine, shared by the
 * stdin-close and Session-failure paths. Injectable deps keep it testable
 * without importing main.ts.
 */

export interface ShutdownDeps {
  writeStderr: (line: string) => void;
  /** In-flight request promises, read when draining begins. */
  inFlight: () => Iterable<Promise<unknown>>;
  /** Closes MCP connector clients and any pending sign-in. Optional. */
  closeConnectors?: () => Promise<void>;
  closeCore: () => Promise<void>;
  closeHarness: () => Promise<void>;
  /** Sets process.exitCode (the loop then drains; no synchronous exit). */
  setExitCode: (code: number) => void;
  /** Hard exit used only by the backstop. */
  forceExit: (code: number) => void;
  backstopMs?: number;
}

/**
 * Returns `shutdown(code, logLine)`. It runs once: the first call's code wins
 * and later calls return the same promise. Close failures (e.g. SessionFailed
 * after a Session failure) are swallowed; it never rejects.
 */
export function createShutdown(
  deps: ShutdownDeps,
): (code: number, logLine: string) => Promise<void> {
  let running: Promise<void> | undefined;

  return (code, logLine) => {
    running ??= (async () => {
      deps.writeStderr(logLine);

      // Backstop: force-exit with the same code if the loop is still alive
      // after 5 s. unref() so the timer never keeps a clean exit alive.
      const backstop = setTimeout(() => {
        deps.writeStderr("[hydra-daemon] backstop: force-exiting after 5 s\n");
        deps.forceExit(code);
      }, deps.backstopMs ?? 5_000);
      backstop.unref();

      await Promise.allSettled(deps.inFlight());
      if (deps.closeConnectors)
        await Promise.resolve()
          .then(deps.closeConnectors)
          .catch(() => {});
      await Promise.resolve()
        .then(deps.closeCore)
        .catch(() => {});
      await Promise.resolve()
        .then(deps.closeHarness)
        .catch(() => {});
      // Set exitCode and let the event loop drain instead of calling
      // process.exit(): that can truncate buffered stdout/stderr writes.
      deps.setExitCode(code);
    })();
    return running;
  };
}
