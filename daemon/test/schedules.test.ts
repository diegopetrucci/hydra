/**
 * schedules.test.ts
 *
 * Acceptance tests for the bot-scheduled check-ins extension.
 *
 * All tests use the pi-ai faux provider (no network).
 * MemoryStorage is used for most tests; SQLite in a temp dir for test (c).
 *
 * Acceptance criteria (ticket nb-9l37):
 *  (a) schedule_message creates a background task, reply completes, list_schedules shows it
 *  (b) short-interval schedule fires ≥2×; each check-in produces message.started/completed;
 *      bots.history hides the check-in triggers
 *  (c) SQLite in temp dir: close mid-sleep, reopen after due → fires exactly once
 *  (d) cancel_schedule stops further check-ins and doc shows cancelled
 *  (e) bots.stop does NOT cancel a schedule
 *  (f) validation rejects: below minimum interval, 6th schedule, past 'once',
 *      unknown id, other bot's id
 *  (g) nextRunAt and parseAtField unit tests
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, it, expect, afterEach } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  MemoryStorage,
  ToolResultEntry,
  createRegistry,
} from "@earendil-works/pi-durable";
import type {
  ConversationDocToken,
  ConversationId,
  Cursor,
  EntryRecord,
  Storage,
  TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxProviderHandle, FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createTestModels } from "../src/models.js";
import { DaemonCore } from "../src/daemon-core.js";
import {
  createSchedulesExtension,
  nextRunAt,
  parseAtField,
  fmtLocalTime,
  checkInPrompt,
  CHECKIN_MARKER,
  SCHEDULE_TOOL_NAMES,
  SchedulesDoc,
} from "../src/schedules.js";
import type { ProtocolEvent } from "../src/protocol.js";

const ctx = BACKGROUND_CONTEXT;

// ─── Unconditional teardown ───────────────────────────────────────────────────
// makeSchedulesCore() registers every fixture it creates here.
// afterEach closes all of them (idempotent), then removes any tmp dirs that
// were registered via _tmpDirsToClean (so dirs are never removed before their
// SQLite handles are closed).
const _openFixtures: Array<{ core: DaemonCore; harness: Harness }> = [];
const _tmpDirsToClean: string[] = [];

afterEach(async () => {
  for (const { core, harness } of _openFixtures) {
    await core.close().catch(() => {});
    await harness.close(ctx).catch(() => {});
  }
  _openFixtures.length = 0;
  for (const dir of _tmpDirsToClean) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  _tmpDirsToClean.length = 0;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type BotResult = { id: string };
type MsgResult = { id: string; role: string; text: string };
type CompletedEvent = ProtocolEvent & {
  event: "message.completed";
  botId: string;
  message: MsgResult;
};

/** Count message.completed events in the events array. */
function completedCount(events: ProtocolEvent[], botId?: string): number {
  return events.filter((e) => {
    if (e.type !== "event" || e.event !== "message.completed") return false;
    if (botId && "botId" in e && (e as { botId: string }).botId !== botId) return false;
    return true;
  }).length;
}

/** Extract text from a faux transcript message content. */
function msgText(msg: { role: string; content: unknown }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}

/**
 * A smart faux responder:
 *  - After a tool result → "Done."
 *  - After a check-in trigger → "Check-in handled."
 *  - Otherwise → schedule_message tool call with scheduleArgs
 */
function makeScheduleResponder(scheduleArgs: Record<string, unknown>): FauxResponseFactory {
  return (context: TranscriptContext) => {
    const msgs = context.messages;
    const last = [...msgs].reverse().find((m) => m.role !== "system");
    if (!last) return fauxAssistantMessage(fauxText("ok"));
    if (last.role === "toolResult") return fauxAssistantMessage(fauxText("Done."));
    const text = msgText(last);
    if (text.startsWith(CHECKIN_MARKER)) return fauxAssistantMessage(fauxText("Check-in handled."));
    return fauxAssistantMessage(
      fauxToolCall("schedule_message", { what: "say hi", ...scheduleArgs }),
      { stopReason: "toolUse" },
    );
  };
}

/**
 * A responder that calls cancel_schedule with the given id.
 * Also handles check-in triggers that arrive before the cancel is processed.
 */
function makeCancelResponder(getScheduleId: () => string): FauxResponseFactory {
  return (context: TranscriptContext) => {
    const msgs = context.messages;
    const last = [...msgs].reverse().find((m) => m.role !== "system");
    if (!last) return fauxAssistantMessage(fauxText("ok"));
    if (last.role === "toolResult") return fauxAssistantMessage(fauxText("Cancelled."));
    const text = msgText(last);
    if (text.startsWith(CHECKIN_MARKER)) return fauxAssistantMessage(fauxText("Check-in handled."));
    return fauxAssistantMessage(fauxToolCall("cancel_schedule", { id: getScheduleId() }), {
      stopReason: "toolUse",
    });
  };
}

/**
 * Build a DaemonCore with the schedules extension installed.
 * minIntervalMs=0 by default (no minimum); set to 60_000 for production-limit tests.
 */
async function makeSchedulesCore(
  storage: Storage = new MemoryStorage(),
  options: { minIntervalMs?: number; maxSchedules?: number } = {},
): Promise<{
  core: DaemonCore;
  events: ProtocolEvent[];
  faux: FauxProviderHandle;
  harness: Harness;
  setHarness: (h: Harness) => void;
}> {
  const { models, faux } = await createTestModels();

  const { extension: schedulesExt, setHarness } = createSchedulesExtension({
    minIntervalMs: options.minIntervalMs ?? 0,
    maxSchedules: options.maxSchedules ?? 5,
  });

  const registry = createRegistry();
  registry.install(schedulesExt);

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: { progress: { partialIntervalMs: 100, outputIntervalMs: 100 } },
    },
    ctx,
  );
  setHarness(harness);

  const events: ProtocolEvent[] = [];
  const core = new DaemonCore(
    harness,
    models,
    (ev) => events.push(ev),
    ctx,
    undefined,
    undefined,
    [...SCHEDULE_TOOL_NAMES],
    undefined,
    false, // enableIntro: false
  );
  await core.start();

  // Register for unconditional afterEach teardown.
  _openFixtures.push({ core, harness });

  return { core, events, faux, harness, setHarness };
}

