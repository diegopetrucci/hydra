/**
 * intro.test.ts
 *
 * Tests for the bot intro turn: when a bot is created and the provider has
 * credentials, the daemon automatically submits an intro prompt so the bot
 * introduces itself without the user writing first.
 *
 * All tests use the faux provider (no network).
 * The faux provider always resolves auth, so tests (a), (b), (d) use it directly.
 * Test (c) uses no model override (falls back to anthropic which has no
 * registered provider in createTestModels) so getAuth returns undefined → no intro.
 *
 * Acceptance tests per ticket nb-5tpo §6:
 *   (a) message.started + message.completed arrive after bots.create without bots.send.
 *       The user message the faux model saw starts with INTRO_MARKER and contains the name.
 *   (b) bots.history returns exactly one message (the assistant intro).
 *   (c) With no credentials, bots.create succeeds and no message.* / bot.error events follow.
 *   (d) The intro does not delay bots.create until generation finishes (slow faux response).
 */

import { describe, it, expect } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type {
  FauxResponseFactory,
  FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createTestModels } from "../src/models.js";
import { DaemonCore } from "../src/daemon-core.js";
import { INTRO_MARKER } from "../src/system-prompt.js";
import type { ProtocolEvent } from "../src/protocol.js";

const ctx = BACKGROUND_CONTEXT;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

type BotResult = { id: string; name: string };
type MsgResult = { id: string; role: string; text: string; createdAt: string };

/**
 * Build a DaemonCore with intro ENABLED (the production default).
 * Returns the core, events array, and the faux provider handle.
 */
