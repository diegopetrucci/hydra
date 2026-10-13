/**
 * connectors.ts
 *
 * MCP connectors (Sentry, Notion, Swarmia, Amplitude) on @earendil-works/pi-mcp. Connectors belong
 * to the account: every bot may use every connected connector.
 *
 * The daemon never opens the browser; it emits connector.signInUrl so the app
 * can. OAuth state lives in connectors.json (see connector-store.ts). Tokens are
 * never logged or emitted; error text shown to the app is class-based, never a
 * raw upstream message.
 *
 * Token renewal is pi-mcp's: on a 401 the transport refreshes through the stored
 * refresh token and retries. A refused refresh surfaces as an auth error, which
 * moves the connector to needs_sign_in (no retry loop).
 */

import {
  McpClient,
  McpConnectionClosedError,
  McpAuthRequiredError,
  McpHttpError,
  McpSessionExpiredError,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import type { AuthProvider, CallToolResult, McpTransport, Tool } from "@earendil-works/pi-mcp";
import {
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  OAuthError,
  adaptOAuthProvider,
  authorizeMcp,
} from "@earendil-works/pi-mcp/oauth";
import type { OAuthCallback } from "@earendil-works/pi-mcp/oauth";
import { FileConnectorStore } from "./connector-store.js";
import { describeError } from "./describe-error.js";
import { DAEMON_VERSION } from "./protocol.js";
import type { ConnectorInfo, ConnectorStatus, ProtocolEvent } from "./protocol.js";

export interface ConnectorDef {
  id: string;
  name: string;
  url: string;
}

/** The fixed connector list. No custom URLs. */
export const CONNECTORS: readonly ConnectorDef[] = [
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp" },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp" },
  { id: "swarmia", name: "Swarmia", url: "https://app.swarmia.com/api/v1/mcp" },
  // US data region (Diego, 13 Oct 2026: the user's Amplitude data is on app.amplitude.com). pi-mcp requests
  // only `mcp:read mcp:write` here (no offline_access), so a refresh token is unconfirmed until
  // the first real sign-in.
  { id: "amplitude", name: "Amplitude", url: "https://mcp.amplitude.com/mcp" },
];

/** Fixed loopback port: the dynamic client registration is tied to this redirect URL. */
export const CALLBACK_PORT = 47619;
export const REDIRECT_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Error with a protocol code and a message that is safe to show to the app. */
export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

interface CallbackHandle {
  waitForCallback(state: string): Promise<OAuthCallback>;
  close(): Promise<void>;
}

