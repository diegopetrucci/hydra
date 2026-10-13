/**
 * schedules-time.test.ts
 *
 * Pure unit tests for parseAtField and nextRunAt, imported from
 * ../src/schedules.js.  Time zone is pinned to Europe/London so that
 * DST-sensitive assertions are deterministic.
 *
 * TZ pinning method: set process.env.TZ at module level (before any Date
 * construction).  Node.js re-reads the TZ variable for each Date
 * construction; this is reliable in Vitest worker threads as confirmed by
 * the guard tests below.
 *
 * Items 5 (one-year bounds) and 6 (history prefix filter) are skipped here:
 *   - Item 5 bounds are enforced in the schedule_message tool's execute()
 *     function, not in nextRunAt or parseAtField, so testing them cheaply
 *     requires a full DaemonCore fixture.  They will be covered in Step C.
 *   - Item 6 (bots.history hides '[Hydra ' entries) requires a running
 *     DaemonCore.  Also covered in Step C.
 */

// ── TZ pin ────────────────────────────────────────────────────────────────────
// Must be set BEFORE any Date is constructed (including by imports).
// Save the original value so afterAll can restore it and prevent leaking into
// other test files.
const _originalTZ = process.env.TZ;
process.env.TZ = "Europe/London";

import { describe, it, expect, afterAll } from "vitest";
import { parseAtField, nextRunAt } from "../src/schedules.js";
import type { StoredRule } from "../src/schedules.js";

// Restore TZ after all tests so the pin can't leak into other test files.
afterAll(() => {
  if (_originalTZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = _originalTZ;
  }
});

// ── Guard tests: prove TZ is in effect ────────────────────────────────────────

describe("TZ guard (Europe/London)", () => {
  /**
   * UK spring-forward: 2027-03-28 at 01:00 local → 02:00 local.
   * Creating a Date at 01:30 on that day yields a normalised hour of 2
   * (i.e. 02:30) because 01:30 does not exist in BST.
   */
  it("spring-forward: new Date(2027, 2, 28, 1, 30).getHours() === 2", () => {
    const d = new Date(2027, 2, 28, 1, 30); // month index 2 = March
    expect(d.getHours()).toBe(2);
  });

  /**
   * Winter offset: UK is GMT (UTC+0) in January.
   * A local Date at 09:00 must equal UTC 09:00.
   */
  it("winter UTC+0: 2027-01-01 09:00 local === UTC 09:00", () => {
    const local = new Date(2027, 0, 1, 9, 0, 0, 0).getTime();
    const utc = Date.UTC(2027, 0, 1, 9, 0, 0, 0);
    expect(local).toBe(utc);
  });

  /**
   * Summer offset: UK is BST (UTC+1) in June.
   * A local Date at 09:00 must equal UTC 08:00 (1 hour earlier in UTC).
   */
  it("summer UTC+1: 2027-06-01 09:00 local === UTC 08:00", () => {
    const local = new Date(2027, 5, 1, 9, 0, 0, 0).getTime();
    const utc = Date.UTC(2027, 5, 1, 8, 0, 0, 0);
    expect(local).toBe(utc);
  });
});

// ── parseAtField ──────────────────────────────────────────────────────────────

/**
 * A fixed "now" for deterministic tests: 2027-01-15 10:00 local (winter, UTC+0).
 * Using a winter date keeps local == UTC and avoids ambiguity in "now".
 */
const NOW_MS = new Date(2027, 0, 15, 10, 0, 0, 0).getTime();

describe("parseAtField – rejections", () => {
  it("rejects Feb 30: '2027-02-30T09:00'", () => {
    const result = parseAtField("2027-02-30T09:00", NOW_MS);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/does not exist/i);
  });

  it("rejects invalid hour '25:00' (HH:MM form)", () => {
    const result = parseAtField("25:00", NOW_MS);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/hour/i);
  });

  it("rejects invalid hour in datetime '2027-01-01T25:00'", () => {
    const result = parseAtField("2027-01-01T25:00", NOW_MS);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/hour/i);
  });

  it("rejects month 13: '2027-13-01T09:00'", () => {
    const result = parseAtField("2027-13-01T09:00", NOW_MS);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/month/i);
  });

  it("rejects the DST gap: '2027-03-28T01:30' (spring-forward in Europe/London)", () => {
    const result = parseAtField("2027-03-28T01:30", NOW_MS);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/spring forward|spring-forward|clocks/i);
  });
});