async function makeIntroCore(): Promise<{
  core: DaemonCore;
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
  // enableIntro defaults to true; leave the default so the intro fires.
  const core = new DaemonCore(harness, models, (ev) => events.push(ev), ctx);
  await core.start();
  return { core, events, faux };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("bot intro turn", () => {
  it("(a) message.started and message.completed arrive after bots.create with no bots.send; faux model receives INTRO_MARKER and bot name", async () => {
    const { core, events, faux } = await makeIntroCore();

    // Capture the TranscriptContext to inspect the user message the model sees.
    let capturedContext: TranscriptContext | undefined;
    const factory: FauxResponseFactory = (context) => {
      capturedContext = context;
      return fauxAssistantMessage(fauxText("Hi! I'm your bot."));
    };
    faux.setResponses([factory]);

    const botName = "Intro Bot Alpha";
    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: botName,
      instructions: "Help with anything.",
      model: "faux/faux-1",
    });
    expect(createRes).toMatchObject({ type: "result" });
    const botId = (createRes as { result: BotResult }).result.id;

    // Wait for the intro generation to complete (no explicit bots.send).
    await waitFor(() =>
      events.some(
        (e) => e.event === "message.completed" && "botId" in e && (e as { botId: string }).botId === botId,
      ),
    );

    // message.started must have arrived.
    const started = events.find(
      (e) => e.event === "message.started" && "botId" in e && (e as { botId: string }).botId === botId,
    );
    expect(started).toBeDefined();

    // message.completed must have arrived.
    const completed = events.find(
      (e) => e.event === "message.completed" && "botId" in e && (e as { botId: string }).botId === botId,
    );
    expect(completed).toBeDefined();

    // The faux model must have been called with the intro context.
    expect(capturedContext).toBeDefined();

    // The user message sent to the model must start with INTRO_MARKER and include the bot name.
    const userMessages = capturedContext!.messages.filter((m) => m.role === "user");
    expect(userMessages.length).toBeGreaterThan(0);

    // Extract text content from the last user message.
    const lastUserMsg = userMessages[userMessages.length - 1]!;
    const userText =
      typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : (lastUserMsg.content as { type: string; text?: string }[])
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");

    expect(userText.startsWith(INTRO_MARKER)).toBe(true);
    expect(userText).toContain(botName);
  });

  it("(b) bots.history returns exactly one message (the assistant intro) after bots.create", async () => {
    const { core, events, faux } = await makeIntroCore();

    faux.setResponses([fauxAssistantMessage(fauxText("Hello! I'm your assistant."))]);

    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "History Test Bot",
      instructions: "",
      model: "faux/faux-1",
    });
    expect(createRes).toMatchObject({ type: "result" });
    const botId = (createRes as { result: BotResult }).result.id;

    // Wait for intro generation to complete.
    await waitFor(() =>
      events.some(
        (e) => e.event === "message.completed" && "botId" in e && (e as { botId: string }).botId === botId,
      ),
    );

    const histRes = await core.handleRequest({
      id: "r2",
      type: "bots.history",
      botId,
    });
    expect(histRes).toMatchObject({ type: "result" });
    const msgs = (histRes as { result: MsgResult[] }).result;

    // Exactly one message: the assistant intro. The user trigger must be hidden.
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("assistant");
    expect(msgs[0]!.text).toContain("Hello! I'm your assistant.");
  });

  it("(c) with no credentials, bots.create succeeds and no message.* or bot.error events follow", async () => {
    const { core, events } = await makeIntroCore();
    // No faux response queued — intro must NOT fire.

    // Use default model (anthropic/claude-sonnet-5-5). createTestModels() only
    // registers the faux provider, so getAuth("anthropic") returns undefined → intro skipped.
    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "No Creds Bot",
      instructions: "",
      // No model → defaults to anthropic/claude-sonnet-5-5 (no provider registered)
    });
    expect(createRes).toMatchObject({ type: "result" });
    const botId = (createRes as { result: BotResult }).result.id;

    // Wait a couple of event-loop ticks to let any spurious async work settle.
    await new Promise<void>((r) => setTimeout(r, 200));

    // No message.* events for this bot.
    const messageStarted = events.filter(
      (e) => e.event === "message.started" && "botId" in e && (e as { botId: string }).botId === botId,
    );
    expect(messageStarted).toHaveLength(0);

    const botError = events.filter(
      (e) => e.event === "bot.error" && "botId" in e && (e as { botId: string }).botId === botId,
    );
    expect(botError).toHaveLength(0);

    // History is empty (no user trigger, no assistant reply).
    const histRes = await core.handleRequest({
      id: "r2",
      type: "bots.history",
      botId,
    });
    expect(histRes).toMatchObject({ type: "result" });
    const msgs = (histRes as { result: MsgResult[] }).result;
    expect(msgs).toHaveLength(0);
  });

  it("(d) bots.create response arrives before intro generation completes (slow faux response)", async () => {
    const { core, events, faux } = await makeIntroCore();

    // Record ordering: generation completes after create returns.
    let createReturnedAt = 0;
    let generationCompletedAt = 0;

    // A slow factory: waits 400 ms before returning, much longer than admission.
    const GENERATION_DELAY_MS = 400;
    const factory: FauxResponseFactory = async () => {
      await new Promise<void>((r) => setTimeout(r, GENERATION_DELAY_MS));
      return fauxAssistantMessage(fauxText("Slow intro reply."));
    };
    faux.setResponses([factory]);

    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "Slow Intro Bot",
      instructions: "",
      model: "faux/faux-1",
    });
    createReturnedAt = Date.now();

    expect(createRes).toMatchObject({ type: "result" });
    const botId = (createRes as { result: BotResult }).result.id;

    // Verify that message.completed has NOT yet arrived at the moment create returned.
    // (bots.create must not block until generation finishes.)
    const completedAtCreate = events.some(
      (e) => e.event === "message.completed" && "botId" in e && (e as { botId: string }).botId === botId,
    );
    expect(completedAtCreate).toBe(false);

    // Wait for the generation to eventually finish.
    await waitFor(() => {
      const done = events.some(
        (e) => e.event === "message.completed" && "botId" in e && (e as { botId: string }).botId === botId,
      );
      if (done && generationCompletedAt === 0) generationCompletedAt = Date.now();
      return done;
    });

    // Create returned well before generation completed (at least 300 ms earlier).
    expect(generationCompletedAt - createReturnedAt).toBeGreaterThanOrEqual(300);
  });
});
