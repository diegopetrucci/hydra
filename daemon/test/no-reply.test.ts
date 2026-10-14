/**
 * no-reply.test.ts
 *
 * Acceptance tests for the NO_REPLY silent-reply sentinel (ticket nb-au6u).
 *
 * All tests use the pi-ai faux provider (no network) and MemoryStorage.
 *
 * Acceptance criteria:
 *  (a) A NO_REPLY reply (including surrounding whitespace) produces no
 *      message.* events, leaves the preview and lastMessageAt unchanged,
 *      and is absent from bots.history.
 *  (b) A normal reply still streams several deltas (existing streaming
 *      behaviour unchanged).
 *  (c) 'NO' and 'NO_REPLY is not my answer' are delivered in full with
 *      the correct text.
 *  (d) A tool-call-then-NO_REPLY run produces no message events for the
 *      final assistant message.
 */

import { describe, it, expect, afterEach } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxProviderHandle, FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createTestModels } from "../src/models.js";
import { DaemonCore } from "../src/daemon-core.js";
import { NO_REPLY } from "../src/system-prompt.js";
import type { ProtocolEvent } from "../src/protocol.js";

const ctx = BACKGROUND_CONTEXT;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

type BotResult = { id: string };
type MsgResult = { id: string; role: string; text: string; createdAt: string };

/**
 * Build a DaemonCore with intro disabled and the faux provider.
 * Returns the harness so callers can close it in teardown.
 */
async function makeCore(): Promise<{
  core: DaemonCore;
  harness: Harness;
  events: ProtocolEvent[];
  faux: FauxProviderHandle;
}> {
  const { models, faux } = await createTestModels();
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry: createRegistry(),
      settings: { progress: { partialIntervalMs: 100, outputIntervalMs: 100 } },
    },
    ctx,
  );
  const events: ProtocolEvent[] = [];
  const core = new DaemonCore(
    harness,
    models,
    (ev) => events.push(ev),
    ctx,
    undefined,
    undefined,
    [],
    undefined,
    false, // enableIntro: false
  );
  await core.start();
  return { core, harness, events, faux };
}