/** Create a bot and return its id. */
async function createBot(core: DaemonCore, name = "Test Bot"): Promise<string> {
  const res = await core.handleRequest({
    id: "create",
    type: "bots.create",
    name,
    instructions: "",
    model: "faux/faux-1",
  });
  expect(res.type).toBe("result");
  return (res as { result: BotResult }).result.id;
}

/** Read the SchedulesDoc for a bot (by its conversationId). */
async function readSchedulesDoc(
  harness: Harness,
  botId: string,
): Promise<{ schedules: Record<string, Record<string, string | number>> } | undefined> {
  return harness.snapshot(
    SchedulesDoc as ConversationDocToken<{
      schedules: Record<string, Record<string, string | number>>;
    }>,
    Number(botId) as ConversationId,
    ctx,
  );
}

/**
 * Read the last tool-result entry from a bot's conversation transcript.
 * Returns { isError, text } or undefined if no tool results exist.
 */
async function getLastToolResult(
  harness: Harness,
  botId: string,
): Promise<{ isError: boolean; text: string } | undefined> {
  const conv = await harness.conversation(Number(botId) as ConversationId, ctx);
  if (!conv) return undefined;

  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conv.entries({}, 100, cursor, ctx);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);

  // conv.entries() returns entries newest-first (see allEntries + reverse() in daemon-core.ts),
  // so toolResults[0] is the most-recent tool result.
  const toolResults = entries.filter((e) => ToolResultEntry.is(e));
  if (toolResults.length === 0) return undefined;

  const last = toolResults[0]!;
  const msg = last.model?.[0] as
    | { isError: boolean; content: Array<{ type: string; text?: string }> }
    | undefined;
  if (!msg) return undefined;

  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  return { isError: msg.isError, text };
}

// ─── Test (a): schedule_message creates task; list_schedules shows it ─────────

describe("(a) schedule_message and list_schedules", () => {
  it("creates a background task; reply completes; schedule appears in the doc", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();
    try {
      // every_minutes ≈ 0.017 = 1 second between fires
      const schedArgs = { kind: "every", every_minutes: 1 / 60 };
      faux.setResponses(Array.from({ length: 30 }, () => makeScheduleResponder(schedArgs)));

      const botId = await createBot(core);

      await core.handleRequest({
        id: "s1",
        type: "bots.send",
        botId,
        text: "Schedule a greeting every minute",
        clientMessageId: "cm-sched-1",
      });

      // A tool-call turn emits no message.* (empty text); only the text reply
      // ("Done.") produces a message.completed.
      await waitFor(() => completedCount(events, botId) >= 1);

      // The second completion should have non-empty text
      const textCompletion = events
        .filter((e) => e.type === "event" && e.event === "message.completed")
        .map((e) => e as CompletedEvent)
        .find((e) => e.message.text !== "");
      expect(textCompletion?.message.text?.length).toBeGreaterThan(0);

      // Active = present in doc; all entries are active.
      const doc = await readSchedulesDoc(harness, botId);
      expect(doc).toBeDefined();
      expect(Object.keys(doc!.schedules).length).toBeGreaterThanOrEqual(1);
    } finally {
      await core.close().catch(() => {});
      await harness.close(ctx).catch(() => {});
    }
  });
});

// ─── Test (b): check-ins fire; history hides triggers ────────────────────────

describe("(b) recurring check-ins and bots.history filtering", () => {
  it("fires ≥2 times; produces message.started/completed; bots.history hides check-in triggers", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();
    try {
      // ~1 second intervals
      const schedArgs = { kind: "every", every_minutes: 1 / 60 };
      faux.setResponses(Array.from({ length: 50 }, () => makeScheduleResponder(schedArgs)));

      const botId = await createBot(core);

      await core.handleRequest({
        id: "b1",
        type: "bots.send",
        botId,
        text: "Schedule a check-in every minute",
        clientMessageId: "cm-b-1",
      });

      // Each schedule_message call = 1 message.completed (text reply only).
      // Each check-in = 1 message.completed (text only, no tool calls).
      // So: 1 (schedule) + 2 (2 check-ins) = 3 minimum.
      await waitFor(() => completedCount(events, botId) >= 3, 15_000);

      // message.started also arrived for each response (at least 3 total)
      const started = events.filter(
        (e) =>
          e.type === "event" &&
          e.event === "message.started" &&
          "botId" in e &&
          (e as { botId: string }).botId === botId,
      );
      expect(started.length).toBeGreaterThanOrEqual(3);

      // bots.history must hide the check-in triggers
      const histRes = await core.handleRequest({ id: "b2", type: "bots.history", botId });
      expect(histRes.type).toBe("result");
      const msgs = (histRes as { result: MsgResult[] }).result;

      // No user entry should start with CHECKIN_MARKER
      const hidden = msgs.filter((m) => m.role === "user" && m.text.startsWith(CHECKIN_MARKER));
      expect(hidden.length).toBe(0);

      // At least 1 user message (the original "Schedule…" request) is visible
      const userMsgs = msgs.filter((m) => m.role === "user");
      expect(userMsgs.length).toBeGreaterThanOrEqual(1);

      // bots.history skips empty-text assistant messages (tool call responses).
      // We expect: "Done." + 2×"Check-in handled." = at least 3 assistant messages.
      const asstMsgs = msgs.filter((m) => m.role === "assistant");
      expect(asstMsgs.length).toBeGreaterThanOrEqual(3);
    } finally {
      await core.close().catch(() => {});
      await harness.close(ctx).catch(() => {});
    }
  });
});

// ─── Test (c): close mid-sleep, reopen after due → fires exactly once ────────

