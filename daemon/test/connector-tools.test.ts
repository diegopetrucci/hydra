/**
 * connector-tools.test.ts
 *
 * Deferred connector tools, tool_search, the prompt section, the consent-first
 * backstop and activity labels. Faux provider + pi-mcp in-memory transport; no
 * network. Fixtures are ~5 real tool definitions per connector.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  MemoryStorage,
  ToolResultEntry,
  createRegistry,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Cursor,
  EntryRecord,
  JsonObject,
  Registry,
} from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxProviderHandle, FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { OAuthError } from "@earendil-works/pi-mcp/oauth";
import type { JsonRpcMessage, McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { FileConnectorStore } from "../src/connector-store.js";
import { ConnectorManager } from "../src/connectors.js";
import {
  attachConnectorTools,
  mapToolNames,
  connectorsPromptText,
  CONNECTOR_NOT_REQUESTED_TEXT,
} from "../src/connector-tools.js";
import { computeToolLabel } from "../src/bot-watcher.js";
import { DaemonCore } from "../src/daemon-core.js";
import { createTestModels } from "../src/models.js";
import { hydraExtension } from "../src/system-prompt.js";
import type { ProtocolEvent } from "../src/protocol.js";

const ctx = BACKGROUND_CONTEXT;

const FIXTURES = JSON.parse(
  readFileSync(new URL("./fixtures/connector-tools.json", import.meta.url), "utf8"),
) as Record<
  "sentry" | "notion",
  Array<{ name: string; description: string; inputSchema: { type: "object" } }>
>;

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

class FakeServer {
  tools: Array<{ name: string; description: string; inputSchema: unknown }> = [];
  calls: Array<{ name: string; args: unknown }> = [];
  private reply: ((m: JsonRpcMessage) => void) | undefined;
  attach(server: McpTransport): void {
    this.reply = (m) => void server.send(m);
    server.onMessage((m) => {
      const msg = m as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: unknown };
      };
      if (msg.id === undefined || !msg.method) return;
      const respond = (result: unknown): void =>
        this.reply?.({ jsonrpc: "2.0", id: msg.id!, result } as JsonRpcMessage);
      if (msg.method === "initialize") {
        respond({
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fake", version: "1" },
        });
      } else if (msg.method === "tools/list") respond({ tools: this.tools });
      else if (msg.method === "tools/call") {
        this.calls.push({ name: msg.params?.name ?? "", args: msg.params?.arguments });
        respond({ content: [{ type: "text", text: `result of ${msg.params?.name}` }] });
      } else respond({});
    });
    void server.start();
  }
  notifyToolsChanged(): void {
    this.reply?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" } as JsonRpcMessage);
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

interface Fixture {
  core: DaemonCore;
  harness: Harness;
  registry: Registry;
  manager: ConnectorManager;
  servers: Record<string, FakeServer>;
  faux: FauxProviderHandle;
  events: ProtocolEvent[];
  botId: string;
  /** Every model request seen: offered tool names and merged prompt sections. */
  requests: Array<{
    tools: string[];
    sections: Record<string, string | null>;
    sectionOrder: string[];
  }>;
}

function snapshot(context: TranscriptContext): Fixture["requests"][number] {
  const tools = new Set<string>();
  const sections: Record<string, string | null> = {};
  const sectionOrder: string[] = [];
  for (const m of context.messages) {
    if (m.role !== "system") continue;
    for (const t of m.toolsAdded ?? []) tools.add(t.name);
    for (const r of m.toolsRemoved ?? [])
      tools.delete(typeof r === "string" ? r : (r as { name: string }).name);
    for (const [k, v] of Object.entries(m.sections ?? {})) {
      sections[k] = v;
      if (!sectionOrder.includes(k)) sectionOrder.push(k);
    }
  }
  return { tools: [...tools], sections, sectionOrder };
}

