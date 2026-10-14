/**
 * harness-tool-routing.test.ts
 *
 * Item 8: routes a faux-model tool call (fauxToolCall) through the real
 * pi-durable harness and the web-tools adapter with a stub fetch.
 *
 * Uses:
 *  – pi-ai faux provider  (no real model calls)
 *  – buildWebToolsExtensionForTest  (web-tools adapter with stub fetch)
 *  – IP-literal URL (https://1.1.1.1/) so the SSRF validator skips DNS entirely
 *  – DaemonCore + BotWatcher       (full protocol event pipeline)
 *
 * Asserts tool activity events and the final message.completed event.
 * No real network calls are made.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createTestModels } from "../src/models.js";
import { DaemonCore } from "../src/daemon-core.js";
import { buildWebToolsExtensionForTest } from "../src/web-tools.js";
import type { ProtocolEvent } from "../src/protocol.js";

const ctx = BACKGROUND_CONTEXT;

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

type BotResult = { id: string };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("item 8 – faux tool call through real harness and web-tools adapter", () => {
  let tmpDir: string;
  let savedAgentDir: string | undefined;

  beforeEach(async () => {
    // web_search.execute() calls requireAgentDir() which checks PI_CODING_AGENT_DIR.
    tmpDir = await mkdtemp(join(tmpdir(), "hydra-webtool-test-"));
    savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = tmpDir;
  });

  afterEach(async () => {
    if (savedAgentDir !== undefined) {
      process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
    } else {
      delete process.env["PI_CODING_AGENT_DIR"];
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("routes fetch_content tool call through the harness; asserts tool activity events and message.completed", async () => {
    // ── Stub fetch ──────────────────────────────────────────────────────────
    // The web-tools adapter passes our fakeFetch to fetchRemoteUrl.  The tool
    // call targets a public IP literal, so the SSRF validator needs no DNS
    // lookup and the stub serves the page without touching the network.
    const fakeFetch = vi.fn(async (_url: string | URL | Request): Promise<Response> => {
      return new Response(
        "<html><head><title>Routing Page</title></head><body><main><h1>Routing Page</h1><p>TypeScript async/await content served by the stub fetch for the routing test.</p></main></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });

    // ── Build the web-tools extension with the stubbed fetch ──────────────
    const { extension: webExt, resetBudget } = buildWebToolsExtensionForTest(fakeFetch);

    // ── Create the harness with the test extension ────────────────────────
    const registry = createRegistry();
    registry.install(webExt);

    const { models, faux } = await createTestModels();
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry,
        settings: { progress: { partialIntervalMs: 100, outputIntervalMs: 100 } },
      },
      ctx,
    );

    const events: ProtocolEvent[] = [];
    const toolNames = webExt.tools?.map((t) => t.name) ?? [];
    const core = new DaemonCore(
      harness,
      models,
      (ev) => events.push(ev),
      ctx,
      undefined,
      undefined,
      toolNames,
      resetBudget,
      // enableIntro=false: this test queues two faux responses for a tool-call
      // round trip; the intro must not consume the first one.
      false,
    );
    await core.start();

    // ── Script the faux model responses ──────────────────────────────────
    // Response 1: tool call (web_search).
    // Response 2: text reply after the tool result.
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("fetch_content", { url: "https://1.1.1.1/" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxText("TypeScript async/await is great.")),
    ]);

    // ── Create a bot and send a message ──────────────────────────────────
    const createRes = await core.handleRequest({
      id: "t1",
      type: "bots.create",
      name: "Web Search Bot",
      instructions: "You have web search.",
      model: "faux/faux-1",
    });
    expect(createRes.type).toBe("result");
    const botId = (createRes as { result: BotResult }).result.id;

    await core.handleRequest({
      id: "t2",
      type: "bots.send",
      botId,
      text: "Search for TypeScript async patterns",
      clientMessageId: "cm-tool-1",
    });

    // ── Wait for the final message.completed with non-empty text ──────────
    // The text-less tool-call turn emits no message.*; the second model
    // call produces the text reply.  Wait for the one with content ("TypeScript async/await is great.").
    await waitFor(() =>
      events.some(
        (e) =>
          e.event === "message.completed" &&
          "botId" in e &&
          (e as { botId: string }).botId === botId &&
          typeof (e as { message?: { text?: string } }).message?.text === "string" &&
          (e as { message: { text: string } }).message.text.length > 0,
      ),
    );

    // ── Assert tool activity events ───────────────────────────────────────
    const toolActivityEvents = events.filter(
      (e) =>
        e.event === "bot.activity" &&
        "activity" in e &&
        (e as { activity: string }).activity === "tool",
    );
    expect(toolActivityEvents.length).toBeGreaterThan(0);

    const fetchActivity = toolActivityEvents.find(
      (e) => "tool" in e && (e as { tool: string }).tool === "fetch_content",
    );
    expect(fetchActivity).toBeDefined();
    expect((fetchActivity as { label: string }).label).toBe("Reading 1.1.1.1");

    // ── Assert final message (text reply, not tool call message) ──────────
    const completed = events.find(
      (e) =>
        e.event === "message.completed" &&
        "botId" in e &&
        (e as { botId: string }).botId === botId &&
        typeof (e as { message?: { text?: string } }).message?.text === "string" &&
        (e as { message: { text: string } }).message.text.length > 0,
    ) as { message: { text: string } } | undefined;
    expect(completed?.message.text).toContain("TypeScript");

    // ── Assert stub fetch was called (no real network) ───────────────────
    // fakeFetch was called at least once (for the Exa MCP request).
    expect(fakeFetch).toHaveBeenCalled();

    await core.close();
    await harness.close(ctx);
  });
});
