import { describe, it, expect, vi, afterEach } from "vitest";
import { createShutdown } from "../src/shutdown.js";
import { exitOnSessionFailure } from "../src/session-failure.js";

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function make(over: Partial<Parameters<typeof createShutdown>[0]> = {}) {
  const order: string[] = [];
  const lines: string[] = [];
  const codes: number[] = [];
  const forceExit = vi.fn();
  const shutdown = createShutdown({
    writeStderr: (l) => lines.push(l),
    inFlight: () => [],
    closeCore: async () => void order.push("core"),
    closeHarness: async () => void order.push("harness"),
    setExitCode: (c) => void codes.push(c),
    forceExit,
    ...over,
  });
  return { shutdown, order, lines, codes, forceExit };
}

afterEach(() => vi.useRealTimers());

describe("shutdown", () => {
  it("drains in-flight, then closes core and harness, then sets the exit code", async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const t = make({ inFlight: () => [pending] });
    const done = t.shutdown(0, "stdin closed\n");
    await flush();
    expect(t.lines).toEqual(["stdin closed\n"]);
    expect(t.order).toEqual([]);
    release();
    await done;
    expect(t.order).toEqual(["core", "harness"]);
    expect(t.codes).toEqual([0]);
  });

  it("session failure calls shutdown(1)", async () => {
    const shutdown = vi.fn();
    exitOnSessionFailure(Promise.resolve({ reason: "failed", error: new Error("disk secret") }), {
      shutdown,
    });
    await flush();
    expect(shutdown).toHaveBeenCalledOnce();
    const [code, line] = shutdown.mock.calls[0] as [number, string];
    expect(code).toBe(1);
    expect(line).toMatch(/Session failed/);
    expect(line).not.toMatch(/secret/);
  });

  it("session failure ignores a normal close", async () => {
    const shutdown = vi.fn();
    exitOnSessionFailure(Promise.resolve({ reason: "closed" }), { shutdown });
    await flush();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("is idempotent: first code wins and a later stdin close keeps 1", async () => {
    const t = make();
    await t.shutdown(1, "failed\n");
    await t.shutdown(0, "stdin closed\n");
    expect(t.codes).toEqual([1]);
    expect(t.lines).toEqual(["failed\n"]);
    expect(t.order).toEqual(["core", "harness"]);
  });

  it("completes with the exit code when closes reject (SessionFailed)", async () => {
    const t = make({
      closeCore: () => Promise.reject(new Error("SessionFailed")),
      closeHarness: () => Promise.reject(new Error("SessionFailed")),
    });
    await expect(t.shutdown(1, "failed\n")).resolves.toBeUndefined();
    expect(t.codes).toEqual([1]);
  });

  it("backstop force-exits with the code passed in", async () => {
    vi.useFakeTimers();
    const t = make({ inFlight: () => [new Promise(() => {})] });
    void t.shutdown(1, "failed\n");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(t.forceExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.forceExit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