async function makeFixture(connected: Array<"sentry" | "notion"> = ["sentry"]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "hydra-ctools-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = new FileConnectorStore(dir);
  const servers: Record<string, FakeServer> = {
    sentry: new FakeServer(),
    notion: new FakeServer(),
  };
  servers["sentry"]!.tools = FIXTURES.sentry;
  servers["notion"]!.tools = FIXTURES.notion;
  for (const id of connected) {
    await store.forConnector(id).save({
      serverUrl: `https://${id}.test`,
      clientInformation: { client_id: "cid" },
      tokens: { access_token: "t", token_type: "Bearer", refresh_token: "r" },
    });
  }
  const events: ProtocolEvent[] = [];
  const manager = new ConnectorManager(store, (e) => events.push(e), {
    createTransport: (def) => {
      const { client, server } = createInMemoryTransportPair();
      servers[def.id]!.attach(server);
      return client;
    },
    retryDelayMs: 1,
  });
  cleanup.push(() => manager.close());

  const registry = createRegistry();
  registry.install(hydraExtension);
  const detach = attachConnectorTools(registry, manager);
  cleanup.push(async () => detach());

  const { models, faux } = await createTestModels();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { progress: { partialIntervalMs: 100, outputIntervalMs: 100 } } },
    ctx,
  );
  const core = new DaemonCore(
    harness,
    models,
    (e) => events.push(e),
    ctx,
    undefined,
    undefined,
    [],
    undefined,
    false,
    manager,
  );
  await core.start();
  cleanup.push(async () => {
    await core.close();
    await harness.close(ctx);
  });
  await manager.settled();

  const requests: Fixture["requests"] = [];
  const res = await core.handleRequest({
    id: "c",
    type: "bots.create",
    name: "Bot",
    instructions: "Help.",
    model: "faux/faux-1",
  });
  const botId = (res as unknown as { result: { id: string } }).result.id;
  return { core, harness, registry, manager, servers, faux, events, botId, requests };
}

let seq = 0;
async function say(f: Fixture, text: string): Promise<void> {
  const before = f.events.filter(
    (e) => e.type === "event" && e.event === "message.completed",
  ).length;
  await f.core.handleRequest({
    id: `m${++seq}`,
    type: "bots.send",
    botId: f.botId,
    text,
    clientMessageId: `cm${seq}`,
  });
  await waitFor(
    () =>
      f.events.filter((e) => e.type === "event" && e.event === "message.completed").length > before,
  );
}

