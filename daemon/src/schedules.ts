/**
 * schedules.ts – Bot-scheduled check-ins for Hydra.
 *
 * Exports:
 *  - SchedulesDoc          conversation-scoped doc: scheduleId → entry
 *  - nextRunAt             pure function: compute next epoch-ms from a rule
 *  - parseAtField          parse 'HH:MM' or 'YYYY-MM-DDTHH:MM' for once schedules
 *  - fmtLocalTime          locale-independent formatter, e.g. "Fri 9 Oct 2026, 19:31"
 *  - checkInPrompt         the hidden user message text sent for each check-in
 *  - createSchedulesExtension  factory returning { extension, setHarness }
 *
 * Production limits (defaults): minimum interval 1 minute, at most 5 active
 * schedules per bot.  Pass test-only values via SchedulesOptions.
 *
 * Doc semantics: an entry in SchedulesDoc = an active schedule.  Entries are
 * deleted (not status-flagged) when a schedule is cancelled or a one-off fires.
 */

import { defineDoc, defineExtension, defineTool, defineTask } from "@earendil-works/pi-durable";
import type {
  ConversationDocToken,
  ConversationId,
  Extension,
  Harness,
  TaskId,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { latestUserInputIsHuman, NOT_REQUESTED_TEXT } from "./user-input.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Prefix on check-in trigger messages; hidden from bots.history. */
export const CHECKIN_MARKER = "[Hydra check-in]";

/**
 * Shared prefix that covers every Hydra hidden trigger message
 * (intro and check-in).  bots.history hides any user entry whose text
 * starts with this string, so a single check replaces two startsWith calls.
 */
export const HYDRA_MARKER_PREFIX = "[Hydra ";

export const SCHEDULE_TOOL_NAMES = [
  "schedule_message",
  "list_schedules",
  "cancel_schedule",
] as const;

// ─── Stored rule shapes ───────────────────────────────────────────────────────

/** Normalised recurring/one-off rule stored in the task input. */
export type StoredRule =
  | { kind: "every"; every_minutes: number }
  | { kind: "daily"; time: string; weekdays_only: boolean }
  | { kind: "once" };

// ─── Schedules doc (conversation-scoped) ─────────────────────────────────────

/**
 * Typed view of one schedule entry.
 * Active = present in the doc.  Cancelled/completed entries are deleted.
 * Stored as a flat Record<string, string | number> so the value satisfies JsonValue.
 */
export interface ScheduleEntry {
  what: string;
  /** Human-readable rule summary, e.g. "every 5 minutes". */
  rule: string;
  /** Next scheduled fire time (epoch ms). */
  nextAt: number;
  /** When the schedule was created (epoch ms). */
  createdAt: number;
}

function entryToRecord(e: ScheduleEntry): Record<string, string | number> {
  return { what: e.what, rule: e.rule, nextAt: e.nextAt, createdAt: e.createdAt };
}

function recordToEntry(r: Record<string, string | number>): ScheduleEntry {
  return {
    what: String(r["what"] ?? ""),
    rule: String(r["rule"] ?? ""),
    nextAt: Number(r["nextAt"] ?? 0),
    createdAt: Number(r["createdAt"] ?? 0),
  };
}

/**
 * Conversation-scoped singleton.
 * Maps schedule id (task id as string) to a flat string/number record.
 * Active = present; cancelled/completed = absent (deleted on transition).
 */
export const SchedulesDoc: ConversationDocToken<{
  schedules: Record<string, Record<string, string | number>>;
}> = defineDoc<{ schedules: Record<string, Record<string, string | number>> }>({
  kind: "hydra.schedules",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ schedules: {} }),
});

// ─── nextRunAt ────────────────────────────────────────────────────────────────

/**
 * Pure function: compute the next fire epoch-ms from `fromMs`.
 *
 * - `every`: fromMs + every_minutes × 60 000
 * - `daily`: next local HH:MM after fromMs, skipping weekends when weekdays_only
 * - `once`: throws – the task terminates after firing
 */
