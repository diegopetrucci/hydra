/**
 * harness-tool-routing.test.ts
 *
 * Item 8: routes a faux-model tool call (fauxToolCall) through the real
 * pi-durable harness and the web-tools adapter with a stub fetch.
 *
 * Uses:
 *  – pi-ai faux provider  (no real model calls)
 *  – buildWebToolsExtensionForTest  (web-tools adapter with stub fetch)
 *  – node:dns/promises mocked      (prevents real DNS lookups during SSRF check)
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

// ─── DNS stub ────────────────────────────────────────────────────────────────
//
// The web-tools SSRF protection (ssrf-protection.ts) resolves hostnames via
// node:dns/promises before the custom fetch implementation is called.  We mock
// it here so the test never touches the network.  The mock returns a public,
// non-blocked IP for any hostname (bypassing real DNS while still satisfying
// the SSRF validator's IP-range checks).

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "1.1.1.1", family: 4 }]),
}));

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

  it("routes web_search tool call through the harness; asserts tool activity events and message.completed", async () => {
    // ── Stub fetch ──────────────────────────────────────────────────────────
    // The web-tools adapter passes our fakeFetch to fetchRemoteUrl, which calls
    // it after the (mocked) DNS resolution.  We return a valid Exa MCP JSON-RPC
    // response so web_search succeeds without hitting the real network.
    const fakeFetch = vi.fn(async (_url: string | URL | Request): Promise<Response> => {
      // Exa MCP JSON-RPC response with one search result.
      const mcpBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify([
                {
                  url: "https://example.com/typescript-async",
                  title: "TypeScript Async Guide",
                  text: "Comprehensive guide to async/await in TypeScript.",
                },
              ]),
            },
          ],
        },
      });
      return new Response(mcpBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // ── Build the web-tools extension with the stubbed fetch ──────────────
    const { extension: webExt, resetBudget } = buildWebToolsExtensionForTest(
      fakeFetch as unknown as Parameters<typeof buildWebToolsExtensionForTest>[0],
    );

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
      fauxAssistantMessage(fauxToolCall("web_search", { query: "TypeScript async patterns" }), {
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

    const webSearchActivity = toolActivityEvents.find(
      (e) => "tool" in e && (e as { tool: string }).tool === "web_search",
    );
    expect(webSearchActivity).toBeDefined();
    expect((webSearchActivity as { label: string }).label).toBe("Searching the web");

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