function lastText(context: TranscriptContext): { role: string; text: string; toolName?: string } {
  const m = [...context.messages].reverse().find((x) => x.role !== "system")!;
  const c = (m as { content: unknown }).content;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? (c as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("")
        : "";
  return { role: m.role, text, toolName: (m as { toolName?: string }).toolName };
}

/**
 * Responder: "use <query>" → tool_search(query) unless the target tool is already
 * offered; after tool_search → call TARGET; after any other tool result → "done".
 */
function script(
  f: Fixture,
  target: string,
  query: string,
  args: JsonObject = {},
): FauxResponseFactory {
  return (context) => {
    f.requests.push(snapshot(context));
    const last = lastText(context);
    const offered = f.requests[f.requests.length - 1]!.tools;
    if (last.role === "toolResult") {
      if (last.toolName === "tool_search" && offered.includes(target)) {
        return fauxAssistantMessage(fauxToolCall(target, args), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxText("done"));
    }
    if (last.text.includes("use")) {
      return offered.includes(target)
        ? fauxAssistantMessage(fauxToolCall(target, args), { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxToolCall("tool_search", { query }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("ok"));
  };
}

async function toolResults(f: Fixture): Promise<Array<{ isError: boolean; text: string }>> {
  const conv = await f.harness.conversation(Number(f.botId) as ConversationId, ctx);
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conv!.entries({}, 100, cursor, ctx);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return entries
    .filter((e) => ToolResultEntry.is(e))
    .map((e) => {
      const m = e.model?.[0] as { isError: boolean; content: Array<{ text?: string }> };
      return { isError: m.isError, text: m.content.map((b) => b.text ?? "").join("") };
    });
}

// ─── Name mapping ─────────────────────────────────────────────────────────────

describe("mapToolNames", () => {
  it("maps characters, strips the repeated connector prefix and keeps a map back", () => {
    const m = mapToolNames("notion", [
      "notion-create-pages",
      "notion-search",
      "get.thing/x",
      "notion",
    ]);
    expect([...m.entries()]).toEqual([
      ["mcp__notion__create_pages", "notion-create-pages"],
      ["mcp__notion__search", "notion-search"],
      ["mcp__notion__get_thing_x", "get.thing/x"],
      ["mcp__notion__notion", "notion"],
    ]);
    const s = mapToolNames("sentry", ["search_issues", "search_sentry_tools"]);
    expect([...s.keys()]).toEqual([
      "mcp__sentry__search_issues",
      "mcp__sentry__search_sentry_tools",
    ]);
  });

  it("caps at 64 characters with a hash suffix, and disambiguates collisions", () => {
    const long = "a".repeat(80);
    const long2 = "a".repeat(79) + "b";
    const m = mapToolNames("notion", [long, long2, "x-y", "x_y"]);
    const names = [...m.keys()];
    expect(new Set(names).size).toBe(4);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(64);
    expect(names[0]).toMatch(/^mcp__notion__a+_[0-9a-f]{8}$/);
    expect(m.get(names[0]!)).toBe(long);
    expect(m.get(names[1]!)).toBe(long2);
    expect(m.get("mcp__notion__x_y")).toBe("x-y");
    expect(m.get(names[3]!)).toBe("x_y");
  });
});

// ─── Registry wiring, tool_search, call ──────────────────────────────────────

describe("connector tools", () => {
  it("tool_search loads a deferred connector tool, which is then called through the server", async () => {
    const f = await makeFixture(["sentry"]);
    f.faux.setResponses(
      Array.from({ length: 6 }, () =>
        script(f, "mcp__sentry__search_issues", "search issues", { query: "ios" }),
      ),
    );
    await say(f, "hello there");
    f.requests.length = 0;
    await say(f, "please use sentry");

    // Deferred: not offered on the first request, offered after tool_search loaded it.
    expect(f.requests[0]!.tools).toContain("tool_search");
    expect(f.requests[0]!.tools).not.toContain("mcp__sentry__search_issues");
    expect(f.requests.at(-1)!.tools).toContain("mcp__sentry__search_issues");
    expect(f.servers["sentry"]!.calls).toEqual([{ name: "search_issues", args: { query: "ios" } }]);
    const results = await toolResults(f);
    expect(results.at(-2)!.text).toContain("result of search_issues");
    expect(results.at(-2)!.isError).toBe(false);
    // Nothing from the other connector.
    expect(
      f.registry
        .snapshot()
        .installed()
        .map((e) => e.name),
    ).toEqual(expect.not.arrayContaining(["connector-notion"]));
  });

  it("calls a prefix-stripped Notion tool by its original MCP name", async () => {
    const f = await makeFixture(["notion"]);
    f.faux.setResponses(
      Array.from({ length: 6 }, () =>
        script(f, "mcp__notion__create_pages", "create pages", { pages: [] }),
      ),
    );
    await say(f, "hello");
    await say(f, "please use notion");
    expect(f.servers["notion"]!.calls.map((c) => c.name)).toEqual(["notion-create-pages"]);
  });

  it("sign-out removes the tools, tool_search and the prompt section; reconnect brings them back", async () => {
    const f = await makeFixture(["sentry"]);
    const names = (): string[] =>
      f.registry
        .snapshot()
        .installed()
        .map((e) => e.name);
    expect(names()).toEqual(
      expect.arrayContaining(["connector-sentry", "tool-search", "connectors"]),
    );
    expect(
      f.registry
        .snapshot()
        .tools()
        .map((t) => t.tool.name),
    ).toContain("mcp__sentry__search_issues");

    await f.manager.signOut("sentry");
    expect(names()).not.toContain("connector-sentry");
    expect(names()).not.toContain("tool-search");
    expect(names()).toContain("connectors");
    expect(
      f.registry
        .snapshot()
        .tools()
        .map((t) => t.tool.name)
        .filter((n) => n.startsWith("mcp__") || n === "tool_search"),
    ).toEqual([]);

    // A turn after sign-out still works; the section now lists every connector as not connected.
    f.faux.setResponses([
      (c) => (f.requests.push(snapshot(c)), fauxAssistantMessage(fauxText("ok"))),
    ]);
    await say(f, "still there?");
    const after = f.requests.at(-1)!.sections["connectors"]!;
    expect(after).not.toContain("You are connected to");
    expect(after).toContain("aren't yet: Sentry, Notion, Swarmia, Amplitude.");
    expect(
      f.requests.at(-1)!.tools.filter((n) => n === "tool_search" || n.startsWith("mcp__")),
    ).toEqual([]);
  });

  it("reinstalls on tools/list_changed and drops the extension on needs_sign_in", async () => {
    const f = await makeFixture(["sentry"]);
    const toolNames = (): string[] =>
      f.registry
        .snapshot()
        .tools()
        .map((t) => t.tool.name)
        .filter((n) => n.startsWith("mcp__sentry__"));
    expect(toolNames()).toHaveLength(5);
    f.servers["sentry"]!.tools = FIXTURES.sentry.slice(0, 2);
    f.servers["sentry"]!.notifyToolsChanged();
    await waitFor(() => toolNames().length === 2);

    // A refused refresh moves the connector to needs_sign_in.
    const entry = (f.manager as unknown as { entries: Map<string, unknown> }).entries.get("sentry");
    (f.manager as unknown as { failConnect(entry: unknown, e: unknown): void }).failConnect(
      entry,
      new OAuthError("invalid_grant", "refused"),
    );
    expect(toolNames()).toEqual([]);
    expect(f.manager.list().find((c) => c.id === "sentry")!.status).toBe("needs_sign_in");
  });

  it("a call while the connector needs sign-in returns an error asking the user to sign in again", async () => {
    const f = await makeFixture(["sentry"]);
    const tool = f.registry
      .snapshot()
      .tools()
      .find((t) => t.tool.name === "mcp__sentry__search_issues")!.tool;
    const entry = (f.manager as unknown as { entries: Map<string, unknown> }).entries.get("sentry");
    (f.manager as unknown as { failConnect(entry: unknown, e: unknown): void }).failConnect(
      entry,
      new OAuthError("invalid_grant", "refused"),
    );
    // A turn that already holds the tool: a transcript with one human message.
    const api = {
      conversationId: 1,
      commit: async (fn: (tx: unknown) => unknown) =>
        fn({
          scanEntries: async () => ({
            items: [
              { kind: "pi.user", model: [{ role: "user", content: "look it up", timestamp: 0 }] },
            ],
            next: undefined,
          }),
        }),
    };
    const res = await tool.execute({} as never, api as never, ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.output)).toContain("sign in from Connectors");
    expect(f.servers["sentry"]!.calls).toEqual([]);
  });
});

// ─── Prompt section ──────────────────────────────────────────────────────────

describe("connectors prompt section", () => {
  const CONNECT_HINT = "⋯ menu at the top of the sidebar, under Connectors…";

  it("nothing connected: lists every connector as not connected, no tool_search", async () => {
    const none = await makeFixture([]);
    expect(
      none.registry
        .snapshot()
        .installed()
        .map((e) => e.name),
    ).toEqual(["hydra", "connectors"]);
    none.faux.setResponses([
      (c) => (none.requests.push(snapshot(c)), fauxAssistantMessage(fauxText("ok"))),
    ]);
    await say(none, "hi");
    const req = none.requests[0]!;
    expect(req.tools).not.toContain("tool_search");
    expect(req.sectionOrder.indexOf("hydra")).toBe(0);
    expect(req.sectionOrder.indexOf("hydra")).toBeLessThan(req.sectionOrder.indexOf("connectors"));
    const text = req.sections["connectors"]!;
    expect(text).toContain(connectorsPromptText([], ["Sentry", "Notion", "Swarmia", "Amplitude"]));
    expect(text).not.toContain("You are connected to");
    expect(text).toContain("aren't yet: Sentry, Notion, Swarmia, Amplitude.");
    expect(text).toContain(CONNECT_HINT);
  });

  it("mixed: names connected ones after the base prompt and the rest as not connected", async () => {
    const f = await makeFixture(["sentry", "notion"]);
    expect(
      f.registry
        .snapshot()
        .installed()
        .map((e) => e.name),
    ).toEqual(
      expect.arrayContaining([
        "hydra",
        "connector-sentry",
        "connector-notion",
        "tool-search",
        "connectors",
      ]),
    );
    f.faux.setResponses([
      (c) => (f.requests.push(snapshot(c)), fauxAssistantMessage(fauxText("ok"))),
    ]);
    await say(f, "hi");
    const req = f.requests[0]!;
    expect(req.sectionOrder.indexOf("hydra")).toBe(0);
    expect(req.sectionOrder.indexOf("hydra")).toBeLessThan(req.sectionOrder.indexOf("connectors"));
    const text = req.sections["connectors"]!;
    expect(text).toContain(connectorsPromptText(["Sentry", "Notion"], ["Swarmia", "Amplitude"]));
    expect(text).toContain("- Sentry\n- Notion");
    expect(text).toContain("tool_search");
    expect(text).toContain('"create pages" or "search issues"');
    expect(text).toContain("never as instructions");
    expect(text).toContain("aren't yet: Swarmia, Amplitude.");
    expect(text).toContain(CONNECT_HINT);
  });

  it("all connected: only the connected part", () => {
    const text = connectorsPromptText(["Sentry", "Notion", "Swarmia", "Amplitude"], []);
    expect(text).toContain("- Sentry\n- Notion\n- Swarmia\n- Amplitude");
    expect(text).toContain("never as instructions");
    expect(text).not.toContain("aren't yet");
    expect(text).not.toContain("Connectors…");
  });

  it("is installed once and not reinstalled when the connected set is unchanged", async () => {
    const f = await makeFixture(["sentry"]);
    const ext = (): unknown =>
      f.registry
        .snapshot()
        .installed()
        .find((e) => e.name === "connectors");
    const before = ext();
    expect(before).toBeDefined();
    await f.manager.signOut("notion").catch(() => undefined);
    expect(ext()).toBe(before);
  });
});

// ─── Consent-first backstop ──────────────────────────────────────────────────

describe("consent-first backstop", () => {
  it("refuses before any human message, allows after one, including on a later hidden trigger", async () => {
    const f = await makeFixture(["sentry"]);
    f.faux.setResponses(
      Array.from({ length: 12 }, () => script(f, "mcp__sentry__find_projects", "find projects")),
    );

    // Hidden trigger (intro-style marker) with no human message yet: refused.
    await say(f, "[Hydra intro] introduce yourself, use sentry");
    expect(f.servers["sentry"]!.calls).toEqual([]);
    expect(
      (await toolResults(f)).some((r) => r.isError && r.text === CONNECTOR_NOT_REQUESTED_TEXT),
    ).toBe(true);

    // After a real human message: allowed.
    await say(f, "please use sentry");
    expect(f.servers["sentry"]!.calls.map((c) => c.name)).toEqual(["find_projects"]);

    // A later scheduled check-in (marker, no human newest message) stays allowed.
    await say(f, "[Hydra check-in] daily, use sentry");
    expect(f.servers["sentry"]!.calls.map((c) => c.name)).toEqual([
      "find_projects",
      "find_projects",
    ]);
  });
});

// ─── Labels ──────────────────────────────────────────────────────────────────

describe("activity labels", () => {
  it("never shows raw connector tool names or arguments", () => {
    expect(computeToolLabel("tool_search", { query: "secret thing" })).toBe("Looking for tools");
    expect(computeToolLabel("mcp__notion__create_pages", { pages: [{ title: "x" }] })).toBe(
      "Using Notion",
    );
    expect(computeToolLabel("mcp__sentry__search_issues", { query: "x" })).toBe("Using Sentry");
    expect(computeToolLabel("web_search", {})).toBe("Searching the web");
  });
});