export interface ConnectorDeps {
  createTransport: (def: ConnectorDef, auth: AuthProvider) => McpTransport;
  authorize: (
    provider: McpOAuthProvider,
    options: { serverUrl: string; authorizationCode: string; iss?: string; signal?: AbortSignal },
  ) => Promise<unknown>;
  listenCallback: (timeoutMs: number) => Promise<CallbackHandle>;
  signInTimeoutMs: number;
  retryDelayMs: number;
  /** Background reconnect backoff after a non-auth failure: base, doubling, capped. */
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

const defaultDeps: ConnectorDeps = {
  createTransport: (def, auth) => new StreamableHttpTransport({ url: def.url, authProvider: auth }),
  authorize: (provider, options) => authorizeMcp(provider, options),
  listenCallback: (timeoutMs) =>
    OAuthCallbackServer.listen({ port: CALLBACK_PORT, host: "127.0.0.1", timeoutMs }),
  signInTimeoutMs: SIGN_IN_TIMEOUT_MS,
  retryDelayMs: 500,
  reconnectBaseMs: 5_000,
  reconnectMaxMs: 5 * 60_000,
};

interface Entry {
  def: ConnectorDef;
  status: ConnectorStatus;
  error?: string;
  /** Provider for the current generation; its OAuth state writes are dropped once superseded. */
  provider: McpOAuthProvider;
  /** Receives the authorization URL pi-mcp wants opened; set only during a sign-in. */
  redirectSink: ((url: URL) => void) | undefined;
  client: McpClient | undefined;
  opening: Promise<McpClient> | undefined;
  tools: Tool[];
  /** Bumped by signIn / signOut / close / sign-in failure to supersede in-flight work. */
  gen: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retryAttempt: number;
  /** Pending sign-out cleanup (client close, store delete); sign-in waits for it. */
  signOutCleanup: Promise<void> | undefined;
}

interface ActiveSignIn {
  connectorId: string;
  abort: (reason: "cancelled") => void;
}

class SignInStopped extends Error {
  constructor(readonly reason: "timeout" | "cancelled") {
    super(reason);
  }
}

/** Work finished after its generation was superseded; its result was discarded. */
class Superseded extends ConnectorError {
  constructor() {
    super("superseded", "The connector changed while the operation was running.");
  }
}

function isAuthFailure(e: unknown): boolean {
  return (
    e instanceof McpOAuthAuthorizationRequiredError || e instanceof OAuthError || e instanceof McpAuthRequiredError
  );
}

function isTransient(e: unknown): boolean {
  if (e instanceof McpHttpError) return [429, 502, 503, 504].includes(e.status);
  return e instanceof TypeError || e instanceof McpConnectionClosedError;
}

export class ConnectorManager {
  private readonly entries = new Map<string, Entry>();
  private readonly deps: ConnectorDeps;
  private activeSignIn: ActiveSignIn | undefined;
  private signInStarting = false;
  private readonly background = new Set<Promise<void>>();
  private closed = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: FileConnectorStore,
    private readonly emit: (event: ProtocolEvent) => void,
    deps: Partial<ConnectorDeps> = {},
  ) {
    this.deps = { ...defaultDeps, ...deps };
    for (const def of CONNECTORS) {
      const entry: Entry = {
        def,
        status: "signed_out",
        provider: undefined as unknown as McpOAuthProvider,
        redirectSink: undefined,
        client: undefined,
        opening: undefined,
        tools: [],
        gen: 0,
        retryTimer: undefined,
        retryAttempt: 0,
        signOutCleanup: undefined,
      };
      entry.provider = this.makeProvider(entry);
      this.entries.set(def.id, entry);
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Connect every stored connector in the background; returns once they are scheduled. */
  async start(): Promise<void> {
    for (const id of await this.store.signedInIds()) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      this.setStatus(entry, "connecting");
      this.track(this.connectInBackground(entry));
    }
  }

  /** Resolves when background connects scheduled so far have settled (tests). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.background]);
  }

  /**
   * Call `listener` after any connector status change or tool-list change
   * (read the new state with list() / listTools()). Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyChange(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (e) {
        process.stderr.write(`[hydra-daemon] connector change listener failed: ${describeError(e)}\n`);
      }
    }
  }

  list(): ConnectorInfo[] {
    return [...this.entries.values()].map((e) => this.info(e));
  }

  /**
   * Start a sign-in. Resolves once the flow is under way (the callback server is
   * listening); the outcome arrives as connector.signInUrl / connector.updated.
   */
  async signIn(connectorId: string): Promise<void> {
    const entry = this.require(connectorId);
    // A sign-out still deleting credentials must finish first, or it would delete the new ones.
    if (entry.signOutCleanup) await entry.signOutCleanup.catch(() => {});
    if (this.closed) throw new ConnectorError("sign_in_failed", "Connectors are shutting down.");
    if (this.activeSignIn || this.signInStarting) {
      throw new ConnectorError("sign_in_busy", "Another connector sign-in is already in progress.");
    }
    this.signInStarting = true;
    const gen = entry.gen;
    let callback: CallbackHandle;
    try {
      callback = await this.deps.listenCallback(this.deps.signInTimeoutMs + 1_000);
    } catch (e) {
      const busy = (e as { code?: unknown })?.code === "EADDRINUSE";
      throw new ConnectorError(
        busy ? "port_busy" : "sign_in_failed",
        busy
          ? `Port ${CALLBACK_PORT} is in use, so sign-in cannot start. Close whatever uses it and try again.`
          : "Could not start the sign-in callback server.",
      );
    } finally {
      this.signInStarting = false;
    }
    // Shutdown or sign-out may have happened while the callback server started.
    if (this.closed || gen !== entry.gen) {
      await callback.close().catch(() => {});
      throw new ConnectorError("sign_in_failed", "Sign-in was cancelled.");
    }
    this.track(this.runSignIn(entry, callback));
  }

  async signOut(connectorId: string): Promise<void> {
    const entry = this.require(connectorId);
    // Supersede first so late work from the old generation cannot write state back.
    this.bump(entry);
    // Fence at once (before any await): tools are uninstalled and callTool rejects new calls.
    entry.tools = [];
    this.setStatus(entry, "signed_out");
    if (this.activeSignIn?.connectorId === connectorId) this.activeSignIn.abort("cancelled");
    const cleanup = (async () => {
      await this.dropClient(entry);
      await this.store.delete(connectorId);
    })();
    entry.signOutCleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (entry.signOutCleanup === cleanup) entry.signOutCleanup = undefined;
    }
  }

