/**
 * web-tools.test.ts
 *
 * Tests for the @diegopetrucci/pi-web-access adapter in web-tools.ts.
 *
 * Network-free: no real HTTP calls are made.
 *  – Tool registration and label tests do not execute any tool.
 *  – Budget-reset test uses a mock callback, no network path is entered.
 *  – globalThis.fetch is spied on in beforeAll to fail loudly if any code
 *    path unexpectedly reaches the network during the test suite.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { webToolsExtension, WEB_TOOL_NAMES } from "../src/web-tools.js";
import { computeToolLabel, isTaskFailedAuthError } from "../src/bot-watcher.js";

// ─── Network guard ────────────────────────────────────────────────────────────

let savedFetch: typeof globalThis.fetch;

beforeAll(() => {
  savedFetch = globalThis.fetch;
  // Fail loudly if any test unexpectedly reaches the network.
  globalThis.fetch = ((): never => {
    throw new Error("Unexpected real network call in web-tools tests – stub the transport instead");
  }) as unknown as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = savedFetch;
});

// ─── Tool registration ────────────────────────────────────────────────────────

describe("web-tools extension registration", () => {
  it("registers exactly web_search, fetch_content, and get_search_content", () => {
    const names = webToolsExtension.tools?.map((t) => t.name) ?? [];
    expect(names).toEqual(["web_search", "fetch_content", "get_search_content"]);
  });

  it("exports WEB_TOOL_NAMES matching the extension tools", () => {
    expect([...WEB_TOOL_NAMES]).toEqual(["web_search", "fetch_content", "get_search_content"]);
  });

  it("extension is named 'web-tools'", () => {
    expect(webToolsExtension.name).toBe("web-tools");
  });

  it("extension includes a safety PromptSection", () => {
    expect(webToolsExtension.sections?.length).toBeGreaterThan(0);
    const section = webToolsExtension.sections?.[0];
    expect(section).toBeDefined();
    const rendered =
      typeof section?.render === "function" ? (section.render as () => string)() : undefined;
    expect(rendered).toMatch(/untrusted/i);
  });

  it("each tool has a description", () => {
    for (const tool of webToolsExtension.tools ?? []) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe("tool result mapping (pi-durable 1.2.0)", () => {
  it("maps the captured tool's `content` to the durable result's `output`", async () => {
    const tool = webToolsExtension.tools?.find((t) => t.name === "get_search_content");
    expect(tool).toBeDefined();
    // Unknown responseId: returns an error-ish text result without any network call.
    const result = (await tool!.execute(
      { responseId: "does-not-exist" },
      { callId: "c1" } as never,
      {} as never,
    )) as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty("content");
    const output = result.output as Array<{ type: string; text?: string }>;
    expect(Array.isArray(output)).toBe(true);
    expect(output[0]?.type).toBe("text");
    expect(typeof output[0]?.text).toBe("string");
  });
});

// ─── Activity labels ──────────────────────────────────────────────────────────

describe("computeToolLabel – activity label generation", () => {
  it("web_search → 'Searching the web'", () => {
    expect(computeToolLabel("web_search", {})).toBe("Searching the web");
  });

  it("web_search with query arg → 'Searching the web'", () => {
    expect(computeToolLabel("web_search", { query: "TypeScript generics" })).toBe(
      "Searching the web",
    );
  });

  it("fetch_content with a single url → 'Reading <host>'", () => {
    expect(computeToolLabel("fetch_content", { url: "https://example.com/some/path?q=1" })).toBe(
      "Reading example.com",
    );
  });

  it("fetch_content with a urls array of 1 → 'Reading <host>'", () => {
    expect(
      computeToolLabel("fetch_content", {
        urls: ["https://docs.anthropic.com/page"],
      }),
    ).toBe("Reading docs.anthropic.com");
  });

  it("fetch_content with multiple urls → 'Reading N pages'", () => {
    expect(
      computeToolLabel("fetch_content", {
        urls: ["https://a.com", "https://b.com", "https://c.com"],
      }),
    ).toBe("Reading 3 pages");
  });

  it("fetch_content with no urls → 'Fetching content'", () => {
    expect(computeToolLabel("fetch_content", {})).toBe("Fetching content");
  });

  it("get_search_content → 'Reading saved results'", () => {
    expect(computeToolLabel("get_search_content", { responseId: "abc123" })).toBe(
      "Reading saved results",
    );
  });

  it("unknown tool name → returns the tool name", () => {
    expect(computeToolLabel("bash_exec", {})).toBe("bash_exec");
  });

  it("fetch_content label does not contain a query string", () => {
    const label = computeToolLabel("fetch_content", {
      url: "https://search.example.com/?q=secret+query&page=2",
    });
    // Host only – no '?' and no query string
    expect(label).toBe("Reading search.example.com");
    expect(label).not.toContain("?");
    expect(label).not.toContain("secret");
  });
});

// ─── Budget reset (run_start callback) ───────────────────────────────────────

describe("budget reset per reply", () => {
  it("BotWatcher calls onRunStart exactly once for each run_start event", async () => {
    // Use the BotWatcher class directly to verify the callback contract without
    // needing a real Harness or network.  We reach the private handleEvent
    // method by accessing it as unknown.
    const { BotWatcher } = await import("../src/bot-watcher.js");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

    const emitted: unknown[] = [];
    let runStartCallCount = 0;

    // Construct a minimal BotWatcher.  The Harness argument is never used in
    // handleEvent (only in start/stop which we don't call here).
    const watcher = new BotWatcher(
      /* harness  */ {} as never,
      /* convId   */ 42 as never,
      /* emitFn   */ (ev) => emitted.push(ev),
      /* getBot   */ () => undefined,
      /* updateLastMessage */ async () => {},
      /* ctx      */ BACKGROUND_CONTEXT,
      /* onRunStart */ () => {
        runStartCallCount++;
      },
    );

    // Access private handleEvent via unknown cast.
    const handleEvent = (
      watcher as unknown as {
        handleEvent: (ev: unknown, botId: string) => Promise<void>;
      }
    ).handleEvent.bind(watcher);

    // Fire two run_start events to verify the counter increments correctly.
    await handleEvent({ type: "run_start", inputs: [] }, "42");
    await handleEvent({ type: "run_start", inputs: [] }, "42");

    expect(runStartCallCount).toBe(2);

    // Verify the thinking activity event is still emitted.
    const thinkingEvents = emitted.filter(
      (e) =>
        (e as { event?: string }).event === "bot.activity" &&
        (e as { activity?: string }).activity === "thinking",
    );
    expect(thinkingEvents.length).toBe(2);
  });

  it("onRunStart is not called for turn_start (only run_start triggers budget reset)", async () => {
    const { BotWatcher } = await import("../src/bot-watcher.js");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

    let runStartCallCount = 0;

    const watcher = new BotWatcher(
      {} as never,
      1 as never,
      () => {},
      () => undefined,
      async () => {},
      BACKGROUND_CONTEXT,
      () => {
        runStartCallCount++;
      },
    );

    const handleEvent = (
      watcher as unknown as {
        handleEvent: (ev: unknown, botId: string) => Promise<void>;
      }
    ).handleEvent.bind(watcher);

    await handleEvent({ type: "turn_start" }, "1");
    expect(runStartCallCount).toBe(0);
  });
});

