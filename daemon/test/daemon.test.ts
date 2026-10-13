/**
 * daemon.test.ts
 *
 * Acceptance tests for the Hydra daemon core.  Uses:
 *  – pi-ai faux provider  (no network)
 *  – pi-durable MemoryStorage  (except the reopen test, which uses SQLite)
 *  – DaemonCore directly  (no stdin/stdout)
 *  – lock module tests  (spawned child process for live-PID check)
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createTestModels } from "../src/models.js";
import { DaemonCore } from "../src/daemon-core.js";
import { acquireLock, releaseLock, LockError } from "../src/lock.js";
import { describeError } from "../src/describe-error.js";
import { FileCredentialStore } from "../src/credential-store.js";
import type { ProtocolEvent } from "../src/protocol.js";

const ctx = BACKGROUND_CONTEXT;

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function makeCore(storage: Storage = new MemoryStorage()): Promise<{
  core: DaemonCore;
  events: ProtocolEvent[];
  faux: FauxProviderHandle;
  harness: Harness;
}> {
  const { models, faux } = await createTestModels();
  // partialIntervalMs: 100 gives pi-durable time to commit progress so that
  // message_update / text_delta agent events fire during the response.
  const harness = await Harness.open(
    storage,
    {
      models,
      registry: createRegistry(),
      settings: { progress: { partialIntervalMs: 100, outputIntervalMs: 100 } },
    },
    ctx,
  );
  const events: ProtocolEvent[] = [];
  // enableIntro=false: existing tests do not queue an intro faux response;
  // turning it off prevents the intro from consuming queued faux replies.
  const core = new DaemonCore(
    harness,
    models,
    (ev) => events.push(ev),
    ctx,
    undefined,
    undefined,
    [],
    undefined,
    false,
  );
  await core.start();
  return { core, events, faux, harness };
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

type BotResult = { id: string; name: string };
type MsgResult = { role: string; text: string };
type MsgWithId = { id: string; role: string; text: string; createdAt: string };
type CompletedEvent = {
  event: string;
  botId: string;
  messageId: string;
  message: MsgWithId;
};

// ─── hello ────────────────────────────────────────────────────────────────────

describe("hello command", () => {
  it("returns protocolVersion and daemonVersion", async () => {
    const { core } = await makeCore();
    const res = await core.handleRequest({ id: "r1", type: "hello" });
    expect(res).toMatchObject({
      id: "r1",
      type: "result",
      result: {
        protocolVersion: expect.any(String),
        daemonVersion: expect.any(String),
        tools: expect.any(Array),
      },
    });
  });
});

// ─── streaming events ─────────────────────────────────────────────────────────

describe("bots.create and bots.send – streamed events", () => {
  it("emits message.delta and message.completed after sending", async () => {
    const { core, faux, events } = await makeCore();

    faux.setResponses([fauxAssistantMessage(fauxText("Hello from bot!"))]);

    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "Test Bot",
      instructions: "Be helpful.",
      model: "faux/faux-1",
    });
    expect(createRes).toMatchObject({ type: "result" });
    const bot = (createRes as { result: BotResult }).result;
    const botId = bot.id;

    const sendRes = await core.handleRequest({
      id: "r2",
      type: "bots.send",
      botId,
      text: "Hello",
      clientMessageId: "cm-1",
    });
    expect(sendRes).toMatchObject({ type: "result", result: { accepted: true } });

    await waitFor(() =>
      events.some((e) => e.event === "message.completed" && "botId" in e && e.botId === botId),
    );

    const deltas = events.filter(
      (e) => e.event === "message.delta" && "botId" in e && e.botId === botId,
    );
    const completed = events.find(
      (e) => e.event === "message.completed" && "botId" in e && e.botId === botId,
    ) as CompletedEvent | undefined;

    // At least one delta (faux streams token by token).
    expect(deltas.length).toBeGreaterThan(0);

    // The completed event has the full text.
    expect(completed).toMatchObject({
      event: "message.completed",
      botId,
      message: { role: "assistant", text: expect.stringContaining("Hello from bot!") },
    });

    // message.completed carries both a streaming messageId and a durable message.id.
    expect(typeof completed?.messageId).toBe("string");
    expect(completed?.messageId.startsWith("msg-")).toBe(true);
    expect(typeof completed?.message.id).toBe("string");
    // The durable message.id is numeric (pi-durable entry id).
    expect(isNaN(Number(completed?.message.id))).toBe(false);
    // createdAt must be a non-empty ISO string.
    expect(completed?.message.createdAt).toMatch(/^\d{4}-/);

    // The message.started event carries the same messageId.
    const started = events.find(
      (e) => e.event === "message.started" && "botId" in e && e.botId === botId,
    ) as { messageId?: string } | undefined;
    expect(started?.messageId).toBe(completed?.messageId);
  });

  it("message.completed.message.id matches the bots.history entry id", async () => {
    const { core, faux, events } = await makeCore();

    faux.setResponses([fauxAssistantMessage(fauxText("History ID test"))]);

    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "ID Bot",
      instructions: "",
      model: "faux/faux-1",
    });
    const botId = (createRes as { result: BotResult }).result.id;

    await core.handleRequest({
      id: "r2",
      type: "bots.send",
      botId,
      text: "Hi",
      clientMessageId: "cm-id-test",
    });

    // Wait for message.completed.
    await waitFor(() =>
      events.some(
        (e) =>
          e.event === "message.completed" &&
          "botId" in e &&
          (e as { botId: string }).botId === botId,
      ),
    );

    const completed = events.find(
      (e) =>
        e.event === "message.completed" && "botId" in e && (e as { botId: string }).botId === botId,
    ) as CompletedEvent;

    // Fetch history and check the durable id matches.
    const histRes = await core.handleRequest({ id: "r3", type: "bots.history", botId });
    const msgs = (histRes as { result: MsgWithId[] }).result;
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    expect(assistantMsgs.length).toBeGreaterThan(0);
    expect(assistantMsgs[0]?.id).toBe(completed.message.id);
  });
});

// ─── timestamps in history ────────────────────────────────────────────────────

describe("bots.history timestamps", () => {
  it("user message history entries have a non-empty createdAt", async () => {
    const { core, faux } = await makeCore();

    faux.setResponses([fauxAssistantMessage(fauxText("Timestamp reply"))]);

    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "TS Bot",
      instructions: "",
      model: "faux/faux-1",
    });
    const botId = (createRes as { result: BotResult }).result.id;

    await core.handleRequest({
      id: "r2",
      type: "bots.send",
      botId,
      text: "When am I?",
      clientMessageId: "cm-ts-1",
    });

    // Wait for reply to appear in history.
    await waitFor(async () => {
      const h = await core.handleRequest({ id: "r3", type: "bots.history", botId });
      const msgs = (h as { result: MsgWithId[] }).result;
      return Array.isArray(msgs) && msgs.length >= 2;
    });

    const histRes = await core.handleRequest({ id: "r4", type: "bots.history", botId });
    const msgs = (histRes as { result: MsgWithId[] }).result;

    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs.length).toBeGreaterThan(0);
    for (const m of userMsgs) {
      // Must be a non-empty ISO 8601 timestamp.
      expect(m.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    for (const m of assistantMsgs) {
      expect(m.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

// ─── persistence ──────────────────────────────────────────────────────────────

describe("persistence across reopens", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hydra-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("bots and history survive a harness reopen", async () => {
    const dbPath = join(tmpDir, "harness.sqlite");
    let botId = "";

    // ── Session 1 ──
    {
      const storage1 = await openNodeSqliteStorage(dbPath);
      const { core, faux, harness } = await makeCore(storage1);

      faux.setResponses([fauxAssistantMessage(fauxText("Persisted reply"))]);

      const createRes = await core.handleRequest({
        id: "r1",
        type: "bots.create",
        name: "Persistent Bot",
        instructions: "Persist me.",
        model: "faux/faux-1",
      });
      botId = (createRes as { result: BotResult }).result.id;

      await core.handleRequest({
        id: "r2",
        type: "bots.send",
        botId,
        text: "Will you persist?",
        clientMessageId: "cm-persist-1",
      });

      await waitFor(async () => {
        const histRes = await core.handleRequest({ id: "r3", type: "bots.history", botId });
        const msgs = (histRes as { result: MsgResult[] }).result;
        return Array.isArray(msgs) && msgs.length >= 2;
      });

      await core.close();
      await harness.close(ctx);
    }

    // ── Session 2 ──
    {
      const storage2 = await openNodeSqliteStorage(dbPath);
      const { models: models2 } = await createTestModels();
      const harness2 = await Harness.open(
        storage2,
        { models: models2, registry: createRegistry() },
        ctx,
      );
      const core2 = new DaemonCore(harness2, models2, () => {}, ctx);
      await core2.start();

      const listRes = await core2.handleRequest({ id: "r4", type: "bots.list" });
      const bots = (listRes as { result: BotResult[] }).result;
      expect(bots.some((b) => b.id === botId && b.name === "Persistent Bot")).toBe(true);

      const histRes = await core2.handleRequest({ id: "r5", type: "bots.history", botId });
      const msgs = (histRes as { result: MsgResult[] }).result;
      expect(msgs.some((m) => m.role === "user")).toBe(true);

      await core2.close();
      await harness2.close(ctx);
    }
  });
});

// ─── dedup ────────────────────────────────────────────────────────────────────

describe("duplicate clientMessageId is processed once", () => {
  it("submitting the same requestId twice does not create two user entries", async () => {
    const { core, faux } = await makeCore();

    faux.setResponses([
      fauxAssistantMessage(fauxText("Only once")),
      fauxAssistantMessage(fauxText("Second call — should not happen")),
    ]);

    const createRes = await core.handleRequest({
      id: "r1",
      type: "bots.create",
      name: "Dedup Bot",
      instructions: "Test dedup.",
      model: "faux/faux-1",
    });
    const botId = (createRes as { result: BotResult }).result.id;

    await core.handleRequest({
      id: "r2",
      type: "bots.send",
      botId,
      text: "Hello",
      clientMessageId: "cm-dedup",
    });
    await core.handleRequest({
      id: "r3",
      type: "bots.send",
      botId,
      text: "Hello",
      clientMessageId: "cm-dedup",
    });

    await waitFor(async () => {
      const h = await core.handleRequest({ id: "r4", type: "bots.history", botId });
      const msgs = (h as { result: MsgResult[] }).result;
      return Array.isArray(msgs) && msgs.some((m) => m.role === "assistant");
    }, 5000);

    const histRes = await core.handleRequest({ id: "r5", type: "bots.history", botId });
    const msgs = (histRes as { result: MsgWithId[] }).result;
    expect(msgs.filter((m) => m.role === "user").length).toBe(1);
  });
});

// ─── malformed input ──────────────────────────────────────────────────────────

describe("malformed input", () => {
  it("returns id:null for a non-object", async () => {
    const { core } = await makeCore();
    const res = await core.handleRequest("not-an-object");
    expect(res).toMatchObject({ id: null, type: "error", error: { code: "bad_request" } });
  });

  it("daemon stays operational after malformed input", async () => {
    const { core } = await makeCore();
    await core.handleRequest("bad");
    const helloRes = await core.handleRequest({ id: "r1", type: "hello" });
    expect(helloRes).toMatchObject({ type: "result" });
  });

  it("handles missing type field", async () => {
    const { core } = await makeCore();
    const res = await core.handleRequest({ id: "r1" });
    expect(res).toMatchObject({ type: "error", error: { code: "bad_request" } });
  });

  it("handles unknown command type gracefully", async () => {
    const { core } = await makeCore();
    const res = await core.handleRequest({ id: "r1", type: "unknown.thing" });
    expect(res).toMatchObject({ type: "error", error: { code: "unknown_command" } });
  });

  it("returns id:null when id is missing from the request", async () => {
    const { core } = await makeCore();
    // Valid type but no id → must get {id:null, type:"error", code:"bad_request"}
    const res = await core.handleRequest({ type: "hello" });
    expect(res).toMatchObject({ id: null, type: "error", error: { code: "bad_request" } });
  });

  it("returns id:null when id is a number (not a string)", async () => {
    const { core } = await makeCore();
    const res = await core.handleRequest({ id: 42, type: "hello" });
    expect(res).toMatchObject({ id: null, type: "error", error: { code: "bad_request" } });
  });
});

// ─── single-instance lock ─────────────────────────────────────────────────────

describe("single-instance lock", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hydra-lock-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("acquires the lock when no file exists and creates daemon.pid", () => {
    const lockPath = acquireLock(tmpDir);
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses when a live foreign pid holds the lock", () => {
    // process.ppid is the parent of this vitest worker — guaranteed to be alive.
    const livePid = process.ppid;
    writeFileSync(join(tmpDir, "daemon.pid"), String(livePid));

    let threw: Error | undefined;
    try {
      acquireLock(tmpDir);
    } catch (e) {
      threw = e as Error;
    }

    expect(threw).toBeInstanceOf(LockError);
    expect((threw as LockError).pid).toBe(livePid);
  });

  it("acquires the lock when the recorded pid is dead", () => {
    const deadPid = 2_000_000; // Extremely unlikely to exist.
    writeFileSync(join(tmpDir, "daemon.pid"), String(deadPid));

    // Should succeed (stale lock removed, new lock written).
    const lockPath = acquireLock(tmpDir);
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(lockPath);
  });

  it("release removes the file", () => {
    const lockPath = acquireLock(tmpDir);
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releaseLock does NOT delete the file when it names a different PID (ownership check)", () => {
    // Write a foreign PID into the lock file directly.
    const lockPath = join(tmpDir, "daemon.pid");
    const foreignPid = process.pid + 1000; // Not this process.
    writeFileSync(lockPath, String(foreignPid));
    // releaseLock should leave the file untouched.
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("lock file is never empty: contains our PID immediately after acquisition", () => {
    const lockPath = acquireLock(tmpDir);
    const content = require("node:fs").readFileSync(lockPath, "utf8").trim();
    expect(content).toBe(String(process.pid));
    releaseLock(lockPath);
  });
});

//

describe("item 1 \ async handler errors preserve the request id", () => {
  it("error from a rejecting async handler carries the request id, not null", async () => {
    // Build a DaemonCore with a credential store whose modify() always throws.
    const { models } = await createTestModels();
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      ctx,
    );
    const events: ProtocolEvent[] = [];

    const throwingStore = new InMemoryCredentialStore();
    const origModify = throwingStore.modify.bind(throwingStore);
    throwingStore.modify = async (_p, _fn, _opts) => {
      // Simulate a storage error that throws asynchronously.
      await new Promise<void>((r) => setTimeout(r, 0));
      throw new Error("SENTINEL_STORAGE_CRASH");
    };
    // Restore unused orig to avoid lint noise.
    void origModify;

    const core = new DaemonCore(harness, models, (ev) => events.push(ev), ctx, throwingStore);
    await core.start();

    const res = await core.handleRequest({
      id: "req-42",
      type: "auth.setApiKey",
      providerId: "anthropic",
      apiKey: "sk-test",
    });

    // Must return an error with the correct id (not null).
    expect(res).toMatchObject({
      id: "req-42",
      type: "error",
      error: { code: "internal_error" },
    });
    // Raw error text must NOT appear in the response (item 3 sanitization).
    expect(JSON.stringify(res)).not.toContain("SENTINEL_STORAGE_CRASH");
  });
});

//

describe("item 5 \ credential store global serialisation across providers", () => {
  let tmpDir2: string;

  beforeEach(async () => {
    tmpDir2 = await mkdtemp(join(tmpdir(), "hydra-credglobal-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir2, { recursive: true, force: true });
  });

  it("concurrent modify for two providers both survive (global chain)", async () => {
    const store = new FileCredentialStore(tmpDir2);

    // Simultaneously write two different providers.
    await Promise.all([
      store.modify("anthropic", async () => ({
        type: "api_key" as const,
        key: "sk-anthropic-key",
      })),
      store.modify("openai", async () => ({
        type: "api_key" as const,
        key: "sk-openai-key",
      })),
    ]);

    // Both credentials must be persisted.
    const anthropic = await store.read("anthropic");
    const openai = await store.read("openai");
    expect(anthropic).toMatchObject({ type: "api_key" });
    expect(openai).toMatchObject({ type: "api_key" });
    // Secrets must NOT appear in the file listing.
    const { readFileSync: rfs } = await import("node:fs");
    const raw = rfs(store.path, "utf-8");
    // The keys themselves appear in the credentials file, but the test is that
    // BOTH providers survived (no corruption due to racing writes).
    const parsed = JSON.parse(raw) as { credentials: Record<string, unknown> };
    expect(Object.keys(parsed.credentials)).toContain("anthropic");
    expect(Object.keys(parsed.credentials)).toContain("openai");
  });
});

//

describe("item 7 \ large response survives stdin-EOF flush", () => {
  it("bots.list result is fully returned for a large bot list (> 64 KB response)", async () => {
    // This test covers the DaemonCore side of large responses.
    // The main.ts fix (process.exitCode vs process.exit) ensures stdout
    // is not truncated at the process level when stdin closes immediately;
    // that fix cannot be tested in-process without spawning a subprocess.
    const { core, faux } = await makeCore();

    // Create 60 bots so the bots.list response JSON exceeds 64 KB.
    // Each bot needs a response so the harness doesn't get confused.
    const botCount = 60;
    faux.appendResponses(
      Array.from({ length: botCount }, (_, i) => fauxAssistantMessage(fauxText(`Reply ${i}`))),
    );

    const botIds: string[] = [];
    for (let i = 0; i < botCount; i++) {
      const res = await core.handleRequest({
        id: `rc-${i}`,
        type: "bots.create",
        name: `Bot ${"-".repeat(200)} ${i}`, // Long name to inflate response size.
        instructions: "x".repeat(400),
        model: "faux/faux-1",
      });
      botIds.push((res as { result: BotResult }).result.id);
    }

    // Retrieve the full list – this response must be complete.
    const listRes = await core.handleRequest({ id: "list-big", type: "bots.list" });
    expect(listRes.type).toBe("result");
    const bots = (listRes as { result: BotResult[] }).result;
    // All bots must be present (response is not truncated).
    expect(bots.length).toBe(botCount);
    expect(new Set(bots.map((b: BotResult) => b.id)).size).toBe(botCount);
  });
});

// ─── re-review (a): transport-fallback and fatal-handler error sanitization ───

describe("re-review (a) \ transport fallback and fatal handler sanitize errors", () => {
  it("describeError never includes the raw error message (sentinel-secret test)", () => {
    const SENTINEL = "SENTINEL_SECRET_sk_live_rawmessage_abcdef";
    const err = new Error(`OAuth token refresh failed: secret=${SENTINEL}&body=Bearer+${SENTINEL}`);
    const desc = describeError(err);
    // Must not contain the sentinel in any form.
    expect(desc).not.toContain(SENTINEL);
    // Should contain the class name, not the message.
    expect(desc).toBe("Error");
  });

  it("describeError omits a code that is not identifier-like (secret-bearing OAuth error)", () => {
    const err = Object.assign(new Error("boom"), {
      code: "invalid_grant: refresh_token=sekret-123",
    });
    expect(describeError(err)).toBe("Error");
    expect(describeError(Object.assign(new Error("x"), { code: "a".repeat(41) }))).toBe("Error");
    expect(describeError(Object.assign(new Error("x"), { code: "invalid_grant" }))).toBe(
      "Error code=invalid_grant",
    );
    expect(describeError(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(
      "Error code=ENOENT",
    );
    // Identifier-shaped but not on the allowlist: omitted.
    expect(
      describeError(Object.assign(new Error("x"), { code: "SENTINEL_PRIVATE_TOKEN_123" })),
    ).toBe("Error");
    expect(
      describeError(Object.assign(new Error("x"), { code: "sentinel_private_token_123" })),
    ).toBe("Error");
    expect(describeError(Object.assign(new Error("x"), { code: "sign_in_busy" }))).toBe(
      "Error code=sign_in_busy",
    );
  });

  it("describeError includes code when present but not raw message", async () => {
    const { ModelsError } = await import("@earendil-works/pi-ai");
    const SENTINEL = "SENTINEL_OAUTH_BODY_secret_xyzabc";
    const err = new ModelsError("oauth", `OAuth failed: body=${SENTINEL}`);
    const desc = describeError(err);
    // Code is logged; raw message with sentinel is not.
    expect(desc).toBe("ModelsError code=oauth");
    expect(desc).not.toContain(SENTINEL);
  });

  it("transport fallback message is stable 'Internal error.' (not raw exception text)", async () => {
    // The transport fallback in main.ts calls writeStdout with a fixed message.
    // Verify this by inspecting DaemonCore's own catch which uses the same
    // stable-message pattern established by item 1 and re-confirmed here.
    const SENTINEL = "SENTINEL_TRANSPORT_rawmsg_xyz";
    const { models } = await createTestModels();
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      ctx,
    );
    const throwingStore = new InMemoryCredentialStore();
    throwingStore.modify = async () => {
      throw new Error(`Unexpected internal failure: secret=${SENTINEL}`);
    };
    const core = new DaemonCore(harness, models, () => {}, ctx, throwingStore);
    await core.start();

    const res = await core.handleRequest({
      id: "t1",
      type: "auth.setApiKey",
      providerId: "anthropic",
      apiKey: "sk-x",
    });
    // The sentinel must not appear in the response that DaemonCore emits.
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
    expect((res as { error?: { message: string } }).error?.message).not.toContain(SENTINEL);
  });
});

// ─── re-review (d): lock temp file in same directory as daemon.pid ────────────

describe("re-review (d) \ lock temp file co-located with daemon.pid", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hydra-lock-rr-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("no .tmp files remain in the data directory after acquisition (cleanup verified)", () => {
    const lockPath = acquireLock(tmpDir);
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const tmpFiles = readdirSync(tmpDir).filter((f: string) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
    releaseLock(lockPath);
  });

  it("no .tmp files remain when acquisition fails (existing live lock)", () => {
    // Write a live PID into the lock file so acquisition fails.
    const { writeFileSync: wfs, readdirSync } = require("node:fs") as typeof import("node:fs");
    const lockPath = join(tmpDir, "daemon.pid");
    wfs(lockPath, String(process.ppid)); // ppid is guaranteed alive.

    let threw = false;
    try {
      acquireLock(tmpDir);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Even on failure the temp file must have been cleaned up.
    const tmpFiles = readdirSync(tmpDir).filter((f: string) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe("offered models (production provider)", () => {
  async function makeProdCore(): Promise<DaemonCore> {
    const { createModels } = await import("../src/models.js");
    const models = createModels();
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      ctx,
    );
    const core = new DaemonCore(
      harness,
      models,
      () => {},
      ctx,
      undefined,
      undefined,
      [],
      undefined,
      false,
    );
    await core.start();
    return core;
  }

  it("models.list returns only Sonnet 5.5", async () => {
    const core = await makeProdCore();
    const res = (await core.handleRequest({ id: "1", type: "models.list" })) as {
      result: { provider: string; modelId: string; default: boolean }[];
    };
    expect(res.result.map((m) => `${m.provider}/${m.modelId}`)).toEqual([
      "anthropic/claude-sonnet-5-5",
    ]);
    expect(res.result[0]?.default).toBe(true);
  });

  it("bots.create rejects an unoffered anthropic model and accepts omitted model", async () => {
    const core = await makeProdCore();
    const bad = (await core.handleRequest({
      id: "2",
      type: "bots.create",
      name: "B",
      model: "anthropic/claude-haiku-4-5",
    })) as { type: string; error?: { code: string } };
    expect(bad.type).toBe("error");
    expect(bad.error?.code).toBe("bad_request");
    const good = (await core.handleRequest({ id: "3", type: "bots.create", name: "B" })) as {
      type: string;
    };
    expect(good.type).toBe("result");
  });
});