export function nextRunAt(rule: StoredRule, fromMs: number): number {
  if (rule.kind === "every") {
    return fromMs + rule.every_minutes * 60_000;
  }

  if (rule.kind === "daily") {
    const [hStr, mStr] = rule.time.split(":");
    const h = Number(hStr);
    const m = Number(mStr);

    // DST-safe: for each candidate day, derive the calendar date components
    // and then reapply the requested hour and minute from scratch.  Using
    // setDate() after setHours() can carry a DST-normalised hour into
    // subsequent days (e.g. spring-forward silently shifts 01:30 → 02:30
    // and the mutation propagates to every day that follows).  Creating a
    // fresh Date(yr, mo, day, h, m) on each iteration avoids this.
    const fromDate = new Date(fromMs);
    let d = new Date(
      fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate(), h, m, 0, 0,
    );

    if (d.getTime() <= fromMs) {
      // Advance to the next calendar day by re-constructing with day+1.
      d = new Date(
        fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate() + 1, h, m, 0, 0,
      );
    }

    if (rule.weekdays_only) {
      while (d.getDay() === 0 || d.getDay() === 6) {
        // Advance one calendar day: derive yr/mo/day from d, then add 1.
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m, 0, 0);
      }
    }

    return d.getTime();
  }

  throw new Error("nextRunAt: called on a 'once' rule – task should have terminated");
}

/**
 * Parse the `at` field for 'once' schedules.
 * Accepts:
 *   - 'HH:MM'            → next occurrence today or tomorrow (local time)
 *   - 'YYYY-MM-DDTHH:MM' → exact local date-time
 *
 * Returns { ms } on success or { error } on failure.
 */
export function parseAtField(
  at: string,
  nowMs: number,
): { ms: number } | { error: string } {
  const hmMatch = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (hmMatch) {
    const h = Number(hmMatch[1]);
    const m = Number(hmMatch[2]);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return { error: `Invalid time '${at}': hours must be 0–23, minutes 0–59.` };
    }
    // DST-safe: set the calendar date first, then apply the requested hour and
    // minute.  If the time falls in a spring-forward gap, JavaScript normalises
    // it silently – that is acceptable for HH:MM (next-occurrence) because we
    // only reject the gap for the exact-date YYYY-MM-DDTHH:MM form.
    const now = new Date(nowMs);
    let d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    if (d.getTime() <= nowMs) {
      d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, m, 0, 0);
    }
    return { ms: d.getTime() };
  }

  const dtMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})$/.exec(at);
  if (dtMatch) {
    const yr = Number(dtMatch[1]);
    const mo = Number(dtMatch[2]);
    const dy = Number(dtMatch[3]);
    const h  = Number(dtMatch[4]);
    const mn = Number(dtMatch[5]);

    // Basic range validation before constructing a Date.
    if (mo < 1 || mo > 12) {
      return { error: `Invalid date-time '${at}': month must be 1–12.` };
    }
    if (h < 0 || h > 23) {
      return { error: `Invalid date-time '${at}': hour must be 0–23.` };
    }
    if (mn < 0 || mn > 59) {
      return { error: `Invalid date-time '${at}': minute must be 0–59.` };
    }

    const d = new Date(yr, mo - 1, dy, h, mn, 0, 0);

    // Round-trip check: if JavaScript normalised the calendar fields (e.g.
    // Feb 30 → Mar 1, or day 0 → last day of prev month), the supplied
    // date doesn't exist – reject rather than silently accept the wrong day.
    if (d.getFullYear() !== yr || d.getMonth() !== mo - 1 || d.getDate() !== dy) {
      return {
        error: `Invalid date-time '${at}': day ${dy} does not exist in ${yr}-${String(mo).padStart(2, "0")}.`,
      };
    }

    // DST gap check: if the requested local time doesn't exist because clocks
    // spring forward, JavaScript normalises it (e.g. 01:30 → 02:30 in UK
    // spring-forward).  Reject with a readable error so the model can choose
    // a different time, rather than silently scheduling the wrong minute.
    if (d.getHours() !== h || d.getMinutes() !== mn) {
      return {
        error:
          `The time ${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")} ` +
          `on ${yr}-${String(mo).padStart(2, "0")}-${String(dy).padStart(2, "0")} ` +
          `does not exist because clocks spring forward at that hour. Please choose a different time.`,
      };
    }

    return { ms: d.getTime() };
  }

  return {
    error: `'at' must be 'HH:MM' (next occurrence today or tomorrow) or 'YYYY-MM-DDTHH:MM', got '${at}'.`,
  };
}

// ─── Local time formatter ─────────────────────────────────────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS   = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Locale-independent local-time formatter.
 * Output: "Fri 9 Oct 2026, 19:31"
 * - Short English weekday (3 letters)
 * - Day without zero-padding
 * - Short English month (3 letters)
 * - Full year
 * - 24-hour HH:MM (zero-padded)
 *
 * Uses Date getters directly so the result is stable regardless of locale.
 */