// ─── Tool-call activity event routing ────────────────────────────────────────

describe("tool_execution_start activity event", () => {
  it("emits bot.activity with activity:'tool', correct tool name and label", async () => {
    const { BotWatcher } = await import("../src/bot-watcher.js");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

    const emitted: unknown[] = [];

    const watcher = new BotWatcher(
      {} as never,
      7 as never,
      (ev) => emitted.push(ev),
      () => undefined,
      async () => {},
      BACKGROUND_CONTEXT,
    );

    const handleEvent = (
      watcher as unknown as {
        handleEvent: (ev: unknown, botId: string) => Promise<void>;
      }
    ).handleEvent.bind(watcher);

    await handleEvent(
      {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "web_search",
        args: { query: "TypeScript" },
      },
      "7",
    );

    const activityEvent = emitted[0] as {
      event: string;
      activity: string;
      tool: string;
      label: string;
    };
    expect(activityEvent.event).toBe("bot.activity");
    expect(activityEvent.activity).toBe("tool");
    expect(activityEvent.tool).toBe("web_search");
    expect(activityEvent.label).toBe("Searching the web");
  });

  it("emits 'Reading <host>' label for fetch_content with a single URL", async () => {
    const { BotWatcher } = await import("../src/bot-watcher.js");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

    const emitted: unknown[] = [];

    const watcher = new BotWatcher(
      {} as never,
      8 as never,
      (ev) => emitted.push(ev),
      () => undefined,
      async () => {},
      BACKGROUND_CONTEXT,
    );

    const handleEvent = (
      watcher as unknown as {
        handleEvent: (ev: unknown, botId: string) => Promise<void>;
      }
    ).handleEvent.bind(watcher);

    await handleEvent(
      {
        type: "tool_execution_start",
        toolCallId: "c2",
        toolName: "fetch_content",
        args: { url: "https://nodejs.org/en/docs" },
      },
      "8",
    );

    const activityEvent = emitted[0] as { label: string };
    expect(activityEvent.label).toBe("Reading nodejs.org");
  });
});