describe("(c) SQLite: close mid-sleep, reopen after due", () => {
  it("fires exactly once after reopening a harness past the due time", async () => {
    // Register tmpDir for afterEach removal so it is always removed AFTER
    // all fixtures (including core1/harness1) have been closed.
    const tmpDir = await mkdtemp(join(tmpdir(), "hydra-sched-test-"));
    _tmpDirsToClean.push(tmpDir);
    {
      const dbPath = join(tmpDir, "harness.sqlite");

      // ── Open first harness ───────────────────────────────────────────────
      const storage1 = await openNodeSqliteStorage(dbPath);
      const {
        core: core1,
        events: events1,
        faux: faux1,
        harness: harness1,
      } = await makeSchedulesCore(storage1);

      // Schedule a once check-in ~2 seconds from now
      const schedArgs = { kind: "once", in_minutes: 2 / 60 };
      faux1.setResponses(Array.from({ length: 10 }, () => makeScheduleResponder(schedArgs)));

      const botId = await createBot(core1, "Reopen Bot");

      await core1.handleRequest({
        id: "c1",
        type: "bots.send",
        botId,
        text: "Schedule once in 2 seconds",
        clientMessageId: "cm-c-1",
      });

      // The text reply is the only message.completed; wait for it before closing.
      // This ensures no pending incomplete generation remains in the database.
      await waitFor(() => completedCount(events1, botId) >= 1, 8_000);

      // Close mid-sleep (before the 2-second delay fires)
      await core1.close();
      await harness1.close(ctx);

      // Wait past the due time
      await sleep(3_000);

      // ── Reopen ──────────────────────────────────────────────────────────
      const storage2 = await openNodeSqliteStorage(dbPath);
      const {
        core: core2,
        events: events2,
        faux: faux2,
        harness: harness2,
      } = await makeSchedulesCore(storage2);

      try {
        // Set up faux for the check-in generation that fires on resume
        faux2.setResponses(Array.from({ length: 20 }, () => makeScheduleResponder(schedArgs)));

        // Wait for exactly 1 check-in message.completed
        await waitFor(() => completedCount(events2, botId) >= 1, 8_000);

        // Give extra time to confirm no second fire
        await sleep(2_000);

        expect(completedCount(events2, botId)).toBe(1);

        // Once schedule fired; its doc entry was deleted (active = present in doc)
        const doc = await readSchedulesDoc(harness2, botId);
        expect(Object.keys(doc?.schedules ?? {}).length).toBe(0);
      } finally {
        // Close unconditionally even if assertions failed (afterEach also covers this).
        await core2.close().catch(() => {});
        await harness2.close(ctx).catch(() => {});
      }
    }
  });
});

// ─── Test (d): cancel_schedule stops further check-ins ───────────────────────

describe("(d) cancel_schedule", () => {
  it("stops further check-ins and marks doc entry as cancelled", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();
    try {
      // ~1-second intervals
      const schedArgs = { kind: "every", every_minutes: 1 / 60 };
      faux.setResponses(Array.from({ length: 30 }, () => makeScheduleResponder(schedArgs)));

      const botId = await createBot(core);

      // Schedule
      await core.handleRequest({
        id: "d1",
        type: "bots.send",
        botId,
        text: "Schedule a check-in",
        clientMessageId: "cm-d-1",
      });

      // schedule_message produces 1 completion ("Done.") then each check-in = 1.
      // Wait for at least 2: 1 (schedule) + 1 (check-in #1).
      await waitFor(() => completedCount(events, botId) >= 2, 10_000);

      // Read the schedule id (active = present in doc)
      const doc = await readSchedulesDoc(harness, botId);
      const scheduleId = Object.keys(doc?.schedules ?? {})[0];
      expect(scheduleId).toBeDefined();

      // Switch to cancel responder
      faux.setResponses(Array.from({ length: 20 }, () => makeCancelResponder(() => scheduleId!)));

      await core.handleRequest({
        id: "d2",
        type: "bots.send",
        botId,
        text: "cancel the schedule",
        clientMessageId: "cm-d-cancel",
      });

      // Wait for the task to reach terminal state (abort handler has run).
      // This is the reliable indicator: terminal = no more check-ins possible.
      const taskId = Number(scheduleId) as TaskId<void>;
      await waitFor(async () => {
        const task = await harness.getTask(taskId, ctx);
        return task?.state.status === "terminal";
      }, 10_000);

      // Entry deleted = cancelled (active means present in doc)
      const docAfter = await readSchedulesDoc(harness, botId);
      expect(docAfter!.schedules[scheduleId!]).toBeUndefined();
    } finally {
      await core.close().catch(() => {});
      await harness.close(ctx).catch(() => {});
    }
  });
});

// ─── Test (e): bots.stop does not cancel a schedule ──────────────────────────

describe("(e) bots.stop does not cancel schedules", () => {
  it("schedule fires after bots.stop", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();
    try {
      // ~2-second intervals (so we can stop then observe the fire)
      const schedArgs = { kind: "every", every_minutes: 2 / 60 };
      faux.setResponses(Array.from({ length: 30 }, () => makeScheduleResponder(schedArgs)));

      const botId = await createBot(core);

      await core.handleRequest({
        id: "e1",
        type: "bots.send",
        botId,
        text: "Schedule a check-in",
        clientMessageId: "cm-e-1",
      });

      // Wait for confirmation
      await waitFor(() => completedCount(events, botId) >= 1, 8_000);

      // Stop the conversation (like clicking Stop in the UI)
      await core.handleRequest({ id: "e2", type: "bots.stop", botId });

      // bots.stop should NOT cancel the background task.
      // The task should fire → 1 more completion (check-in response).
      // Wait for total >= 2 (1 from schedule + 1 from check-in after stop).
      await waitFor(() => completedCount(events, botId) >= 2, 12_000);

      // Schedule is still active (entry still present in doc)
      const doc = await readSchedulesDoc(harness, botId);
      expect(Object.keys(doc?.schedules ?? {}).length).toBeGreaterThanOrEqual(1);
    } finally {
      await core.close().catch(() => {});
      await harness.close(ctx).catch(() => {});
    }
  });
});

// ─── Test (f): validation rejections ─────────────────────────────────────────