/** Events for a given botId that match a given event name. */
function eventsOfType(events: ProtocolEvent[], eventName: string, botId: string): ProtocolEvent[] {
  return events.filter(
    (e) =>
      e.type === "event" &&
      e.event === eventName &&
      "botId" in e &&
      (e as { botId: string }).botId === botId,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("NO_REPLY sentinel", () => {
  // Resources created in each it(); closed unconditionally in afterEach.
  let currentCore: InstanceType<typeof DaemonCore> | undefined;
  let currentHarness: Harness | undefined;

  afterEach(async () => {
    await currentCore?.close().catch(() => {});
    await currentHarness?.close(ctx).catch(() => {});
    currentCore = undefined;
    currentHarness = undefined;
  });

  it("(a) exact NO_REPLY reply produces no message.* events and is absent from bots.history", async () => {
    const { core, harness, events, faux } = await makeCore();
    currentCore = core;
    currentHarness = harness;

    // Queue a NO_REPLY reply (with surrounding whitespace to test trimming).
    faux.setResponses([fauxAssistantMessage(fauxText("  NO_REPLY  "))]);

    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "Silent Bot",
      instructions: "Stay silent when appropriate.",
      model: "faux/faux-1",
    });
    expect(createRes).toMatchObject({ type: "result" });
    const botId = (createRes as { result: BotResult }).result.id;

    // Fetch the initial bot info to capture lastMessagePreview / lastMessageAt before.
    const listBefore = await core.handleRequest({ id: "r0", type: "bots.list" });
    const botsBefore = (
      listBefore as {
        result: { id: string; lastMessagePreview?: string; lastMessageAt?: string }[];
      }
    ).result;
    const metaBefore = botsBefore.find((b) => b.id === botId);

    await core.handleRequest({
      id: "r2",
      type: "bots.send",
      botId,
      text: "Please respond.",
      clientMessageId: "cm-1",
    });

    // Wait for bot.activity to return to idle (run_end fires regardless).
    await waitFor(() =>
      eventsOfType(events, "bot.activity", botId).some(
        (e) => "activity" in e && (e as { activity: string }).activity === "idle",
      ),
    );

    // Allow a brief extra settling window.
    await new Promise<void>((r) => setTimeout(r, 200));

    // No message.started, message.delta, or message.completed.
    expect(eventsOfType(events, "message.started", botId)).toHaveLength(0);
    expect(eventsOfType(events, "message.delta", botId)).toHaveLength(0);
    expect(eventsOfType(events, "message.completed", botId)).toHaveLength(0);

    // bots.history: only the user message (no assistant entry).
    const histRes = await core.handleRequest({ id: "r3", type: "bots.history", botId });
    const msgs = (histRes as { result: MsgResult[] }).result;
    expect(msgs.every((m) => m.role !== "assistant")).toBe(true);

    // lastMessagePreview / lastMessageAt should be unchanged (not updated by NO_REPLY).
    const listAfter = await core.handleRequest({ id: "r4", type: "bots.list" });
    const botsAfter = (
      listAfter as { result: { id: string; lastMessagePreview?: string; lastMessageAt?: string }[] }
    ).result;
    const metaAfter = botsAfter.find((b) => b.id === botId);
    expect(metaAfter?.lastMessagePreview).toBe(metaBefore?.lastMessagePreview);
    expect(metaAfter?.lastMessageAt).toBe(metaBefore?.lastMessageAt);
  });

  it("(b) normal reply still streams several deltas (existing streaming behaviour)", async () => {
    const { core, harness, events, faux } = await makeCore();
    currentCore = core;
    currentHarness = harness;

    // A multi-token reply to ensure at least one delta during streaming.
    faux.setResponses([fauxAssistantMessage(fauxText("Hello, this is a normal reply!"))]);

    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "Normal Bot",
      instructions: "Reply normally.",
      model: "faux/faux-1",
    });
    const botId = (createRes as { result: BotResult }).result.id;

    await core.handleRequest({
      id: "r2",
      type: "bots.send",
      botId,
      text: "Hi",
      clientMessageId: "cm-2",
    });

    await waitFor(() => eventsOfType(events, "message.completed", botId).length > 0);

    // message.started arrived.
    const started = eventsOfType(events, "message.started", botId);
    expect(started).toHaveLength(1);

    // At least one delta.
    const deltas = eventsOfType(events, "message.delta", botId);
    expect(deltas.length).toBeGreaterThan(0);

    // message.completed carries the full text.
    const completed = eventsOfType(events, "message.completed", botId)[0] as {
      message: { text: string };
    };
    expect(completed.message.text).toContain("Hello, this is a normal reply!");

    // message.started and message.completed share the same messageId.
    const startedId = (started[0] as { messageId: string }).messageId;
    const completedId = eventsOfType(events, "message.completed", botId)[0] as {
      messageId: string;
    };
    expect(startedId).toBe(completedId.messageId);
  });

  it('(c1) "NO" is delivered in full (not suppressed)', async () => {
    const { core, harness, events, faux } = await makeCore();
    currentCore = core;
    currentHarness = harness;

    faux.setResponses([fauxAssistantMessage(fauxText("NO"))]);

    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "No Bot",
      instructions: "",
      model: "faux/faux-1",
    });
    const botId = (createRes as { result: BotResult }).result.id;

    await core.handleRequest({
      id: "r2",
      type: "bots.send",
      botId,
      text: "Can you help?",
      clientMessageId: "cm-3",
    });

    await waitFor(() => eventsOfType(events, "message.completed", botId).length > 0);

    expect(eventsOfType(events, "message.started", botId)).toHaveLength(1);

    const completed = eventsOfType(events, "message.completed", botId)[0] as {
      message: { text: string };
    };
    expect(completed.message.text.trim()).toBe("NO");

    // Also present in bots.history.
    const histRes = await core.handleRequest({ id: "r3", type: "bots.history", botId });
    const msgs = (histRes as { result: MsgResult[] }).result;
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThan(0);
    expect(assistantMsgs[0]!.text.trim()).toBe("NO");
  });

  it('(c2) "NO_REPLY is not my answer" is delivered in full', async () => {
    const { core, harness, events, faux } = await makeCore();
    currentCore = core;
    currentHarness = harness;

    faux.setResponses([fauxAssistantMessage(fauxText("NO_REPLY is not my answer"))]);

    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "Verbose Bot",
      instructions: "",
      model: "faux/faux-1",
    });
    const botId = (createRes as { result: BotResult }).result.id;

    await core.handleRequest({
      id: "r2",
      type: "bots.send",
      botId,
      text: "What do you say?",
      clientMessageId: "cm-4",
    });

    await waitFor(() => eventsOfType(events, "message.completed", botId).length > 0);

    expect(eventsOfType(events, "message.started", botId)).toHaveLength(1);

    const completed = eventsOfType(events, "message.completed", botId)[0] as {
      message: { text: string };
    };
    expect(completed.message.text).toContain("NO_REPLY is not my answer");

    // Also present in bots.history.
    const histRes = await core.handleRequest({ id: "r3", type: "bots.history", botId });
    const msgs = (histRes as { result: MsgResult[] }).result;
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThan(0);
    expect(assistantMsgs[0]!.text).toContain("NO_REPLY is not my answer");
  });

  it("(d) tool-call followed by NO_REPLY final reply produces no message events for the final assistant message", async () => {
    const { core, harness, events, faux } = await makeCore();
    currentCore = core;
    currentHarness = harness;

    // First call: tool call (pi-durable issues a tool-use, re-invokes the model).
    // Second call: NO_REPLY text reply.
    let callCount = 0;
    const responder: FauxResponseFactory = (_ctx: TranscriptContext) => {
      callCount++;
      if (callCount === 1) {
        return fauxAssistantMessage(fauxToolCall("web_search", { query: "test" }), {
          stopReason: "toolUse",
        });
      }
      return fauxAssistantMessage(fauxText(NO_REPLY));
    };
    faux.setResponses([responder]);

    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "Tool Bot",
      instructions: "",
      model: "faux/faux-1",
    });
    const botId = (createRes as { result: BotResult }).result.id;

    await core.handleRequest({
      id: "r2",
      type: "bots.send",
      botId,
      text: "Do a search",
      clientMessageId: "cm-5",
    });

    // Wait for bot.activity idle to confirm the full run (both turns) finished.
    await waitFor(
      () =>
        eventsOfType(events, "bot.activity", botId).some(
          (e) => "activity" in e && (e as { activity: string }).activity === "idle",
        ),
      10_000,
    );

    // Allow settling.
    await new Promise<void>((r) => setTimeout(r, 200));

    // The final NO_REPLY message must produce no message.completed with NO_REPLY text.
    // (The tool-call turn emits no message.* events.)
    const completedEvents = eventsOfType(events, "message.completed", botId) as Array<{
      message: { text: string };
    }>;
    const hasNoReplyCompleted = completedEvents.some((e) => e.message.text.trim() === NO_REPLY);
    expect(hasNoReplyCompleted).toBe(false);

    // bots.history: no assistant entries with text (tool-call entries have no
    // text; the NO_REPLY entry is filtered out).
    const histRes = await core.handleRequest({ id: "r3", type: "bots.history", botId });
    const msgs = (histRes as { result: MsgResult[] }).result;
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    expect(assistantMsgs.every((m) => m.text.trim() !== NO_REPLY)).toBe(true);
  });

  it("(e) tool-call turn with no text emits no message.* events; only the text reply does", async () => {
    const { core, harness, events, faux } = await makeCore();
    currentCore = core;
    currentHarness = harness;

    let callCount = 0;
    const responder: FauxResponseFactory = (_ctx: TranscriptContext) => {
      callCount++;
      if (callCount === 1) {
        return fauxAssistantMessage(fauxToolCall("web_search", { query: "test" }), {
          stopReason: "toolUse",
        });
      }
      return fauxAssistantMessage(fauxText("Found it."));
    };
    faux.setResponses([responder, responder]);

    const createRes = await core.handleRequest({
      id: "e1",
      type: "bots.create",
      name: "Empty Turn Bot",
      instructions: "",
      model: "faux/faux-1",
    });
    const botId = (createRes as { result: BotResult }).result.id;

    await core.handleRequest({
      id: "e2",
      type: "bots.send",
      botId,
      text: "Do a search",
      clientMessageId: "cm-e",
    });

    await waitFor(() => eventsOfType(events, "message.completed", botId).length >= 1);
    await waitFor(
      () =>
        eventsOfType(events, "bot.activity", botId).some(
          (e) => "activity" in e && (e as { activity: string }).activity === "idle",
        ),
      10_000,
    );
    await new Promise<void>((r) => setTimeout(r, 200));

    expect(eventsOfType(events, "message.started", botId)).toHaveLength(1);
    const completed = eventsOfType(events, "message.completed", botId) as Array<{
      message: { text: string };
    }>;
    expect(completed).toHaveLength(1);
    expect(completed[0]!.message.text).toBe("Found it.");

    // No message.* event (started/delta/completed) carries empty text.
    for (const e of events) {
      if (!("botId" in e) || e.botId !== botId) continue;
      if (e.event === "message.delta") {
        expect((e as { text: string }).text).not.toBe("");
      }
      if (e.event === "message.completed") {
        expect((e as { message: { text: string } }).message.text.trim()).not.toBe("");
      }
    }
  });
});