//

describe("item 2 \ task_failed auth classification", () => {
  it("auth error message is classified as auth_required; bot.activity idle is emitted", async () => {
    const { BotWatcher } = await import("../src/bot-watcher.js");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

    const emitted: unknown[] = [];
    const watcher = new BotWatcher(
      {} as never,
      99 as never,
      (ev) => emitted.push(ev),
      () => undefined,
      async () => {},
      BACKGROUND_CONTEXT,
    );
    const handleEvent = (
      watcher as unknown as {
        handleEvent: (ev: unknown, botId: string) => Promise<void>;
      }
    ).handleEvent.bind(watcher);

    // Simulate a task_failed with an auth error message from pi-ai resolve.js.
    await handleEvent(
      {
        type: "task_failed",
        taskId: 1,
        kind: "pi.generation",
        message: "API key auth failed for provider anthropic",
      },
      "99",
    );

    const errorEvent = emitted.find((e) => (e as { event?: string }).event === "bot.error") as
      | { code: string; message: string }
      | undefined;
    expect(errorEvent?.code).toBe("auth_required");
    expect(errorEvent?.message).toBe("Anthropic API key is missing or invalid.");

    // bot.activity idle must be emitted after the error.
    const idleEvent = emitted.find(
      (e) =>
        (e as { event?: string }).event === "bot.activity" &&
        (e as { activity?: string }).activity === "idle",
    );
    expect(idleEvent).toBeDefined();
  });

  it("oauth error message is classified as auth_required", async () => {
    const { BotWatcher } = await import("../src/bot-watcher.js");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

    const emitted: unknown[] = [];
    const watcher = new BotWatcher(
      {} as never,
      100 as never,
      (ev) => emitted.push(ev),
      () => undefined,
      async () => {},
      BACKGROUND_CONTEXT,
    );
    const handleEvent = (
      watcher as unknown as {
        handleEvent: (ev: unknown, botId: string) => Promise<void>;
      }
    ).handleEvent.bind(watcher);

    await handleEvent(
      {
        type: "task_failed",
        taskId: 2,
        kind: "pi.generation",
        message: "OAuth refresh failed for anthropic",
      },
      "100",
    );

    const errorEvent = emitted.find((e) => (e as { event?: string }).event === "bot.error") as
      | { code: string }
      | undefined;
    expect(errorEvent?.code).toBe("auth_required");
  });

  it("generic error message is classified as generation_failed; idle is still emitted", async () => {
    const { BotWatcher } = await import("../src/bot-watcher.js");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

    const emitted: unknown[] = [];
    const watcher = new BotWatcher(
      {} as never,
      101 as never,
      (ev) => emitted.push(ev),
      () => undefined,
      async () => {},
      BACKGROUND_CONTEXT,
    );
    const handleEvent = (
      watcher as unknown as {
        handleEvent: (ev: unknown, botId: string) => Promise<void>;
      }
    ).handleEvent.bind(watcher);

    await handleEvent(
      { type: "task_failed", taskId: 3, kind: "pi.generation", message: "Context window exceeded" },
      "101",
    );

    const errorEvent = emitted.find((e) => (e as { event?: string }).event === "bot.error") as
      | { code: string; message: string }
      | undefined;
    expect(errorEvent?.code).toBe("generation_failed");
    expect(errorEvent?.message).toBe("Generation failed.");
    // No raw upstream message.
    expect(JSON.stringify(emitted)).not.toContain("Context window exceeded");

    // bot.activity idle is emitted after any task_failed.
    const idleEvent = emitted.find(
      (e) =>
        (e as { event?: string }).event === "bot.activity" &&
        (e as { activity?: string }).activity === "idle",
    );
    expect(idleEvent).toBeDefined();
  });

  it("item 3 \ raw upstream message does not appear in any bot.error event", async () => {
    const { BotWatcher } = await import("../src/bot-watcher.js");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

    const SENTINEL = "SENTINEL_RAW_ERROR_sk_live_abc123";
    const emitted: unknown[] = [];
    const watcher = new BotWatcher(
      {} as never,
      102 as never,
      (ev) => emitted.push(ev),
      () => undefined,
      async () => {},
      BACKGROUND_CONTEXT,
    );
    const handleEvent = (
      watcher as unknown as {
        handleEvent: (ev: unknown, botId: string) => Promise<void>;
      }
    ).handleEvent.bind(watcher);

    // Simulate a task_failed whose message contains a raw upstream secret.
    await handleEvent(
      {
        type: "task_failed",
        taskId: 4,
        kind: "pi.generation",
        message: `HTTP error 503: ${SENTINEL}`,
      },
      "102",
    );

    // The sentinel must not appear in any emitted event.
    expect(JSON.stringify(emitted)).not.toContain(SENTINEL);
  });
});