describe("(f) validation rejections", () => {
  it("rejects every_minutes below the minimum interval (production: 1 minute)", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore(new MemoryStorage(), {
      minIntervalMs: 60_000,
    });

    // Try to schedule with 0.5 minutes = 30 seconds < 1 minute minimum
    faux.setResponses(
      Array.from({ length: 10 }, () =>
        makeScheduleResponder({ kind: "every", every_minutes: 0.5 }),
      ),
    );

    const botId = await createBot(core);
    await core.handleRequest({
      id: "fv1",
      type: "bots.send",
      botId,
      text: "schedule every 30 seconds",
      clientMessageId: "cm-fv-1",
    });

    // Wait for the FINAL reply: "Done." only; the text-less tool-call turn emits no message.*
    await waitFor(() => completedCount(events, botId) >= 1, 8_000);

    // Tool result must be an error mentioning the minimum interval
    const tr = await getLastToolResult(harness, botId);
    expect(tr?.isError).toBe(true);
    expect(tr?.text).toContain("Minimum interval");

    // No schedule created (active = present in doc)
    const doc = await readSchedulesDoc(harness, botId);
    expect(Object.keys(doc?.schedules ?? {}).length).toBe(0);
  });

  it("rejects a schedule when maxSchedules is already reached", async () => {
    // maxSchedules: 1 so only one successful send is needed before rejection.
    // Each send takes ~5s (faux streams tool-call JSON at 3 tps); 2 sends × 5s = 10s < 15s timeout.
    // Use a 2-minute interval to prevent check-ins from firing during the test.
    const { core, events, faux, harness } = await makeSchedulesCore(new MemoryStorage(), {
      minIntervalMs: 0,
      maxSchedules: 1,
    });

    const schedArgs = { kind: "every", every_minutes: 2 };
    faux.setResponses(Array.from({ length: 6 }, () => makeScheduleResponder(schedArgs)));

    const botId = await createBot(core);

    // Schedule 1 (success): wait for both completions (tool-call + "Done.")
    let countBefore = completedCount(events, botId);
    await core.handleRequest({
      id: "fv2a",
      type: "bots.send",
      botId,
      text: "schedule 1",
      clientMessageId: "cm-fv-2a",
    });
    await waitFor(() => completedCount(events, botId) >= countBefore + 1, 8_000);

    // Schedule 2 (rejected – maxSchedules=1): wait for FINAL reply (tool-call + "Done.")
    countBefore = completedCount(events, botId);
    await core.handleRequest({
      id: "fv2b",
      type: "bots.send",
      botId,
      text: "schedule 2",
      clientMessageId: "cm-fv-2b",
    });
    await waitFor(() => completedCount(events, botId) >= countBefore + 1, 8_000);

    // Tool result must be an error mentioning the limit
    const tr = await getLastToolResult(harness, botId);
    expect(tr?.isError).toBe(true);
    expect(tr?.text).toContain("already has");

    // Doc has exactly 1 entry (the successful schedule; rejected one was never created)
    const doc = await readSchedulesDoc(harness, botId);
    expect(Object.keys(doc?.schedules ?? {}).length).toBe(1);
  });

  it("rejects a past 'once' schedule (YYYY-MM-DDTHH:MM format)", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();

    const pastMs = Date.now() - 5 * 60_000;
    const d = new Date(pastMs);
    const pad = (n: number) => n.toString().padStart(2, "0");
    const pastDt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

    faux.setResponses(
      Array.from({ length: 10 }, () => makeScheduleResponder({ kind: "once", at: pastDt })),
    );

    const botId = await createBot(core);
    await core.handleRequest({
      id: "fv3",
      type: "bots.send",
      botId,
      text: "schedule in the past",
      clientMessageId: "cm-fv-3",
    });

    // Wait for the FINAL reply: "Done." only; the text-less tool-call turn emits no message.*
    await waitFor(() => completedCount(events, botId) >= 1, 8_000);

    // Tool result must be an error mentioning the past
    const tr = await getLastToolResult(harness, botId);
    expect(tr?.isError).toBe(true);
    expect(tr?.text).toContain("past");

    const doc = await readSchedulesDoc(harness, botId);
    const schedCount = Object.keys(doc?.schedules ?? {}).length;
    expect(schedCount).toBe(0);
  });

  it("rejects cancel_schedule with an unknown id", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();

    // First, create a real schedule (every 10 minutes so it won't fire during this test)
    faux.setResponses(
      Array.from({ length: 10 }, () => makeScheduleResponder({ kind: "every", every_minutes: 10 })),
    );
    const botId = await createBot(core);
    await core.handleRequest({
      id: "fv4-sched",
      type: "bots.send",
      botId,
      text: "schedule every 10 minutes",
      clientMessageId: "cm-fv-4-sched",
    });
    await waitFor(() => completedCount(events, botId) >= 1, 8_000);

    // Read the real schedule id
    const docBefore = await readSchedulesDoc(harness, botId);
    const realId = Object.keys(docBefore?.schedules ?? {})[0];
    expect(realId).toBeDefined();
    const realTaskId = Number(realId) as import("@earendil-works/pi-durable").TaskId<void>;

    // Now try to cancel a non-existent id
    const cancelResponder: FauxResponseFactory = (context: TranscriptContext) => {
      const last = [...context.messages].reverse().find((m) => m.role !== "system");
      if (!last) return fauxAssistantMessage(fauxText("ok"));
      if (last.role === "toolResult") return fauxAssistantMessage(fauxText("Cancelled."));
      return fauxAssistantMessage(fauxToolCall("cancel_schedule", { id: 99999999 }), {
        stopReason: "toolUse",
      });
    };
    faux.setResponses(Array.from({ length: 10 }, () => cancelResponder));

    const countBefore = completedCount(events, botId);
    await core.handleRequest({
      id: "fv4-cancel",
      type: "bots.send",
      botId,
      text: "cancel 99999999",
      clientMessageId: "cm-fv-4-cancel",
    });
    // Wait for final reply: tool-call message + "Cancelled."
    await waitFor(() => completedCount(events, botId) >= countBefore + 1, 8_000);

    // Tool result must be an error mentioning "not found"
    const tr = await getLastToolResult(harness, botId);
    expect(tr?.isError).toBe(true);
    expect(tr?.text).toContain("not found");

    // Real schedule's task must still be non-terminal
    const task = await harness.getTask(realTaskId, ctx);
    expect(task?.state.status).not.toBe("terminal");

    // Real schedule's doc entry must still be present
    const docAfter = await readSchedulesDoc(harness, botId);
    expect(docAfter?.schedules[realId!]).toBeDefined();
  });

  it("rejects cancel_schedule for another bot's schedule id", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();

    // Bot A: create a long-interval schedule so it doesn't fire during the test
    faux.setResponses(
      Array.from({ length: 20 }, () => makeScheduleResponder({ kind: "every", every_minutes: 10 })),
    );

    const botA = await createBot(core, "Bot A");
    await core.handleRequest({
      id: "fv5a",
      type: "bots.send",
      botId: botA,
      text: "schedule",
      clientMessageId: "cm-fv-5a",
    });
    // Wait for bot A's final reply
    await waitFor(() => completedCount(events, botA) >= 1, 8_000);

    // Get bot A's schedule id
    const docA = await readSchedulesDoc(harness, botA);
    const schedIdA = Object.keys(docA?.schedules ?? {})[0];
    expect(schedIdA).toBeDefined();
    const taskIdA = Number(schedIdA) as import("@earendil-works/pi-durable").TaskId<void>;

    // Bot B: try to cancel bot A's schedule
    const botB = await createBot(core, "Bot B");
    faux.setResponses(Array.from({ length: 10 }, () => makeCancelResponder(() => schedIdA!)));

    const countBefore = completedCount(events, botB);
    await core.handleRequest({
      id: "fv5b",
      type: "bots.send",
      botId: botB,
      text: "cancel schedule",
      clientMessageId: "cm-fv-5b",
    });
    // Wait for bot B's final reply: tool-call message + "Cancelled."
    await waitFor(() => completedCount(events, botB) >= countBefore + 1, 8_000);

    // Bot B's tool result must be an error (schedule belongs to bot A, not bot B)
    const trB = await getLastToolResult(harness, botB);
    expect(trB?.isError).toBe(true);
    expect(trB?.text).toContain("not found");

    // Bot A's task must still be non-terminal
    const taskA = await harness.getTask(taskIdA, ctx);
    expect(taskA?.state.status).not.toBe("terminal");

    // Bot A's schedule entry must still be present in doc
    const docAAfter = await readSchedulesDoc(harness, botA);
    expect(docAAfter!.schedules[schedIdA!]).toBeDefined();
  });
});