describe("parseAtField – acceptance", () => {
  it("accepts a valid YYYY-MM-DDTHH:MM that is in the future", () => {
    const result = parseAtField("2027-06-15T14:30", NOW_MS);
    expect(result).toHaveProperty("ms");
    const d = new Date((result as { ms: number }).ms);
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(5); // June = index 5
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  it("accepts HH:MM and returns the next occurrence today or tomorrow", () => {
    // NOW is 10:00; requesting 14:30 → today
    const result = parseAtField("14:30", NOW_MS);
    expect(result).toHaveProperty("ms");
    const d = new Date((result as { ms: number }).ms);
    expect(d.getDate()).toBe(15); // same day (2027-01-15)
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  it("HH:MM in the past today wraps to tomorrow", () => {
    // NOW is 10:00; requesting 09:00 → tomorrow
    const result = parseAtField("09:00", NOW_MS);
    expect(result).toHaveProperty("ms");
    const d = new Date((result as { ms: number }).ms);
    expect(d.getDate()).toBe(16); // next day (2027-01-16)
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });
});

// ── nextRunAt ─────────────────────────────────────────────────────────────────

describe("nextRunAt – spring-forward day (Europe/London 2027-03-28)", () => {
  const dailyRule: StoredRule = { kind: "daily", time: "01:30", weekdays_only: false };

  /**
   * fromMs is 2027-03-27 23:00 local (still winter GMT = UTC+0).
   * The next 01:30 is on 2027-03-28, which is the spring-forward day.
   * 01:30 doesn't exist → Date normalises it to 02:30.
   * The function must return that normalised time (not error).
   */
  it("daily 01:30 from the eve of spring-forward returns the normalised time on that day", () => {
    const fromMs = new Date(2027, 2, 27, 23, 0, 0, 0).getTime(); // 2027-03-27 23:00 local
    const nextMs = nextRunAt(dailyRule, fromMs);
    const d = new Date(nextMs);
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(2); // March
    expect(d.getDate()).toBe(28); // spring-forward day
    // 01:30 doesn't exist; JavaScript normalises to 02:30
    expect(d.getHours()).toBe(2);
    expect(d.getMinutes()).toBe(30);
  });

  /**
   * The FOLLOWING run: fromMs is the 02:30 result above.
   * nextRunAt must NOT carry the normalised hour (2) into subsequent days.
   * Instead it must re-apply the requested hour (1) to 2027-03-29, giving
   * 01:30 BST on the day after spring-forward.
   */
  it("following run after spring-forward day restores the requested hour (01:30)", () => {
    // Construct the normalised time on spring-forward day: 2027-03-28 02:30
    const springForwardRunMs = new Date(2027, 2, 28, 2, 30, 0, 0).getTime();
    const nextMs = nextRunAt(dailyRule, springForwardRunMs);
    const d = new Date(nextMs);
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(2); // March
    expect(d.getDate()).toBe(29); // the day after spring-forward
    // 01:30 now exists in BST; the requested hour must be restored
    expect(d.getHours()).toBe(1);
    expect(d.getMinutes()).toBe(30);
  });
});

describe("nextRunAt – weekdays_only skipping weekend", () => {
  /**
   * Verify 2027-01-01 is a Friday so the test is self-documenting.
   */
  it("2027-01-01 is a Friday (self-check)", () => {
    expect(new Date(2027, 0, 1).getDay()).toBe(5); // 5 = Friday
  });

  /**
   * fromMs is 2027-01-01 12:00 local (Friday, after 09:00).
   * The next 09:00 is Saturday (skipped), then Sunday (skipped),
   * then Monday 2027-01-04.
   */
  it("daily 09:00 weekdays_only from Friday 12:00 → Monday 09:00", () => {
    const rule: StoredRule = { kind: "daily", time: "09:00", weekdays_only: true };
    const fromMs = new Date(2027, 0, 1, 12, 0, 0, 0).getTime(); // Friday 12:00
    const nextMs = nextRunAt(rule, fromMs);
    const d = new Date(nextMs);
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0); // January
    expect(d.getDate()).toBe(4); // Monday
    expect(d.getDay()).toBe(1); // 1 = Monday
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });
});

describe("nextRunAt – every rule", () => {
  it("returns fromMs + interval for 'every' rule", () => {
    const rule: StoredRule = { kind: "every", every_minutes: 5 };
    const fromMs = new Date(2027, 0, 15, 10, 0, 0, 0).getTime();
    const nextMs = nextRunAt(rule, fromMs);
    expect(nextMs).toBe(fromMs + 5 * 60_000);
  });
});

describe("nextRunAt – once rule throws", () => {
  it("throws for 'once' rule (task should have terminated)", () => {
    const rule: StoredRule = { kind: "once" };
    expect(() => nextRunAt(rule, Date.now())).toThrow(/once/i);
  });
});