//

describe("isTaskFailedAuthError classification", () => {
  it.each([
    ["API key auth failed for provider anthropic", true],
    ["OAuth refresh failed for anthropic", true],
    ["Credential store read failed for anthropic", true],
    ["OAuth auth derivation failed for anthropic", true],
    ["HTTP 401 Unauthorized", true],
    ["status=403 Forbidden", true],
    ["Unauthorized", true],
    ["Unauthenticated", true],
    ["Context window exceeded", false],
    ["Model response ended with stop reason error", false],
    ["Rate limit reached", false],
    ["Timeout after 30 seconds", false],
    // re-review (b): 'auth' must be matched as a whole word; 'author' must not match.
    ["Error written by the file author", false],
    ["Invalid authority header", false],
    ["Authorization granted", false],
    // re-review (b) correction: 401/403 must be whole numbers; longer tokens must not match.
    ["used 4012 tokens", false],
    ["error 14030", false],
    ["rate limit 429", false],
    // Anthropic error type strings embedded in message.
    ['401 {"type":"error","error":{"type":"authentication_error"}}', true],
    ["authentication_error", true],
    ["permission_error", true],
  ])("%s → %s", (message, expected) => {
    expect(isTaskFailedAuthError(message)).toBe(expected);
  });

  it("structured detail with authentication_error classifies as auth (overrides message)", () => {
    expect(
      isTaskFailedAuthError("Generation failed", {
        error: { type: "authentication_error", message: "Invalid API key" },
      }),
    ).toBe(true);
  });

  it("structured detail with permission_error classifies as auth", () => {
    expect(
      isTaskFailedAuthError("Generation failed", { error: { type: "permission_error" } }),
    ).toBe(true);
  });

  it("structured detail with HTTP 401 status classifies as auth", () => {
    expect(isTaskFailedAuthError("Generation failed", { status: 401 })).toBe(true);
  });

  it("structured detail with non-auth status falls back to message (not auth)", () => {
    expect(isTaskFailedAuthError("Context window exceeded", { status: 429 })).toBe(false);
  });
});