// ─── Test: list_schedules through model ─────────────────────────────────────

describe("list_schedules via model tool call", () => {
  /** Faux responder that always calls list_schedules, then replies "Listed." */
  function makeListResponder(): FauxResponseFactory {
    return (context: TranscriptContext) => {
      const last = [...context.messages].reverse().find((m) => m.role !== "system");
      if (!last) return fauxAssistantMessage(fauxText("ok"));
      if (last.role === "toolResult") return fauxAssistantMessage(fauxText("Listed."));
      return fauxAssistantMessage(fauxToolCall("list_schedules", {}), { stopReason: "toolUse" });
    };
  }

  it("returns 'No active schedules.' when no schedule exists", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();
    faux.setResponses(Array.from({ length: 10 }, () => makeListResponder()));

    const botId = await createBot(core);
    await core.handleRequest({
      id: "ls1",
      type: "bots.send",
      botId,
      text: "list my schedules",
      clientMessageId: "cm-ls-1",
    });
    await waitFor(() => completedCount(events, botId) >= 1, 8_000);

    const tr = await getLastToolResult(harness, botId);
    expect(tr?.isError).toBeFalsy();
    expect(tr?.text).toBe("No active schedules.");
  });

  it("returns schedule id and 'what' after creating one", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();

    // First, create a schedule
    faux.setResponses(
      Array.from({ length: 10 }, () => makeScheduleResponder({ kind: "every", every_minutes: 10 })),
    );
    const botId = await createBot(core);
    await core.handleRequest({
      id: "ls2a",
      type: "bots.send",
      botId,
      text: "schedule every 10 minutes",
      clientMessageId: "cm-ls-2a",
    });
    await waitFor(() => completedCount(events, botId) >= 1, 8_000);

    // Read the schedule id and what from the doc
    const doc = await readSchedulesDoc(harness, botId);
    const schedId = Object.keys(doc?.schedules ?? {})[0];
    expect(schedId).toBeDefined();
    const entry = doc!.schedules[schedId!] as Record<string, string | number>;
    const what = String(entry["what"]);

    // Now call list_schedules
    faux.setResponses(Array.from({ length: 10 }, () => makeListResponder()));
    const countBefore = completedCount(events, botId);
    await core.handleRequest({
      id: "ls2b",
      type: "bots.send",
      botId,
      text: "list my schedules",
      clientMessageId: "cm-ls-2b",
    });
    await waitFor(() => completedCount(events, botId) >= countBefore + 1, 8_000);

    const tr = await getLastToolResult(harness, botId);
    expect(tr?.isError).toBeFalsy();
    expect(tr?.text).toContain("Active schedules:");
    expect(tr?.text).toContain(schedId!);
    expect(tr?.text).toContain(what);
  });
});

// ─── Consent-first backstop ───────────────────────────────────────────────────