  /** Tools of a connected connector (cached; refreshed on tools/list_changed). */
  listTools(connectorId: string): Tool[] {
    const entry = this.require(connectorId);
    if (entry.status !== "connected") {
      throw new ConnectorError("not_connected", `${entry.def.name} is not connected.`);
    }
    return [...entry.tools];
  }

  async callTool(
    connectorId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const entry = this.require(connectorId);
    if (entry.status !== "connected") {
      throw new ConnectorError("not_connected", `${entry.def.name} is not connected.`);
    }
    return this.withClient(entry, signal, (client) => client.callTool(name, args, { signal }));
  }

  /** Abort any sign-in and close every client (shared shutdown routine). */
  async close(): Promise<void> {
    this.closed = true;
    this.activeSignIn?.abort("cancelled");
    for (const entry of this.entries.values()) {
      this.bump(entry);
      await this.dropClient(entry);
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private require(id: unknown): Entry {
    const entry = typeof id === "string" ? this.entries.get(id) : undefined;
    if (!entry) throw new ConnectorError("unknown_connector", "Unknown connector.");
    return entry;
  }

  private track(p: Promise<void>): void {
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  private info(e: Entry): ConnectorInfo {
    return { id: e.def.id, name: e.def.name, status: e.status, ...(e.error ? { error: e.error } : {}) };
  }

  private setStatus(entry: Entry, status: ConnectorStatus, error?: string): void {
    entry.status = status;
    entry.error = error;
    this.emit({ type: "event", event: "connector.updated", connector: this.info(entry) });
    this.notifyChange();
  }

  /** A provider whose state writes and redirects are only honoured while its generation is current. */
  private makeProvider(entry: Entry): McpOAuthProvider {
    const gen = entry.gen;
    const current = (): boolean => gen === entry.gen;
    return new McpOAuthProvider({
      serverUrl: entry.def.url,
      redirectUrl: REDIRECT_URL,
      clientMetadata: {
        client_name: "Hydra",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      store: this.store.forConnector(entry.def.id, current),
      onRedirect: (url) => {
        if (current()) entry.redirectSink?.(url);
      },
    });
  }

  /** Supersede everything in flight for this connector: new generation and provider, no pending reconnect. */
  private bump(entry: Entry): void {
    entry.gen++;
    entry.provider = this.makeProvider(entry);
    entry.opening = undefined;
    entry.retryAttempt = 0;
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
  }

  /** Open a client and list its tools. Throws on any failure; a failed client is closed. */
  private async openClient(entry: Entry): Promise<{ client: McpClient; tools: Tool[] }> {
    const client = new McpClient({ name: "Hydra", version: DAEMON_VERSION });
    const transport = this.deps.createTransport(entry.def, adaptOAuthProvider(entry.provider));
    let tools: Tool[];
    try {
      await client.connect(transport);
      tools = await client.listTools();
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
    client.onNotification("notifications/tools/list_changed", () => {
      void client
        .listTools()
        .then((fresh) => {
          if (entry.client !== client) return;
          entry.tools = fresh;
          this.notifyChange();
        })
        .catch((e: unknown) => {
          process.stderr.write(`[hydra-daemon] connector ${entry.def.id} tool refresh failed: ${describeError(e)}\n`);
        });
    });
    // Deliberate: an unexpected close keeps tools installed and status connected; the next call reopens lazily (auth failure -> needs_sign_in).
    client.onClose(() => {
      if (entry.client === client) entry.client = undefined;
    });
    return { client, tools };
  }

  /**
   * The live client, reopening it when it has gone away. Concurrent callers share
   * one open. A client opened for a superseded generation is closed, never installed.
   */
  private ensureClient(entry: Entry): Promise<McpClient> {
    if (entry.client?.connectionState === "connected") return Promise.resolve(entry.client);
    if (entry.opening) return entry.opening;
    const gen = entry.gen;
    const opening: Promise<McpClient> = this.openClient(entry)
      .then(async ({ client, tools }) => {
        if (this.closed || gen !== entry.gen) {
          await client.close().catch(() => {});
          throw new Superseded();
        }
        entry.client = client;
        entry.tools = tools;
        this.notifyChange();
        return client;
      })
      .finally(() => {
        if (entry.opening === opening) entry.opening = undefined;
      });
    entry.opening = opening;
    return opening;
  }

  private async dropClient(entry: Entry): Promise<void> {
    const client = entry.client;
    entry.client = undefined;
    await client?.close().catch(() => {});
  }

  private async connectInBackground(entry: Entry): Promise<void> {
    const gen = entry.gen;
    try {
      await this.dropClient(entry);
      await this.ensureClient(entry);
      if (gen !== entry.gen) return;
      entry.retryAttempt = 0;
      this.setStatus(entry, "connected");
    } catch (e) {
      if (gen !== entry.gen) return;
      this.failConnect(entry, e);
    }
  }

  /** Auth failures need the user; anything else stays "error" and is retried with backoff. */
  private failConnect(entry: Entry, e: unknown): void {
    if (isAuthFailure(e)) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = undefined;
      this.setStatus(entry, "needs_sign_in");
      return;
    }
    process.stderr.write(`[hydra-daemon] connector ${entry.def.id} connect failed: ${describeError(e)}\n`);
    this.setStatus(entry, "error", `Could not connect to ${entry.def.name} (${describeError(e)}).`);
    this.scheduleReconnect(entry);
  }

  private scheduleReconnect(entry: Entry): void {
    if (this.closed) return;
    clearTimeout(entry.retryTimer);
    const gen = entry.gen;
    const delay = Math.min(this.deps.reconnectBaseMs * 2 ** entry.retryAttempt, this.deps.reconnectMaxMs);
    entry.retryAttempt++;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      this.track(this.reconnect(entry, gen));
    }, delay);
    entry.retryTimer.unref?.();
  }

  /** One background retry; the status stays "error" until it succeeds. */
  private async reconnect(entry: Entry, gen: number): Promise<void> {
    if (this.closed || gen !== entry.gen) return;
    try {
      await this.dropClient(entry);
      await this.ensureClient(entry);
      if (gen !== entry.gen) return;
      entry.retryAttempt = 0;
      this.setStatus(entry, "connected");
    } catch (e) {
      if (gen !== entry.gen) return;
      if (isAuthFailure(e)) this.failConnect(entry, e);
      else {
        process.stderr.write(`[hydra-daemon] connector ${entry.def.id} reconnect failed: ${describeError(e)}\n`);
        this.scheduleReconnect(entry);
      }
    }
  }

  private async runSignIn(entry: Entry, callback: CallbackHandle): Promise<void> {
    this.bump(entry);
    const gen = entry.gen;
    const provider = entry.provider;
    const abort = new AbortController();
    let stop!: (e: SignInStopped) => void;
    const stopped = new Promise<never>((_, reject) => (stop = reject));
    stopped.catch(() => {});
    this.activeSignIn = {
      connectorId: entry.def.id,
      abort: (reason) => {
        abort.abort();
        stop(new SignInStopped(reason));
      },
    };
    const timer = setTimeout(() => {
      abort.abort();
      stop(new SignInStopped("timeout"));
    }, this.deps.signInTimeoutMs);
    entry.redirectSink = (url) => {
      if (gen !== entry.gen) return;
      this.emit({ type: "event", event: "connector.signInUrl", connectorId: entry.def.id, url: url.toString() });
    };
    this.setStatus(entry, "connecting");
    try {
      await this.dropClient(entry);
      try {
        await Promise.race([this.ensureClient(entry), stopped]);
      } catch (e) {
        if (!(e instanceof McpOAuthAuthorizationRequiredError)) throw e;
        const state = await provider.state();
        const { code, iss } = await Promise.race([callback.waitForCallback(state), stopped]);
        await Promise.race([
          this.deps.authorize(provider, {
            serverUrl: entry.def.url,
            authorizationCode: code,
            iss,
            signal: abort.signal,
          }),
          stopped,
        ]);
        await Promise.race([this.ensureClient(entry), stopped]);
      }
      if (gen !== entry.gen) return;
      this.setStatus(entry, "connected");
    } catch (e) {
      // A superseding owner (sign-out, shutdown) has already handled status and cleanup.
      if (gen === entry.gen) {
        // Supersede our own late work (pending open, token exchange) before cleaning up.
        this.bump(entry);
        await this.dropClient(entry);
        if (e instanceof SignInStopped) {
          this.setStatus(
            entry,
            "signed_out",
            e.reason === "timeout" ? "Sign-in timed out. Try again." : "Sign-in was cancelled.",
          );
        } else if (isAuthFailure(e)) {
          this.setStatus(entry, "signed_out", `Sign-in with ${entry.def.name} was not accepted (${describeError(e)}).`);
        } else {
          process.stderr.write(`[hydra-daemon] connector ${entry.def.id} sign-in failed: ${describeError(e)}\n`);
          this.setStatus(entry, "error", `Sign-in with ${entry.def.name} failed (${describeError(e)}).`);
        }
      }
    } finally {
      clearTimeout(timer);
      entry.redirectSink = undefined;
      await callback.close().catch(() => {});
      // Released last, so a new sign-in cannot start before cleanup finished.
      this.activeSignIn = undefined;
    }
  }

  /**
   * Run fn against a live client. Transient failures are retried only while the
   * client is being opened; once the call has been sent it is replayed only after
   * session expiry (once; the server rejects an unknown session without running
   * it) or HTTP 429, never after a failure that may have run it. Auth refusal
   * moves the connector to needs_sign_in; a failed open starts background
   * reconnects. Every iteration first checks the call is still wanted.
   */
  private async withClient<T>(
    entry: Entry,
    signal: AbortSignal | undefined,
    fn: (client: McpClient) => Promise<T>,
  ): Promise<T> {
    const gen = entry.gen;
    let rebuilt = false;
    let retries = 0;
    for (;;) {
      if (this.closed || gen !== entry.gen) throw new Superseded();
      signal?.throwIfAborted();
      if (entry.status !== "connected") {
        throw new ConnectorError("not_connected", `${entry.def.name} is not connected.`);
      }
      let opening = true;
      try {
        const client = await this.ensureClient(entry);
        opening = false;
        return await fn(client);
      } catch (e) {
        if (e instanceof Superseded || signal?.aborted || this.closed || gen !== entry.gen) throw e;
        if (isAuthFailure(e)) {
          await this.dropClient(entry);
          this.failConnect(entry, e);
          throw e;
        }
        if (e instanceof McpSessionExpiredError && !rebuilt) {
          rebuilt = true;
          await this.dropClient(entry);
          continue;
        }
        const retryable = opening ? isTransient(e) : e instanceof McpHttpError && e.status === 429;
        if (retryable && retries < 2) {
          retries++;
          await new Promise((r) => setTimeout(r, this.deps.retryDelayMs));
          continue;
        }
        if (opening) this.failConnect(entry, e);
        throw e;
      }
    }
  }
}