export function fmtLocalTime(ms: number): string {
  const d    = new Date(ms);
  const wday = WEEKDAYS[d.getDay()]!;
  const day  = d.getDate();
  const mon  = MONTHS[d.getMonth()]!;
  const year = d.getFullYear();
  const hh   = String(d.getHours()).padStart(2, "0");
  const mm   = String(d.getMinutes()).padStart(2, "0");
  return `${wday} ${day} ${mon} ${year}, ${hh}:${mm}`;
}

// ─── Human-readable rule summary ─────────────────────────────────────────────

/** Produce the one-line rule summary stored in the doc and returned by list_schedules. */
export function ruleText(rule: StoredRule, firstAtMs?: number): string {
  if (rule.kind === "every") {
    const m = rule.every_minutes;
    return `every ${m} minute${m === 1 ? "" : "s"}`;
  }
  if (rule.kind === "daily") {
    const days = rule.weekdays_only ? "weekdays" : "daily";
    return `${days} at ${rule.time}`;
  }
  if (firstAtMs !== undefined) {
    return `once at ${fmtLocalTime(firstAtMs)}`;
  }
  return "once";
}

// ─── Check-in prompt ─────────────────────────────────────────────────────────

/**
 * Hidden user message text for each check-in.
 * Text is verbatim from nb-a6u0 eval (variant S3, Sonnet 5.5 + Haiku 4.5) – do not reword.
 * `rule` is a short human summary, e.g. "every 1 minute", "daily at 09:00", "once".
 * For a one-off schedule pass "once" (not the full "once at <time>" stored in the doc).
 */
export function checkInPrompt(opts: {
  scheduleId: string;
  what: string;
  rule: string;
  dueTime: string;
  currentTime: string;
}): string {
  return (
    `${CHECKIN_MARKER} Schedule #${opts.scheduleId} "${opts.what}" (${opts.rule}) is due at ${opts.dueTime}. ` +
    `It's now ${opts.currentTime}. Do it now. If there's nothing worth telling the user, reply with exactly NO_REPLY.`
  );
}

// ─── Task input / checkpoint types ───────────────────────────────────────────

interface CheckInInput {
  convId: number;
  what: string;
  rule: StoredRule;
  ruleSummary: string;
  firstAt: number;
}

type CheckInCheckpoint = {
  phase: "sleep";
  nextAt: number;
  fired: number;
};

// ─── Durable task ─────────────────────────────────────────────────────────────

const CheckInTask = defineTask<CheckInInput, CheckInCheckpoint, void>({
  name: "hydra.checkin",
  version: 1,

  initial: (input): CheckInCheckpoint => ({
    phase: "sleep",
    nextAt: input.firstAt,
    fired: 0,
  }),

  phases: {
    sleep: async (task, rt, ctx) => {
      const { nextAt, fired } = task.state.checkpoint;

      await rt.sleep(nextAt, ctx);

      const conv = await rt.conversation(rt.conversationId, ctx);
      if (!conv) throw new Error("hydra.checkin: conversation not found");

      const n = fired + 1;
      const sid = String(rt.taskId);
      const { what, rule, ruleSummary } = task.input;
      const nowMs = rt.now();

      // For a one-off schedule, the check-in rule is just "once"; the full
      // "once at <time>" summary is only used in list_schedules output.
      const checkInRule = rule.kind === "once" ? "once" : ruleSummary;
      const content = checkInPrompt({
        scheduleId: sid,
        what,
        rule: checkInRule,
        dueTime: fmtLocalTime(nextAt),
        currentTime: fmtLocalTime(nowMs),
      });

      await conv.submit(
        {
          type: "input",
          content,
          requestId: `hydra-checkin-${sid}-${n}`,
          whenBusy: "followUp",
        },
        ctx,
      );

      // Commit next checkpoint and keep the schedules doc in sync.
      await rt.commit(async (tx) => {
        const doc = await tx.doc(SchedulesDoc, rt.conversationId);

        if (rule.kind === "once") {
          // One-off: delete the doc entry and terminate.
          delete (doc.schedules as Record<string, unknown>)[sid];
          return {
            status: "terminal" as const,
            outcome: { status: "completed" as const, result: undefined },
          };
        }

        const next = nextRunAt(rule, nowMs);
        const existing = doc.schedules[sid];
        if (existing) {
          doc.schedules[sid] = { ...existing, nextAt: next };
        }

        return {
          status: "running" as const,
          checkpoint: { phase: "sleep" as const, nextAt: next, fired: n },
        };
      }, ctx);
    },
  },

  abort: async (_task, rt, ctx) => {
    await rt.commit(async (tx) => {
      const doc = await tx.doc(SchedulesDoc, rt.conversationId);
      const sid = String(rt.taskId);
      // Delete the entry; active = present in doc.
      delete (doc.schedules as Record<string, unknown>)[sid];
      return {
        status: "terminal" as const,
        outcome: { status: "aborted" as const, reason: "cancelled" },
      };
    }, ctx);
  },
});