describe("schedule_message consent-first backstop", () => {
  /** schedule_message / list_schedules / cancel_schedule driven by the user text. */
  function makeBackstopResponder(getId: () => string): FauxResponseFactory {
    return (context: TranscriptContext) => {
      const last = [...context.messages].reverse().find((m) => m.role !== "system");
      if (!last) return fauxAssistantMessage(fauxText("ok"));
      if (last.role === "toolResult") return fauxAssistantMessage(fauxText("Done."));
      const text = msgText(last);
      if (text.includes("cancel")) {
        return fauxAssistantMessage(fauxToolCall("cancel_schedule", { id: getId() }), {
          stopReason: "toolUse",
        });
      }
      if (text.includes("list")) {
        return fauxAssistantMessage(fauxToolCall("list_schedules", {}), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(
        fauxToolCall("schedule_message", { what: "say hi", kind: "every", every_minutes: 10 }),
        { stopReason: "toolUse" },
      );
    };
  }

  it("refuses after a marker input (no task/doc); works after a real message; list/cancel work after a marker input", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();
    let schedId = "";
    faux.setResponses(Array.from({ length: 20 }, () => makeBackstopResponder(() => schedId)));
    const botId = await createBot(core);
    const send = (text: string, n: number) =>
      core.handleRequest({
        id: `bs${n}`,
        type: "bots.send",
        botId,
        text,
        clientMessageId: `cm-bs-${n}`,
      });

    // (a) hidden-trigger style input: refused, nothing created.
    await send("[Hydra intro] schedule something", 1);
    await waitFor(() => completedCount(events, botId) >= 1, 8_000);
    const refused = await getLastToolResult(harness, botId);
    expect(refused?.isError).toBe(true);
    expect(refused?.text).toBe(
      "Not started: the user hasn't asked for this yet. Tell them what you'd set up and ask them to confirm first.",
    );
    expect(Object.keys((await readSchedulesDoc(harness, botId))?.schedules ?? {})).toHaveLength(0);

    // (c) real user message: succeeds.
    await send("schedule it", 2);
    await waitFor(() => completedCount(events, botId) >= 2, 8_000);
    const doc = await readSchedulesDoc(harness, botId);
    expect(Object.keys(doc?.schedules ?? {})).toHaveLength(1);
    schedId = Object.keys(doc!.schedules)[0]!;

    // (d) list and cancel remain allowed after a marker input.
    await send("[Hydra check-in] list", 3);
    await waitFor(() => completedCount(events, botId) >= 3, 8_000);
    const listed = await getLastToolResult(harness, botId);
    expect(listed?.isError).toBeFalsy();
    expect(listed?.text).toContain(schedId);

    await send("[Hydra check-in] cancel", 4);
    await waitFor(() => completedCount(events, botId) >= 4, 8_000);
    expect((await getLastToolResult(harness, botId))?.isError).toBeFalsy();
    expect(Object.keys((await readSchedulesDoc(harness, botId))?.schedules ?? {})).toHaveLength(0);
  }, 60_000);
});

// ─── Test: item 5 bounds (every_minutes, in_minutes, at 2 years ahead) ────────

describe("schedule_message bounds (item 5)", () => {
  it("rejects every_minutes > 525600", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();
    faux.setResponses(
      Array.from({ length: 10 }, () =>
        makeScheduleResponder({ kind: "every", every_minutes: 525_601 }),
      ),
    );

    const botId = await createBot(core);
    await core.handleRequest({
      id: "bnd1",
      type: "bots.send",
      botId,
      text: "schedule every 525601 minutes",
      clientMessageId: "cm-bnd-1",
    });
    await waitFor(() => completedCount(events, botId) >= 1, 8_000);

    const tr = await getLastToolResult(harness, botId);
    expect(tr?.isError).toBe(true);
    expect(tr?.text).toContain("525600");

    const doc = await readSchedulesDoc(harness, botId);
    expect(Object.keys(doc?.schedules ?? {}).length).toBe(0);
  });

  it("rejects in_minutes > 525600", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();
    faux.setResponses(
      Array.from({ length: 10 }, () =>
        makeScheduleResponder({ kind: "once", in_minutes: 525_601 }),
      ),
    );

    const botId = await createBot(core);
    await core.handleRequest({
      id: "bnd2",
      type: "bots.send",
      botId,
      text: "schedule once in 525601 minutes",
      clientMessageId: "cm-bnd-2",
    });
    await waitFor(() => completedCount(events, botId) >= 1, 8_000);

    const tr = await getLastToolResult(harness, botId);
    expect(tr?.isError).toBe(true);
    expect(tr?.text).toContain("525600");

    const doc = await readSchedulesDoc(harness, botId);
    expect(Object.keys(doc?.schedules ?? {}).length).toBe(0);
  });

  it("rejects 'at' more than 1 year ahead", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();

    // Compute a date about 2 years from now
    const twoYears = new Date(Date.now() + 2 * 365 * 24 * 60 * 60_000);
    const pad = (n: number) => n.toString().padStart(2, "0");
    const farAt = `${twoYears.getFullYear()}-${pad(twoYears.getMonth() + 1)}-${pad(twoYears.getDate())}T${pad(twoYears.getHours())}:${pad(twoYears.getMinutes())}`;

    faux.setResponses(
      Array.from({ length: 10 }, () => makeScheduleResponder({ kind: "once", at: farAt })),
    );

    const botId = await createBot(core);
    await core.handleRequest({
      id: "bnd3",
      type: "bots.send",
      botId,
      text: `schedule once at ${farAt}`,
      clientMessageId: "cm-bnd-3",
    });
    await waitFor(() => completedCount(events, botId) >= 1, 8_000);

    const tr = await getLastToolResult(harness, botId);
    expect(tr?.isError).toBe(true);
    expect(tr?.text).toContain("1 year");

    const doc = await readSchedulesDoc(harness, botId);
    expect(Object.keys(doc?.schedules ?? {}).length).toBe(0);
  });
});

// ─── Test: item 6 history prefix ─────────────────────────────────────────────

describe("bots.history prefix filtering (item 6)", () => {
  it("hides user entries starting with '[Hydra ' and keeps normal ones", async () => {
    const { core, events, faux } = await makeSchedulesCore();

    // Simple responder: always reply with plain text (no tool calls)
    const plainResponder: FauxResponseFactory = (_context: TranscriptContext) =>
      fauxAssistantMessage(fauxText("got it"));

    faux.setResponses(Array.from({ length: 10 }, () => plainResponder));
    const botId = await createBot(core);

    // Send a message that starts with the HYDRA_MARKER_PREFIX — should be hidden
    await core.handleRequest({
      id: "pfx1",
      type: "bots.send",
      botId,
      text: "[Hydra test-marker] this is a hidden message",
      clientMessageId: "cm-pfx-1",
    });
    await waitFor(() => completedCount(events, botId) >= 1, 8_000);

    // Send a normal message — must be visible
    await core.handleRequest({
      id: "pfx2",
      type: "bots.send",
      botId,
      text: "normal user message",
      clientMessageId: "cm-pfx-2",
    });
    await waitFor(() => completedCount(events, botId) >= 2, 8_000);

    const histRes = await core.handleRequest({ id: "pfx3", type: "bots.history", botId });
    expect(histRes.type).toBe("result");
    const msgs = (histRes as { result: MsgResult[] }).result;

    const userMsgs = msgs.filter((m) => m.role === "user");

    // The prefixed message must NOT appear
    const hidden = userMsgs.filter((m) => m.text.startsWith("[Hydra "));
    expect(hidden.length).toBe(0);

    // The normal message must appear
    const visible = userMsgs.filter((m) => m.text === "normal user message");
    expect(visible.length).toBe(1);
  });
});

// ─── Test (g): nextRunAt unit tests ──────────────────────────────────────────

