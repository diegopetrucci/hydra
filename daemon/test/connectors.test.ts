/**
 * connectors.test.ts
 *
 * Offline tests for the MCP connector store, ConnectorManager and the
 * connectors.* protocol commands. The MCP server is a fake on pi-mcp's in-memory
 * transport; OAuth discovery/registration/token calls go to a fake fetch.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, stat, readFile, writeFile, chmod, readdir } from "node:fs/promises";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { McpHttpError, McpSessionExpiredError } from "@earendil-works/pi-mcp";
import type { AuthProvider, JsonRpcMessage, McpFetch, McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { FileConnectorStore } from "../src/connector-store.js";
import { ConnectorError, ConnectorManager } from "../src/connectors.js";
import type { ConnectorDef, ConnectorDeps } from "../src/connectors.js";
import { DaemonCore } from "../src/daemon-core.js";
import { createTestModels } from "../src/models.js";
import { createShutdown } from "../src/shutdown.js";
import type { ProtocolEvent } from "../src/protocol.js";

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    // setImmediate, so polling keeps working while setTimeout is faked.
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** Let pending microtask/I-O chains (in-memory transport, file writes) finish. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// ─── Fakes ────────────────────────────────────────────────────────────────────

const AS = "https://auth.test";
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Fake OAuth endpoints. `tokenError` makes the token endpoint refuse. */
function fakeFetch(opts: { tokenError?: string } = {}): McpFetch {
  return async (input) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : (input as Request).url);
    if (url.pathname.includes("oauth-protected-resource")) {
      return json({ resource: url.origin + url.pathname.replace("/.well-known/oauth-protected-resource", ""), authorization_servers: [AS] });
    }
    if (url.pathname.includes("oauth-authorization-server")) {
      return json({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        registration_endpoint: `${AS}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.href === `${AS}/register`) {
      return json({ client_id: "cid", redirect_uris: ["http://127.0.0.1:47619/callback"] }, 201);
    }
    if (url.href === `${AS}/token`) {
      return opts.tokenError
        ? json({ error: opts.tokenError }, 400)
        : json({ access_token: "new", token_type: "Bearer", refresh_token: "r2", expires_in: 3600 });
    }
    return new Response("nf", { status: 404 });
  };
}

class FakeServer {
  tools = [{ name: "ping", description: "ping", inputSchema: { type: "object" as const } }];
  calls: string[] = [];
  /** When set, tools/call is counted (the mutation happens) but the response is dropped. */
  dropResponses = false;
  private reply: ((m: JsonRpcMessage) => void) | undefined;

  attach(server: McpTransport): void {
    this.reply = (m) => void server.send(m);
    server.onMessage((m) => {
      const msg = m as { id?: number; method?: string; params?: { name?: string } };
      if (msg.id === undefined || !msg.method) return;
      const respond = (result: unknown): void => this.reply?.({ jsonrpc: "2.0", id: msg.id!, result } as JsonRpcMessage);
      if (msg.method === "initialize") {
        respond({
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fake", version: "1" },
        });
      } else if (msg.method === "tools/list") {
        respond({ tools: this.tools });
      } else if (msg.method === "tools/call") {
        this.calls.push(msg.params?.name ?? "");
        if (this.dropResponses) return;
        respond({ content: [{ type: "text", text: "pong" }] });
      } else respond({});
    });
    void server.start();
  }

  notifyToolsChanged(): void {
    this.reply?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" } as JsonRpcMessage);
  }
}

/** Client transport wrapper that can fail the next tools/call sends. */
class FlakyTransport implements McpTransport {
  constructor(
    private readonly inner: McpTransport,
    private readonly failures: Error[],
  ) {}
  start = () => this.inner.start();
  close = () => this.inner.close();
  onMessage = (l: Parameters<McpTransport["onMessage"]>[0]) => this.inner.onMessage(l);
  onError = (l: Parameters<McpTransport["onError"]>[0]) => this.inner.onError(l);
  onClose = (l: Parameters<McpTransport["onClose"]>[0]) => this.inner.onClose(l);
  async send(message: JsonRpcMessage, options?: Parameters<McpTransport["send"]>[1]): Promise<void> {
    if ((message as { method?: string }).method === "tools/call" && this.failures.length > 0) {
      throw this.failures.shift();
    }
    return this.inner.send(message, options);
  }
}

interface Harnessed {
  dir: string;
  store: FileConnectorStore;
  manager: ConnectorManager;
  events: ProtocolEvent[];
  server: FakeServer;
  failures: Error[];
  transports: number;
  /** While set, transports fail to start like an offline network. */
  offline: boolean;
  /** Number of upcoming transport starts that fail like an offline network. */
  failStarts: number;
  /** While set, transport start waits for it. */
  startGate: Promise<void> | undefined;
  /** While set, the fake token exchange waits for it. */
  exchangeGate: Promise<void> | undefined;
  callbackPending: { resolve: (cb: { code: string; state: string; iss: string }) => void } | undefined;
}

function updates(h: Harnessed, id = "sentry"): string[] {
  return h.events
    .filter((e) => e.type === "event" && e.event === "connector.updated" && e.connector.id === id)
    .map((e) => (e as { connector: { status: string } }).connector.status);
}

describe("connectors", () => {
  let h: Harnessed;
  let fetchImpl: McpFetch;

  async function build(extra: Partial<ConnectorDeps> = {}): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "hydra-conn-test-"));
    const store = new FileConnectorStore(dir);
    const events: ProtocolEvent[] = [];
    const server = new FakeServer();
    const failures: Error[] = [];
    const state = {
      dir, store, events, server, failures, transports: 0,
      offline: false, failStarts: 0, startGate: undefined, exchangeGate: undefined,
      callbackPending: undefined as Harnessed["callbackPending"],
    } as Harnessed;
    const createTransport = (_def: ConnectorDef, auth: AuthProvider): McpTransport => {
      state.transports++;
      const { client, server: serverSide } = createInMemoryTransportPair();
      server.attach(serverSide);
      const flaky = new FlakyTransport(client, failures);
      const origStart = flaky.start;
      // Like the HTTP transport: without a token the server answers 401, so ask the
      // auth provider to recover (refresh, or start authorization).
      flaky.start = async () => {
        await state.startGate;
        if (state.offline) throw new TypeError("fetch failed");
        if (state.failStarts > 0) {
          state.failStarts--;
          throw new TypeError("fetch failed");
        }
        if ((await auth.token()) === undefined || tokenRejected) {
          await auth.onUnauthorized?.({
            response: new Response(null, { status: 401 }),
            serverUrl: new URL(_def.url),
            fetch: fetchImpl,
          });
        }
        return origStart();
      };
      return flaky;
    };
    const manager = new ConnectorManager(store, (e) => events.push(e), {
      createTransport,
      authorize: async (provider, o) => {
        // Stand-in for the token exchange; stores tokens like the real flow.
        void o;
        await state.exchangeGate;
        await provider.saveTokens({ access_token: "tok", token_type: "Bearer", refresh_token: "ref", expires_in: 3600 });
      },
      listenCallback: async () => ({
        waitForCallback: (state_) =>
          new Promise((resolve) => {
            state.callbackPending = { resolve: (cb) => resolve({ ...cb, state: state_ }) };
          }),
        close: async () => {},
      }),
      signInTimeoutMs: 5_000,
      retryDelayMs: 1,
      ...extra,
    });
    state.manager = manager;
    h = state;
  }

  let tokenRejected = false;

  beforeEach(() => {
    tokenRejected = false;
    fetchImpl = fakeFetch();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await h.manager.close();
    await h.manager.settled();
    await rm(h.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function seedSignedIn(): Promise<void> {
    await h.store.forConnector("sentry").save({
      serverUrl: "https://mcp.sentry.dev/mcp",
      clientInformation: { client_id: "cid" },
      tokens: { access_token: "old", token_type: "Bearer", refresh_token: "ref" },
    });
  }

  function internals(): { client: unknown; opening: unknown } {
    return (h.manager as unknown as { entries: Map<string, { client: unknown; opening: unknown }> }).entries.get("sentry")!;
  }

  // ─── Store ────────────────────────────────────────────────────────────────

  it("store: round-trips per connector, is mode 0600 and deletes", async () => {
    await build();
    const a = h.store.forConnector("sentry");
    const b = h.store.forConnector("notion");
    await a.save({ serverUrl: "https://a", tokens: { access_token: "t1", token_type: "Bearer" } });
    await b.save({ serverUrl: "https://b" });
    expect((await a.load())?.serverUrl).toBe("https://a");
    expect(((await stat(h.store.path)).mode & 0o777).toString(8)).toBe("600");
    expect(await h.store.signedInIds()).toEqual(["sentry"]);
    await h.store.delete("sentry");
    expect(await a.load()).toBeUndefined();
    expect((await b.load())?.serverUrl).toBe("https://b");
    expect(((await stat(h.store.path)).mode & 0o777).toString(8)).toBe("600");
  });

  it("store: restricts an existing 0644 file before reading it", async () => {
    await build();
    await writeFile(
      h.store.path,
      JSON.stringify({ connectors: { sentry: { serverUrl: "https://a", tokens: { access_token: "t", token_type: "Bearer" } } } }),
    );
    await chmod(h.store.path, 0o644);
    expect((await h.store.forConnector("sentry").load())?.serverUrl).toBe("https://a");
    expect(((await stat(h.store.path)).mode & 0o777).toString(8)).toBe("600");
  });

  it("store: a corrupt 0644 file is quarantined with mode 0600", async () => {
    await build();
    await writeFile(h.store.path, "{not json");
    await chmod(h.store.path, 0o644);
    expect(await h.store.forConnector("sentry").load()).toBeUndefined();
    const quarantined = (await readdir(h.dir)).filter((f) => f.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(((await stat(join(h.dir, quarantined[0]!))).mode & 0o777).toString(8)).toBe("600");
  });

  it("store: writes from a superseded owner are dropped", async () => {
    await build();
    let current = true;
    const s = h.store.forConnector("sentry", () => current);
    await s.save({ serverUrl: "https://a" });
    current = false;
    await s.save({ serverUrl: "https://b" });
    expect((await s.load())?.serverUrl).toBe("https://a");
  });

  // ─── Status transitions ───────────────────────────────────────────────────

  it("lists the two fixed connectors as signed_out", async () => {
    await build();
    expect(h.manager.list()).toEqual([
      { id: "sentry", name: "Sentry", status: "signed_out" },
      { id: "notion", name: "Notion", status: "signed_out" },
      { id: "swarmia", name: "Swarmia", status: "signed_out" },
      { id: "amplitude", name: "Amplitude", status: "signed_out" },
    ]);
  });

  it("start() reconnects stored connectors in the background", async () => {
    await build();
    await seedSignedIn();
    await h.manager.start();
    expect(h.manager.list()[0]?.status).toBe("connecting");
    await h.manager.settled();
    expect(updates(h)).toEqual(["connecting", "connected"]);
    expect(h.manager.listTools("sentry").map((t) => t.name)).toEqual(["ping"]);
    expect(h.manager.list()[1]?.status).toBe("signed_out");
  });

  it("sign-in: emits the URL, waits for the callback, then connects", async () => {
    await build();
    await h.manager.signIn("sentry");
    await waitFor(() => h.callbackPending !== undefined);
    const urlEvent = h.events.find((e) => e.type === "event" && e.event === "connector.signInUrl");
    expect(urlEvent).toMatchObject({ connectorId: "sentry" });
    expect((urlEvent as { url: string }).url).toContain(`${AS}/authorize`);
    expect((urlEvent as { url: string }).url).toContain("code_challenge=");
    h.callbackPending!.resolve({ code: "c", state: "", iss: "" });
    await h.manager.settled();
    expect(updates(h)).toEqual(["connecting", "connected"]);
    expect(h.manager.list()[0]?.status).toBe("connected");
    const saved = JSON.parse(await readFile(h.store.path, "utf-8"));
    expect(saved.connectors.sentry.clientInformation.client_id).toBe("cid");
    expect(((await stat(h.store.path)).mode & 0o777).toString(8)).toBe("600");
  });

  it("only one sign-in at a time", async () => {
    await build();
    await h.manager.signIn("sentry");
    await expect(h.manager.signIn("notion")).rejects.toMatchObject({ code: "sign_in_busy" });
  });

  it("a sign-in with no callback times out to signed_out with an error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await build({ signInTimeoutMs: 5_000 });
    await h.manager.signIn("sentry");
    await waitFor(() => h.callbackPending !== undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    await h.manager.settled();
    const sentry = h.manager.list()[0];
    expect(sentry?.status).toBe("signed_out");
    expect(sentry?.error).toMatch(/timed out/);
    // The slot is free again.
    await h.manager.signIn("notion");
  });

  it("a refused refresh moves the connector to needs_sign_in without looping", async () => {
    await build();
    fetchImpl = fakeFetch({ tokenError: "invalid_grant" });
    tokenRejected = true;
    await seedSignedIn();
    await h.manager.start();
    await h.manager.settled();
    expect(updates(h)).toEqual(["connecting", "needs_sign_in"]);
    expect(h.transports).toBe(1);
    // Tokens were discarded by pi-mcp: a restart no longer reconnects.
    expect(await h.store.signedInIds()).toEqual([]);
  });

  it("signOut deletes stored state and closes the client", async () => {
    await build();
    await seedSignedIn();
    await h.manager.start();
    await h.manager.settled();
    await h.manager.signOut("sentry");
    expect(h.manager.list()[0]).toEqual({ id: "sentry", name: "Sentry", status: "signed_out" });
    expect(await h.store.signedInIds()).toEqual([]);
    expect(() => h.manager.listTools("sentry")).toThrow(/not connected/);
  });

  // ─── Late work after cancel / timeout / sign-out ──────────────────────────

  it("sign-out while the token exchange is pending: no tokens are written afterwards", async () => {
    await build();
    const gate = deferred();
    h.exchangeGate = gate.promise;
    await h.manager.signIn("sentry");
    await waitFor(() => h.callbackPending !== undefined);
    h.callbackPending!.resolve({ code: "c", state: "", iss: "" });
    await waitFor(() => h.events.some((e) => e.type === "event" && e.event === "connector.signInUrl"));
    // The exchange is now blocked on the gate.
    await new Promise((r) => setImmediate(r));
    await h.manager.signOut("sentry");
    await h.manager.settled();
    gate.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(await h.store.signedInIds()).toEqual([]);
    const file = await readFile(h.store.path, "utf-8").catch(() => "{}");
    expect(file).not.toContain("tok");
    expect(h.manager.list()[0]?.status).toBe("signed_out");
    expect(internals().client).toBeUndefined();
  });

  it("timeout while the client is still opening: no client is left installed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await build({ signInTimeoutMs: 5_000 });
    await seedSignedIn(); // the open will succeed once released
    const gate = deferred();
    h.startGate = gate.promise;
    await h.manager.signIn("sentry");
    await waitFor(() => h.transports === 1);
    await vi.advanceTimersByTimeAsync(5_000);
    await h.manager.settled();
    expect(h.manager.list()[0]).toMatchObject({ status: "signed_out", error: expect.stringMatching(/timed out/) });
    gate.resolve();
    await flush();
    expect(internals().client).toBeUndefined();
    expect(h.manager.list()[0]?.status).toBe("signed_out");
  });

  it("sign-out while a background connect is opening: the late client is closed", async () => {
    await build();
    await seedSignedIn();
    const gate = deferred();
    h.startGate = gate.promise;
    await h.manager.start();
    await waitFor(() => h.transports === 1);
    await h.manager.signOut("sentry");
    gate.resolve();
    await h.manager.settled();
    await flush();
    expect(internals().client).toBeUndefined();
    expect(h.manager.list()[0]?.status).toBe("signed_out");
  });

  it("signIn: shutdown or sign-out while the callback server starts closes the handle", async () => {
    for (const action of ["close", "signOut"] as const) {
      const listening = deferred<{ waitForCallback: () => Promise<never>; close: () => Promise<void> }>();
      await build({ listenCallback: () => listening.promise });
      let closed = 0;
      const pending = h.manager.signIn("sentry");
      const rejected = expect(pending).rejects.toBeInstanceOf(ConnectorError);
      if (action === "close") await h.manager.close();
      else await h.manager.signOut("sentry");
      listening.resolve({ waitForCallback: () => new Promise<never>(() => {}), close: async () => void closed++ });
      await rejected;
      expect(closed).toBe(1);
      expect(h.manager.list()[0]?.status).toBe("signed_out");
      await h.manager.close();
      await h.manager.settled();
      await rm(h.dir, { recursive: true, force: true });
    }
    await build();
    await h.manager.close();
    await expect(h.manager.signIn("sentry")).rejects.toBeInstanceOf(ConnectorError);
  });

  // ─── Reconnect with backoff ───────────────────────────────────────────────

  it("an offline start stays in error, retries with doubling backoff and recovers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await build({ reconnectBaseMs: 5_000, reconnectMaxMs: 15_000 });
    await seedSignedIn();
    h.offline = true;
    await h.manager.start();
    await h.manager.settled();
    expect(h.manager.list()[0]).toMatchObject({ status: "error", error: expect.stringContaining("Could not connect") });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.transports).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // first retry at 5s, still offline
    await waitFor(() => h.transports === 2 && vi.getTimerCount() === 1);
    expect(h.manager.list()[0]?.status).toBe("error");

    await vi.advanceTimersByTimeAsync(9_999); // next retry is 10s later
    expect(h.transports).toBe(2);
    h.offline = false;
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => h.manager.list()[0]?.status === "connected");
    expect(h.manager.list()[0]?.error).toBeUndefined();
    expect(h.manager.listTools("sentry").map((t) => t.name)).toEqual(["ping"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconnect backoff is capped, and stops on sign-out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await build({ reconnectBaseMs: 5_000, reconnectMaxMs: 12_000 });
    await seedSignedIn();
    h.offline = true;
    await h.manager.start();
    await h.manager.settled();
    await vi.advanceTimersByTimeAsync(5_000); // 2nd attempt, next delay 10s
    await waitFor(() => h.transports === 2 && vi.getTimerCount() === 1);
    await vi.advanceTimersByTimeAsync(10_000); // 3rd attempt, next delay capped at 12s
    await waitFor(() => h.transports === 3 && vi.getTimerCount() === 1);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(h.transports).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => h.transports === 4 && vi.getTimerCount() === 1);
    await h.manager.signOut("sentry");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.transports).toBe(4);
  });

  // ─── Tools ────────────────────────────────────────────────────────────────

  it("callTool works and refreshes the tool list on tools/list_changed", async () => {
    await build();
    await seedSignedIn();
    await h.manager.start();
    await h.manager.settled();
    const res = await h.manager.callTool("sentry", "ping", {});
    expect(res.content[0]).toMatchObject({ type: "text", text: "pong" });
    h.server.tools = [...h.server.tools, { name: "pong", description: "p", inputSchema: { type: "object" as const } }];
    h.server.notifyToolsChanged();
    await waitFor(() => h.manager.listTools("sentry").length === 2);
  });

  it("callTool rebuilds the client once on session expiry", async () => {
    await build();
    await seedSignedIn();
    await h.manager.start();
    await h.manager.settled();
    h.failures.push(new McpSessionExpiredError());
    const before = h.transports;
    const res = await h.manager.callTool("sentry", "ping", {});
    expect(res.content[0]).toMatchObject({ text: "pong" });
    expect(h.transports).toBe(before + 1);
  });

  it("callTool retries transient failures while opening the client, but gives up on a persistent one", async () => {
    await build();
    await seedSignedIn();
    await h.manager.start();
    await h.manager.settled();
    const entries = (h.manager as unknown as { entries: Map<string, { client?: { close(): Promise<void> } }> }).entries;
    await entries.get("sentry")!.client!.close();
    h.failStarts = 2;
    let before = h.transports;
    await expect(h.manager.callTool("sentry", "ping", {})).resolves.toBeDefined();
    expect(h.transports - before).toBe(3); // 2 failed opens + 1 good
    await entries.get("sentry")!.client!.close();
    h.offline = true;
    before = h.transports;
    await expect(h.manager.callTool("sentry", "ping", {})).rejects.toBeInstanceOf(TypeError);
    expect(h.transports - before).toBe(3);
  });

  it("never replays a call that was sent: the server sees exactly one", async () => {
    await build();
    await seedSignedIn();
    await h.manager.start();
    await h.manager.settled();
    h.server.dropResponses = true;
    const call = h.manager.callTool("sentry", "ping", {});
    const outcome = call.then(() => "resolved", (e: unknown) => e);
    await waitFor(() => h.server.calls.length === 1);
    // The connection drops after the mutation ran but before the response arrived.
    await (h.manager as unknown as { entries: Map<string, { client?: { close(): Promise<void> } }> })
      .entries.get("sentry")!.client!.close();
    expect(await outcome).not.toBe("resolved");
    await flush();
    expect(h.server.calls).toEqual(["ping"]);
  });

  it("retries a sent call after HTTP 429 (not run) but not after 503", async () => {
    await build();
    await seedSignedIn();
    await h.manager.start();
    await h.manager.settled();
    h.failures.push(new McpHttpError(429, "slow down"));
    await expect(h.manager.callTool("sentry", "ping", {})).resolves.toBeDefined();
    h.failures.push(new McpHttpError(503, "unavailable"));
    await expect(h.manager.callTool("sentry", "ping", {})).rejects.toBeInstanceOf(McpHttpError);
  });

  it("does not replay a sent call after a transport failure on send", async () => {
    await build();
    await seedSignedIn();
    await h.manager.start();
    await h.manager.settled();
    h.failures.push(new TypeError("fetch failed"));
    await expect(h.manager.callTool("sentry", "ping", {})).rejects.toBeInstanceOf(TypeError);
    expect(h.failures.length).toBe(0);
  });

  it("signOut while a call sleeps between retries: no second attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await build({ retryDelayMs: 1000 });
    await seedSignedIn();
    await h.manager.start();
    await h.manager.settled();
    const before = h.transports;
    h.offline = true; // reopening fails with a transient TypeError, then sleeps
    await (h.manager as unknown as { entries: Map<string, { client?: { close(): Promise<void> } }> })
      .entries.get("sentry")!.client!.close();
    const call = h.manager.callTool("sentry", "ping", {});
    const outcome = call.then(() => "resolved", (e: unknown) => e);
    await waitFor(() => h.transports === before + 1);
    await flush();
    h.offline = false;
    await h.manager.signOut("sentry");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toBeInstanceOf(ConnectorError);
    expect(h.transports).toBe(before + 1);
    expect(h.server.calls).toEqual([]);
  });

  it("a call started during sign-out cleanup is rejected and installs no client", async () => {
    await build();
    await seedSignedIn();
    await h.manager.start();
    await h.manager.settled();
    const gate = deferred();
    const origDelete = h.store.delete.bind(h.store);
    h.store.delete = async (id: string) => {
      await gate.promise;
      return origDelete(id);
    };
    const before = h.transports;
    const out = h.manager.signOut("sentry");
    // Cleanup is still pending, yet the connector is already fenced.
    expect(() => h.manager.listTools("sentry")).toThrow(ConnectorError);
    await expect(h.manager.callTool("sentry", "ping", {})).rejects.toMatchObject({ code: "not_connected" });
    gate.resolve();
    await out;
    expect(h.transports).toBe(before);
    expect((h.manager as unknown as { entries: Map<string, { client?: unknown }> }).entries.get("sentry")!.client).toBeUndefined();
  });

  it("a sign-in started during sign-out cleanup waits for it; new tokens and client survive", async () => {
    await build();
    await seedSignedIn();
    await h.manager.start();
    await h.manager.settled();
    const gate = deferred();
    const origDelete = h.store.delete.bind(h.store);
    h.store.delete = async (id: string) => {
      await gate.promise;
      return origDelete(id);
    };
    const out = h.manager.signOut("sentry");
    await flush();
    const signIn = h.manager.signIn("sentry");
    await flush();
    // Without the fix the sign-in is already under way here and finishes before the delete.
    h.callbackPending?.resolve({ code: "c", state: "", iss: "" });
    await flush();
    gate.resolve();
    await out;
    await signIn;
    await waitFor(() => h.callbackPending !== undefined);
    h.callbackPending!.resolve({ code: "c", state: "", iss: "" });
    await h.manager.settled();
    expect(h.manager.list()[0]?.status).toBe("connected");
    const saved = JSON.parse(await readFile(h.store.path, "utf-8"));
    expect(saved.connectors.sentry.tokens.access_token).toBe("tok");
    expect(h.manager.listTools("sentry").map((t) => t.name)).toEqual(["ping"]);
    const entry = (h.manager as unknown as { entries: Map<string, { client?: { connectionState: string } }> }).entries.get("sentry")!;
    expect(entry.client?.connectionState).toBe("connected");
  });

  // ─── Protocol ─────────────────────────────────────────────────────────────

  describe("protocol", () => {
    async function makeCore(): Promise<DaemonCore> {
      const { models } = await createTestModels();
      const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
      const core = new DaemonCore(
        harness, models, (e) => h.events.push(e), BACKGROUND_CONTEXT,
        undefined, undefined, [], undefined, false, h.manager,
      );
      await core.start();
      return core;
    }

    it("connectors.list, signIn errors and signOut", async () => {
      await build();
      await seedSignedIn();
      const core = await makeCore();
      await h.manager.settled();

      const list = await core.handleRequest({ id: "1", type: "connectors.list" });
      expect(list).toEqual({
        id: "1",
        type: "result",
        result: [
          { id: "sentry", name: "Sentry", status: "connected" },
          { id: "notion", name: "Notion", status: "signed_out" },
          { id: "swarmia", name: "Swarmia", status: "signed_out" },
          { id: "amplitude", name: "Amplitude", status: "signed_out" },
        ],
      });

      expect(await core.handleRequest({ id: "2", type: "connectors.signIn" })).toMatchObject({ type: "error", error: { code: "bad_request" } });
      expect(await core.handleRequest({ id: "3", type: "connectors.signIn", connectorId: "figma" })).toMatchObject({ error: { code: "unknown_connector" } });

      expect(await core.handleRequest({ id: "4", type: "connectors.signOut", connectorId: "sentry" })).toEqual({
        id: "4", type: "result", result: { signedOut: true },
      });
      expect(h.manager.list()[0]?.status).toBe("signed_out");
      expect(await h.store.signedInIds()).toEqual([]);
    });

    it("connectors.signIn accepts, then reports a busy sign-in", async () => {
      await build();
      const core = await makeCore();
      expect(await core.handleRequest({ id: "1", type: "connectors.signIn", connectorId: "sentry" })).toEqual({
        id: "1", type: "result", result: { accepted: true },
      });
      expect(await core.handleRequest({ id: "2", type: "connectors.signIn", connectorId: "notion" })).toMatchObject({
        error: { code: "sign_in_busy" },
      });
    });

    it("reports a busy callback port", async () => {
      await build({
        listenCallback: async () => {
          throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
        },
      });
      const core = await makeCore();
      const res = await core.handleRequest({ id: "1", type: "connectors.signIn", connectorId: "sentry" });
      expect(res).toMatchObject({ error: { code: "port_busy" } });
      expect(h.manager.list()[0]?.status).toBe("signed_out");
    });

    it("without a manager the commands report unavailable", async () => {
      const { models } = await createTestModels();
      const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
      const core = new DaemonCore(harness, models, () => {}, BACKGROUND_CONTEXT);
      expect(await core.handleRequest({ id: "1", type: "connectors.list" })).toMatchObject({ error: { code: "unavailable" } });
    });
  });

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  it("shutdown closes connectors before the core", async () => {
    const order: string[] = [];
    await createShutdown({
      writeStderr: () => {},
      inFlight: () => [],
      closeConnectors: async () => void order.push("connectors"),
      closeCore: async () => void order.push("core"),
      closeHarness: async () => void order.push("harness"),
      setExitCode: () => {},
      forceExit: () => {},
    })(0, "bye\n");
    expect(order).toEqual(["connectors", "core", "harness"]);
  });
});