// ─── Extension options ────────────────────────────────────────────────────────

export interface SchedulesOptions {
  /**
   * Minimum interval between fires, in milliseconds.
   * Default: 60_000 (1 minute).  Set lower in tests.
   */
  minIntervalMs?: number;
  /**
   * Maximum number of active schedules per bot.
   * Default: 5.  Set lower in tests.
   */
  maxSchedules?: number;
}

// ─── Extension factory ────────────────────────────────────────────────────────

/**
 * Create the schedules extension.
 *
 * Returns:
 *  - `extension`   install in the registry before Harness.open.
 *  - `setHarness`  call after Harness.open to bind the harness reference
 *                  (needed by cancel_schedule → harness.abortTask).
 */
export function createSchedulesExtension(options: SchedulesOptions = {}): {
  extension: Extension;
  setHarness: (h: Harness) => void;
} {
  const minIntervalMs = options.minIntervalMs ?? 60_000;
  const maxSchedules  = options.maxSchedules  ?? 5;

  const minMins  = minIntervalMs / 60_000;
  const descMin  = minMins === 1 ? "1 minute" : `${minMins} minutes`;

  // Late-bound harness: set by main.ts after Harness.open.
  let harnessRef: Harness | undefined;
  function setHarness(h: Harness): void { harnessRef = h; }

  // ── schedule_message ──────────────────────────────────────────────────────

  const scheduleMessageTool = defineTool({
    name: "schedule_message",
    description:
      `Schedule a check-in: at the given times you get a message starting with [Hydra check-in] ` +
      `and do the task described in \`what\`. ` +
      `Use it when your instructions or the user need something done at set times or repeatedly, or for reminders. ` +
      `kind 'every' repeats every \`every_minutes\` (minimum ${descMin}). ` +
      `kind 'daily' runs at \`time\` (HH:MM, local time), optionally on weekdays only. ` +
      `kind 'once' runs once, at \`at\` (HH:MM for the next occurrence, or YYYY-MM-DDTHH:MM) or in \`in_minutes\`. ` +
      `At most ${maxSchedules} active schedules per bot.`,
    parameters: {
      type: "object" as const,
      properties: {
        what: {
          type: "string" as const,
          description: "What the bot should do or say when the check-in fires.",
        },
        kind: {
          type: "string" as const,
          enum: ["every", "daily", "once"],
          description:
            "'every' = recurring interval; 'daily' = once per day at a time; 'once' = single future fire.",
        },
        every_minutes: {
          type: "number" as const,
          description: "Required for kind='every'. Interval in minutes between fires.",
        },
        time: {
          type: "string" as const,
          description: "Required for kind='daily'. Local time 'HH:MM' (24-hour).",
        },
        weekdays_only: {
          type: "boolean" as const,
          description: "Optional for kind='daily'. Skip Saturday and Sunday.",
        },
        at: {
          type: "string" as const,
          description:
            "Required for kind='once' when in_minutes is absent. " +
            "Either 'HH:MM' (next occurrence today or tomorrow) or 'YYYY-MM-DDTHH:MM'.",
        },
        in_minutes: {
          type: "number" as const,
          description:
            "Required for kind='once' when 'at' is absent. Fire after this many minutes from now.",
        },
      },
      required: ["what", "kind"],
    },

    execute: async (rawArgs, api, ctx: Context): Promise<ToolExecutionResult> => {
      const args = rawArgs as {
        what?: unknown;
        kind?: unknown;
        every_minutes?: unknown;
        time?: unknown;
        weekdays_only?: unknown;
        at?: unknown;
        in_minutes?: unknown;
      };

      const toolErr = (msg: string): ToolExecutionResult => ({
        output: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      });

      if (!(await latestUserInputIsHuman(api, ctx))) {
        return { output: [{ type: "text", text: NOT_REQUESTED_TEXT }], isError: true };
      }

      const what = typeof args.what === "string" ? args.what.trim() : "";
      if (!what) return toolErr("'what' is required and must be a non-empty string.");

      const kind = args.kind;
      const nowMs = Date.now();
      let rule: StoredRule;
      let firstAt: number;

      // Maximum interval / lead-time: 525 600 minutes = exactly 1 year (365 days).
      const MAX_MINUTES = 525_600;

      if (kind === "every") {
        const em = typeof args.every_minutes === "number" ? args.every_minutes : null;
        if (em == null || !Number.isFinite(em) || em <= 0) {
          return toolErr("kind='every' requires a positive 'every_minutes' number.");
        }
        if (em > MAX_MINUTES) {
          return toolErr(`'every_minutes' must be at most ${MAX_MINUTES} minutes (1 year). Got ${em}.`);
        }
        const intervalMs = em * 60_000;
        if (intervalMs < minIntervalMs) {
          return toolErr(
            `Minimum interval is ${descMin} (${em} given).`,
          );
        }
        rule    = { kind: "every", every_minutes: em };
        firstAt = nowMs + intervalMs;

      } else if (kind === "daily") {
        const t = typeof args.time === "string" ? args.time : null;
        if (!t) {
          return toolErr("kind='daily' requires a 'time' field in 'HH:MM' format.");
        }
        if (!/^\d{1,2}:\d{2}$/.test(t)) {
          return toolErr(`'time' must be in 'HH:MM' format, got '${t}'.`);
        }
        const [hStr, mStr] = t.split(":");
        const h = Number(hStr);
        const m = Number(mStr);
        if (h < 0 || h > 23 || m < 0 || m > 59) {
          return toolErr(`Invalid time '${t}': hours must be 0–23, minutes 0–59.`);
        }
        const wo = args.weekdays_only === true;
        rule    = { kind: "daily", time: t, weekdays_only: wo };
        firstAt = nextRunAt(rule, nowMs);

      } else if (kind === "once") {
        const atStr = typeof args.at === "string" ? args.at : null;
        const inMins = typeof args.in_minutes === "number" ? args.in_minutes : null;

        if (atStr !== null && inMins !== null) {
          return toolErr("Specify either 'at' or 'in_minutes' for kind='once', not both.");
        }
        if (atStr === null && inMins === null) {
          return toolErr(
            "kind='once' requires either 'at' (local time or date-time) or 'in_minutes'.",
          );
        }

        if (inMins !== null) {
          if (!Number.isFinite(inMins) || inMins <= 0) {
            return toolErr("'in_minutes' must be a positive number.");
          }
          if (inMins > MAX_MINUTES) {
            return toolErr(`'in_minutes' must be at most ${MAX_MINUTES} minutes (1 year). Got ${inMins}.`);
          }
          firstAt = nowMs + inMins * 60_000;
        } else {
          const parsed = parseAtField(atStr!, nowMs);
          if ("error" in parsed) return toolErr(parsed.error);
          firstAt = parsed.ms;
        }

        if (firstAt <= nowMs) {
          return toolErr(
            `The scheduled time is in the past (${fmtLocalTime(firstAt)}). Please choose a future time.`,
          );
        }
        // Cap once/at results to at most 1 year from now.
        if (firstAt > nowMs + MAX_MINUTES * 60_000) {
          return toolErr(
            `The scheduled time is more than 1 year from now (${fmtLocalTime(firstAt)}). Please choose an earlier time.`,
          );
        }
        rule = { kind: "once" };

      } else {
        return toolErr(
          `Unknown kind '${String(kind)}'. Must be 'every', 'daily', or 'once'.`,
        );
      }

      // Sanity: every path above must produce a finite, valid timestamp.
      if (!isFinite(firstAt) || isNaN(new Date(firstAt).getTime())) {
        return toolErr("Internal: computed timestamp is not a valid date. Please report this error.");
      }

      const summary = ruleText(rule, firstAt);

      // ── Atomically count active schedules, create task, write doc entry ────
      //
      // One api.commit does all three in a single storage write, closing both
      // the crash window (a task with no doc entry is unlisted and uncancellable)
      // and the parallel-calls race on the active-schedule limit.
      // Tools default to replay:'unsafe', so an interrupted execute is not
      // re-executed; no memo dedup is needed.
      const result = await api.commit(async (tx) => {
        const doc = await tx.doc(
          SchedulesDoc as ConversationDocToken<{ schedules: Record<string, Record<string, string | number>> }>,
          api.conversationId,
        );

        const activeCount = Object.keys(doc.schedules).length;
        if (activeCount >= maxSchedules) {
          return { ok: false as const };
        }

        const id = await tx.createTask(
          CheckInTask,
          {
            convId: api.conversationId as number,
            what,
            rule,
            ruleSummary: summary,
            firstAt,
          },
          {
            ownership: { kind: "conversation" as const },
            background: true,
            conversationId: api.conversationId,
          },
        );

        doc.schedules[String(id)] = entryToRecord({
          what,
          rule: summary,
          nextAt: firstAt,
          createdAt: nowMs,
        });

        return { ok: true as const, id };
      }, ctx);

      if (!result.ok) {
        const n = Object.keys(
          (await api.snapshot(
            SchedulesDoc as ConversationDocToken<{ schedules: Record<string, Record<string, string | number>> }>,
            api.conversationId,
            ctx,
          ))?.schedules ?? {},
        ).length;
        return toolErr(
          `This bot already has ${n} active schedule${n === 1 ? "" : "s"} ` +
          `(maximum is ${maxSchedules}). Cancel one first.`,
        );
      }

      const taskId = result.id;
      return {
        output: [
          {
            type: "text",
            text: `Scheduled (id: ${String(taskId)}). ${summary}. Next run: ${fmtLocalTime(firstAt)}.`,
          },
        ],
      };
    },
  });

  // ── list_schedules ────────────────────────────────────────────────────────

  const listSchedulesTool = defineTool({
    name: "list_schedules",
    description: "List this bot's active schedules with their ids and next run times.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },

    execute: async (_rawArgs, api, ctx: Context): Promise<ToolExecutionResult> => {
      const doc = await api.snapshot(
        SchedulesDoc as ConversationDocToken<{ schedules: Record<string, Record<string, string | number>> }>,
        api.conversationId,
        ctx,
      );

      const entries = Object.entries(doc?.schedules ?? {});
      if (entries.length === 0) {
        return { output: [{ type: "text", text: "No active schedules." }] };
      }

      const lines = entries.map(([id, raw]) => {
        const e = recordToEntry(raw as Record<string, string | number>);
        return `- id: ${id} | ${e.rule} | next: ${fmtLocalTime(e.nextAt)} | what: ${e.what}`;
      });

      return {
        output: [{ type: "text", text: `Active schedules:\n${lines.join("\n")}` }],
      };
    },
  });

  // ── cancel_schedule ───────────────────────────────────────────────────────

  const cancelScheduleTool = defineTool({
    name: "cancel_schedule",
    description: "Cancel one of this bot's schedules by id.",
    parameters: {
      type: "object" as const,
      properties: {
        id: {
          type: "number" as const,
          description: "The schedule id returned by schedule_message or list_schedules.",
        },
      },
      required: ["id"],
    },

    // Real models send {"id": 12}; some may send {"id": "12"}.
    // Convert a numeric string to number so the Harness validation passes.
    prepareArguments(args: unknown) {
      const a = args as Record<string, unknown>;
      const id = a["id"];
      const numId = typeof id === "string" ? Number(id) : id;
      return { ...a, id: numId } as { id: number };
    },

    execute: async (rawArgs, api, ctx: Context): Promise<ToolExecutionResult> => {
      const args = rawArgs as { id?: unknown };

      const toolErr = (msg: string): ToolExecutionResult => ({
        output: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      });

      // id arrives as a number (validated by schema + prepareArguments).
      const idNum = typeof args.id === "number" ? args.id : null;
      if (idNum == null || !Number.isFinite(idNum)) {
        return toolErr("'id' is required and must be a number.");
      }
      const id = String(idNum);

      // Verify the schedule belongs to this conversation.
      const doc = await api.snapshot(
        SchedulesDoc as ConversationDocToken<{ schedules: Record<string, Record<string, string | number>> }>,
        api.conversationId,
        ctx,
      );

      if (!doc?.schedules[id]) {
        return toolErr(`Schedule '${id}' not found.`);
      }

      if (!harnessRef) {
        return toolErr("Internal error: harness not available.");
      }

      const taskId = idNum as unknown as TaskId<void>;
      const abortResult = await harnessRef.abortTask(taskId, ctx);

      return {
        output: [
          {
            type: "text",
            text: `Schedule '${id}' cancelled (result: ${abortResult}).`,
          },
        ],
      };
    },
  });

  // ── Build extension ───────────────────────────────────────────────────────

  const extension: Extension = defineExtension({
    name: "hydra-schedules",
    tools: [scheduleMessageTool, listSchedulesTool, cancelScheduleTool],
    tasks: [CheckInTask],
  });

  return { extension, setHarness };
}