describe("(g) nextRunAt unit tests", () => {
  it("'every' adds interval to fromMs", () => {
    const from = 1_000_000;
    expect(nextRunAt({ kind: "every", every_minutes: 1 }, from)).toBe(from + 60_000);
    expect(nextRunAt({ kind: "every", every_minutes: 5 }, from)).toBe(from + 300_000);
    expect(nextRunAt({ kind: "every", every_minutes: 0.5 }, from)).toBe(from + 30_000);
  });

  it("'daily' returns next occurrence of HH:MM, rolling to tomorrow when past", () => {
    // 2024-01-15 (Monday) 14:30 local
    const now = new Date(2024, 0, 15, 14, 30, 0, 0).getTime();

    // 14:31 → same day, 1 minute later
    const next1 = nextRunAt({ kind: "daily", time: "14:31", weekdays_only: false }, now);
    const d1 = new Date(next1);
    expect(d1.getHours()).toBe(14);
    expect(d1.getMinutes()).toBe(31);
    expect(d1.getDate()).toBe(15);

    // 14:30 at exactly now → tomorrow
    const next2 = nextRunAt({ kind: "daily", time: "14:30", weekdays_only: false }, now);
    const d2 = new Date(next2);
    expect(d2.getDate()).toBe(16);
    expect(d2.getHours()).toBe(14);
    expect(d2.getMinutes()).toBe(30);

    // 08:00 → already passed today → tomorrow
    const next3 = nextRunAt({ kind: "daily", time: "08:00", weekdays_only: false }, now);
    const d3 = new Date(next3);
    expect(d3.getDate()).toBe(16);
    expect(d3.getHours()).toBe(8);
  });

  it("'daily' weekdays_only skips Saturday and Sunday", () => {
    // 2024-01-12 (Friday) 14:00
    const friday = new Date(2024, 0, 12, 14, 0, 0, 0).getTime();

    // 15:00 on Friday → same day (Friday)
    const next1 = nextRunAt({ kind: "daily", time: "15:00", weekdays_only: true }, friday);
    const d1 = new Date(next1);
    expect(d1.getDay()).toBe(5); // Friday
    expect(d1.getDate()).toBe(12);

    // 13:00 on Friday (past today) → would be Saturday, but weekdays_only → Monday
    const next2 = nextRunAt({ kind: "daily", time: "13:00", weekdays_only: true }, friday);
    const d2 = new Date(next2);
    expect(d2.getDay()).toBe(1); // Monday
    expect(d2.getDate()).toBe(15);
  });

  it("'once' throws (task must terminate after firing)", () => {
    expect(() => nextRunAt({ kind: "once" }, 1_000_000)).toThrow();
  });
});

// ─── Test (g): parseAtField unit tests ───────────────────────────────────────

describe("(g) parseAtField unit tests", () => {
  // 2024-01-15 (Monday) 14:30 local
  const nowMs = new Date(2024, 0, 15, 14, 30, 0, 0).getTime();

  it("'HH:MM' → next occurrence today (future) or tomorrow (past)", () => {
    // 14:31 → same day
    const r1 = parseAtField("14:31", nowMs);
    expect("ms" in r1).toBe(true);
    if ("ms" in r1) {
      const d = new Date(r1.ms);
      expect(d.getHours()).toBe(14);
      expect(d.getMinutes()).toBe(31);
      expect(d.getDate()).toBe(15);
    }

    // 08:00 → already past today → tomorrow
    const r2 = parseAtField("08:00", nowMs);
    expect("ms" in r2).toBe(true);
    if ("ms" in r2) {
      const d = new Date(r2.ms);
      expect(d.getHours()).toBe(8);
      expect(d.getMinutes()).toBe(0);
      expect(d.getDate()).toBe(16);
    }
  });

  it("single-digit hour 'H:MM' is accepted", () => {
    const r = parseAtField("9:05", nowMs);
    expect("ms" in r).toBe(true);
    if ("ms" in r) {
      const d = new Date(r.ms);
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(5);
    }
  });

  it("'YYYY-MM-DDTHH:MM' → exact local date-time", () => {
    const r = parseAtField("2024-03-20T09:00", nowMs);
    expect("ms" in r).toBe(true);
    if ("ms" in r) {
      const d = new Date(r.ms);
      expect(d.getFullYear()).toBe(2024);
      expect(d.getMonth()).toBe(2); // March = index 2
      expect(d.getDate()).toBe(20);
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(0);
    }
  });

  it("rejects invalid hour/minute in 'HH:MM'", () => {
    expect("error" in parseAtField("25:00", nowMs)).toBe(true);
    expect("error" in parseAtField("12:60", nowMs)).toBe(true);
  });

  it("rejects unsupported formats", () => {
    expect("error" in parseAtField("tomorrow", nowMs)).toBe(true);
    expect("error" in parseAtField("2024-01-15", nowMs)).toBe(true); // date only
    expect("error" in parseAtField("2024-01-15 09:00", nowMs)).toBe(true); // space not T
    expect("error" in parseAtField("09:00 AM", nowMs)).toBe(true); // 12-hour format
  });
});

// ─── cancel_schedule id type coercion ──────────────────────────────────────

describe("cancel_schedule id type coercion", () => {
  /** Shared setup: create a schedule and return its id from the doc. */
  async function scheduleAndGetId(
    core: DaemonCore,
    events: ProtocolEvent[],
    faux: FauxProviderHandle,
    botId: string,
  ): Promise<string> {
    const schedArgs = { kind: "every", every_minutes: 1 / 60 };
    faux.setResponses(Array.from({ length: 20 }, () => makeScheduleResponder(schedArgs)));
    await core.handleRequest({
      id: "cid-sched",
      type: "bots.send",
      botId,
      text: "schedule",
      clientMessageId: "cm-cid-sched",
    });
    await waitFor(() => completedCount(events, botId) >= 1, 8_000);
    const doc = await readSchedulesDoc(core["harness"], botId);
    const id = Object.keys(doc?.schedules ?? {})[0];
    expect(id).toBeDefined();
    return id!;
  }

  it("numeric id (as real models send it) cancels the schedule", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();
    const botId = await createBot(core, "Cancel Num Bot");
    const scheduleId = await scheduleAndGetId(core, events, faux, botId);

    // Real models send { id: 57 } (a number)
    const numId = Number(scheduleId);
    const cancelResponder: FauxResponseFactory = (context: TranscriptContext) => {
      const last = [...context.messages].reverse().find((m) => m.role !== "system");
      if (!last) return fauxAssistantMessage(fauxText("ok"));
      if (last.role === "toolResult") return fauxAssistantMessage(fauxText("ok"));
      if (msgText(last).startsWith(CHECKIN_MARKER)) return fauxAssistantMessage(fauxText("hi"));
      return fauxAssistantMessage(
        fauxToolCall("cancel_schedule", { id: numId }), // number
        { stopReason: "toolUse" },
      );
    };
    faux.setResponses(Array.from({ length: 10 }, () => cancelResponder));

    const countBefore = completedCount(events, botId);
    await core.handleRequest({
      id: "cid-cn1",
      type: "bots.send",
      botId,
      text: "cancel",
      clientMessageId: "cm-cid-cn1",
    });
    await waitFor(() => completedCount(events, botId) >= countBefore + 1, 8_000);

    const taskId = numId as TaskId<void>;
    await waitFor(async () => {
      const task = await harness.getTask(taskId, ctx);
      return task?.state.status === "terminal";
    }, 10_000);

    // Entry deleted = cancelled
    const docAfter = await readSchedulesDoc(harness, botId);
    expect(docAfter!.schedules[scheduleId]).toBeUndefined();
  });

  it("string id (via prepareArguments coercion) cancels the schedule", async () => {
    const { core, events, faux, harness } = await makeSchedulesCore();
    const botId = await createBot(core, "Cancel Str Bot");
    const scheduleId = await scheduleAndGetId(core, events, faux, botId);

    // Some models send { id: "57" } (a string); prepareArguments converts to number
    const cancelResponder: FauxResponseFactory = (context: TranscriptContext) => {
      const last = [...context.messages].reverse().find((m) => m.role !== "system");
      if (!last) return fauxAssistantMessage(fauxText("ok"));
      if (last.role === "toolResult") return fauxAssistantMessage(fauxText("ok"));
      if (msgText(last).startsWith(CHECKIN_MARKER)) return fauxAssistantMessage(fauxText("hi"));
      return fauxAssistantMessage(
        fauxToolCall("cancel_schedule", { id: scheduleId }), // string → coerced to number
        { stopReason: "toolUse" },
      );
    };
    faux.setResponses(Array.from({ length: 10 }, () => cancelResponder));

    const countBefore = completedCount(events, botId);
    await core.handleRequest({
      id: "cid-cs1",
      type: "bots.send",
      botId,
      text: "cancel",
      clientMessageId: "cm-cid-cs1",
    });
    await waitFor(() => completedCount(events, botId) >= countBefore + 1, 8_000);

    const taskId = Number(scheduleId) as TaskId<void>;
    await waitFor(async () => {
      const task = await harness.getTask(taskId, ctx);
      return task?.state.status === "terminal";
    }, 10_000);

    // Entry deleted = cancelled
    const docAfter = await readSchedulesDoc(harness, botId);
    expect(docAfter!.schedules[scheduleId]).toBeUndefined();
  });
});

// ─── fmtLocalTime unit tests ─────────────────────────────────────────────────

describe("fmtLocalTime", () => {
  it("formats local time as 'Weekday D Mon YYYY, HH:MM' using Date getters, locale-independent", () => {
    // 2024-01-15 is a Monday
    const ms1 = new Date(2024, 0, 15, 9, 5, 0, 0).getTime();
    expect(fmtLocalTime(ms1)).toBe("Mon 15 Jan 2024, 09:05");

    // 2026-10-09 is a Friday; single-digit day, no zero-padding
    const ms2 = new Date(2026, 9, 9, 19, 31, 0, 0).getTime();
    expect(fmtLocalTime(ms2)).toBe("Fri 9 Oct 2026, 19:31");

    // Hour and minute are zero-padded
    const ms3 = new Date(2024, 5, 1, 0, 0, 0, 0).getTime(); // Sat 1 Jun 2024, 00:00
    const r3 = fmtLocalTime(ms3);
    expect(r3).toContain("00:00");
    expect(r3).toContain("Jun");
    expect(r3).toContain("2024");
  });
});

// ─── hello includes schedule tool names ──────────────────────────────────────

describe("hello includes schedule tool names", () => {
  it("lists schedule_message, list_schedules, cancel_schedule", async () => {
    const { core } = await makeSchedulesCore();
    const res = await core.handleRequest({ id: "h1", type: "hello" });
    expect(res.type).toBe("result");
    const tools = (res as { result: { tools: string[] } }).result.tools;
    expect(tools).toContain("schedule_message");
    expect(tools).toContain("list_schedules");
    expect(tools).toContain("cancel_schedule");
  });
});

// ─── checkInPrompt unit test ──────────────────────────────────────────────────

describe("checkInPrompt exact output", () => {
  it("produces the required format with CHECKIN_MARKER, id, what, rule, due, and now", () => {
    // Mon 12 Jan 2026, 09:00
    const dueMs = new Date(2026, 0, 12, 9, 0, 0, 0).getTime();
    // Mon 12 Jan 2026, 09:01
    const nowMs = new Date(2026, 0, 12, 9, 1, 0, 0).getTime();

    const result = checkInPrompt({
      scheduleId: "42",
      what: "say hi",
      rule: "every 1 minute",
      dueTime: fmtLocalTime(dueMs),
      currentTime: fmtLocalTime(nowMs),
    });

    expect(result).toBe(
      '[Hydra check-in] Schedule #42 "say hi" (every 1 minute) is due at Mon 12 Jan 2026, 09:00. ' +
        "It's now Mon 12 Jan 2026, 09:01. Do it now. If there's nothing worth telling the user, reply with exactly NO_REPLY.",
    );

    // Starts with the CHECKIN_MARKER constant
    expect(result.startsWith(CHECKIN_MARKER)).toBe(true);
  });

  it("uses 'once' as the rule text for a one-off schedule", () => {
    const dueMs = new Date(2026, 9, 12, 10, 30, 0, 0).getTime();
    const nowMs = new Date(2026, 9, 12, 10, 31, 0, 0).getTime();

    const result = checkInPrompt({
      scheduleId: "7",
      what: "send weekly report",
      rule: "once",
      dueTime: fmtLocalTime(dueMs),
      currentTime: fmtLocalTime(nowMs),
    });

    expect(result).toContain("(once)");
    expect(result).not.toContain("once at");
  });
});
