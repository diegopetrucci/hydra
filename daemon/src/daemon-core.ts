/**
 * daemon-core.ts
 *
 * Testable core of the Hydra daemon.  Accepts an already-open Harness and
 * Models collection and handles protocol commands.  Stdin/stdout wiring and
 * lock-file management live in main.ts.
 */

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, UserEntry, createRegistry } from "@earendil-works/pi-durable";
import type { Conversation, ConversationId, Cursor, EntryRecord } from "@earendil-works/pi-durable";
import type { AssistantMessage, UserMessage, TextContent, Models } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { BotsRegistryDoc, metaToRecord, metaToBotInfo, recordToMeta } from "./docs.js";
import type { StoredBotMeta } from "./docs.js";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER, isOfferedModel } from "./models.js";
import { NO_REPLY, introPrompt } from "./system-prompt.js";
import { HYDRA_MARKER_PREFIX } from "./schedules.js";
import { describeError } from "./describe-error.js";
import {
  DAEMON_VERSION,
  PROTOCOL_VERSION,
  err,
  ok,
  parseModelRef,
} from "./protocol.js";
import type {
  AuthCancelRequest,
  AuthLoginRequest,
  AuthLogoutRequest,
  AuthRespondRequest,
  AuthSetApiKeyRequest,
  AuthStatusEntry,
  BotInfo,
  BotsCreateRequest,
  BotsHistoryRequest,
  BotsListRequest,
  BotsSendRequest,
  BotsStopRequest,
  ConnectorsSignInRequest,
  ConnectorsSignOutRequest,
  ErrResponse,
  HelloRequest,
  MessageInfo,
  OkResponse,
  ProtocolEvent,
} from "./protocol.js";
import { BotWatcher } from "./bot-watcher.js";
import type { GetBotFn, UpdateLastMessageFn } from "./bot-watcher.js";
import { AuthManager } from "./auth-manager.js";
import type { LoginFn } from "./auth-manager.js";
import { ConnectorError } from "./connectors.js";
import type { ConnectorManager } from "./connectors.js";

/** Provider IDs supported in v1. */
const KNOWN_PROVIDERS = [DEFAULT_PROVIDER] as const;

export type EmitFn = (event: ProtocolEvent) => void;

export class DaemonCore {
  private readonly watchers = new Map<ConversationId, BotWatcher>();
  /** In-memory cache: convId → typed metadata. */
  private botsCache: Map<string, StoredBotMeta> = new Map();
  private readonly credentials: CredentialStore;
  private readonly authManager: AuthManager;

  constructor(
    private readonly harness: Harness,
    private readonly piModels: Models,
    private readonly emitFn: EmitFn,
    private readonly ctx: Context = BACKGROUND_CONTEXT,
    credentials?: CredentialStore,
    loginFn?: LoginFn,
    /** Tool names listed in the hello response; typically from the installed extension. */
    private readonly toolNames: readonly string[] = [],
    /**
     * Called once per reply (on run_start) to reset per-reply budgets.
     * Passed through to each BotWatcher.
     */
    private readonly onRunStart?: () => void,
    /**
     * When true (the default), cmdBotsCreate submits an intro turn after the
     * bot is created, provided credentials are available.  Set to false in
     * tests whose faux response queues would otherwise be consumed by the intro.
     */
    private readonly enableIntro: boolean = true,
    /** MCP connectors; when absent the connectors.* commands report "unavailable". */
    private readonly connectors?: ConnectorManager,
  ) {
    this.credentials = credentials ?? new InMemoryCredentialStore();
    const effectiveLoginFn: LoginFn =
      loginFn ?? ((p, t, i) => this.piModels.login(p, t, i));
    this.authManager = new AuthManager(effectiveLoginFn, emitFn);
  }

  /** Load existing bots, start task scheduler, attach event watchers. */
  async start(): Promise<void> {
    this.harness.resume();
    await this.connectors?.start();

    const registry = await this.harness.snapshot(BotsRegistryDoc, this.ctx);
    if (registry) {
      for (const [convIdStr, rec] of Object.entries(registry.bots)) {
        this.botsCache.set(convIdStr, recordToMeta(rec));
      }
    }

    for (const convIdStr of this.botsCache.keys()) {
      const convId = Number(convIdStr) as ConversationId;
      await this.attachWatcher(convId);
    }
  }

  /** Gracefully tear down all watchers. */
  async close(): Promise<void> {
    // Cancel all in-flight OAuth login sessions first. This aborts each
    // session's AbortController, which causes pi-ai's OAuth callback HTTP
    // server to close and release its event-loop reference.  Without this,
    // a login started before shutdown keeps the process alive indefinitely.
    this.authManager.cancelAll();

    for (const watcher of this.watchers.values()) {
      await watcher.stop();
    }
    this.watchers.clear();
  }

  /** Dispatch one incoming parsed-JSON value to the appropriate command handler. */
  async handleRequest(raw: unknown): Promise<OkResponse<unknown> | ErrResponse> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return err(null, "bad_request", "Request must be a JSON object");
    }
    const req = raw as Record<string, unknown>;
    const id = typeof req["id"] === "string" ? req["id"] : null;
    const type = req["type"];

    if (typeof type !== "string") {
      return err(id, "bad_request", "Missing or non-string 'type' field");
    }

    // id must be a string before dispatching; malformed requests get id:null error.
    if (id === null) {
      return err(null, "bad_request", "Request 'id' must be a non-empty string");
    }

    try {
      switch (type) {
        case "hello":
          // Synchronous – no await needed.
          return this.cmdHello(id, req as unknown as HelloRequest);
        case "models.list":
          // Synchronous – no await needed.
          return this.cmdModelsList(id);
        case "bots.list":
          return await this.cmdBotsList(id);
        case "bots.create":
          return await this.cmdBotsCreate(id, req as unknown as BotsCreateRequest);
        case "bots.history":
          return await this.cmdBotsHistory(id, req as unknown as BotsHistoryRequest);
        case "bots.send":
          return await this.cmdBotsSend(id, req as unknown as BotsSendRequest);
        case "bots.stop":
          return await this.cmdBotsStop(id, req as unknown as BotsStopRequest);
        case "auth.status":
          return await this.cmdAuthStatus(id);
        case "auth.login":
          // Synchronous – no await needed.
          return this.cmdAuthLogin(id, req as unknown as AuthLoginRequest);
        case "auth.respond":
          // Synchronous – no await needed.
          return this.cmdAuthRespond(id, req as unknown as AuthRespondRequest);
        case "auth.cancel":
          // Synchronous – no await needed.
          return this.cmdAuthCancel(id, req as unknown as AuthCancelRequest);
        case "auth.setApiKey":
          return await this.cmdAuthSetApiKey(id, req as unknown as AuthSetApiKeyRequest);
        case "auth.logout":
          return await this.cmdAuthLogout(id, req as unknown as AuthLogoutRequest);
        case "connectors.list":
          return this.cmdConnectorsList(id);
        case "connectors.signIn":
          return await this.cmdConnectorsSignIn(id, req as unknown as ConnectorsSignInRequest);
        case "connectors.signOut":
          return await this.cmdConnectorsSignOut(id, req as unknown as ConnectorsSignOutRequest);
        default:
          return err(id, "unknown_command", `Unknown command type: ${type}`);
      }
    } catch (e: unknown) {
      // Log only the error class (never the raw message, which may contain
      // secrets or upstream HTTP response bodies).
      const errClass = e instanceof Error ? e.constructor.name : "UnknownError";
      process.stderr.write(`[hydra-daemon] Internal error (id=${id}): ${errClass}\n`);
      return err(id, "internal_error", "An unexpected error occurred.");
    }
  }

  // ─── Command handlers ─────────────────────────────────────────────────────

  private cmdHello(id: string, _req: HelloRequest): OkResponse<unknown> {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      tools: [...this.toolNames],
    });
  }

  private cmdModelsList(id: string): OkResponse<unknown> {
    const allModels = this.piModels.getModels();
    const result = allModels.filter((m) => isOfferedModel(m.provider, m.id)).map((m) => ({
      provider: m.provider,
      modelId: m.id,
      name: m.name,
      default: m.provider === DEFAULT_PROVIDER && m.id === DEFAULT_MODEL_ID,
    }));
    return ok(id, result);
  }

  private async cmdBotsList(id: string): Promise<OkResponse<unknown>> {
    return ok(id, this.getAllBotInfos());
  }

  private async cmdBotsCreate(
    id: string,
    req: BotsCreateRequest,
  ): Promise<OkResponse<unknown> | ErrResponse> {
    const { name, instructions = "" } = req;
    if (!name || typeof name !== "string") {
      return err(id, "bad_request", "name is required");
    }

    let provider = DEFAULT_PROVIDER;
    let modelId = DEFAULT_MODEL_ID;

    if (req.model) {
      const ref = parseModelRef(req.model);
      if (!ref) {
        return err(id, "bad_request", `Invalid model reference: "${req.model}". Use "provider/modelId".`);
      }
      provider = ref.provider;
      modelId = ref.modelId;
      if (!isOfferedModel(provider, modelId)) {
        return err(id, "bad_request", `Model "${req.model}" is not offered. Available: anthropic/${DEFAULT_MODEL_ID}.`);
      }
    }

    const createdAt = new Date().toISOString();
    const meta: StoredBotMeta = {
      name,
      instructions,
      provider,
      modelId,
      createdAt,
      lastMessagePreview: "",
      lastMessageAt: "",
    };
    const record = metaToRecord(meta);

    const conv = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider, modelId },
          instructions,
        },
        init: async (tx, convId) => {
          const doc = await tx.doc(BotsRegistryDoc);
          doc.bots[String(convId)] = record;
        },
      },
      this.ctx,
    );

    this.botsCache.set(String(conv.id), meta);
    await this.attachWatcher(conv.id);

    const bot = metaToBotInfo(String(conv.id), meta);
    this.emitFn({ type: "event", event: "bot.updated", bot });

    // Intro turn: if signed in, submit the intro prompt (fire-and-forget generation).
    // Await admission only; generation runs asynchronously via BotWatcher.
    if (this.enableIntro) {
      const introProvider = meta.provider || DEFAULT_PROVIDER;
      const auth = await this.piModels.getAuth(introProvider).catch(() => undefined);
      if (auth) {
        try {
          await conv.submit(
            {
              type: "input",
              content: introPrompt(name),
              requestId: "hydra-intro",
              whenBusy: "followUp",
            },
            this.ctx,
          );
        } catch (e: unknown) {
          process.stderr.write(
            `[hydra-daemon] intro submit failed (${describeError(e)}), continuing\n`,
          );
        }
      }
      // Without credentials: skip silently – no bot.error, no submission.
    }

    return ok(id, bot);
  }

  private async cmdBotsHistory(
    id: string,
    req: BotsHistoryRequest,
  ): Promise<OkResponse<unknown> | ErrResponse> {
    const { botId } = req;
    const convId = Number(botId) as ConversationId;

    if (!this.botsCache.has(botId)) {
      return err(id, "not_found", `Bot not found: ${botId}`);
    }

    const conv = await this.harness.conversation(convId, this.ctx);
    if (!conv) {
      return err(id, "not_found", `Conversation not found for bot: ${botId}`);
    }

    const entries = await this.allEntries(conv);
    entries.reverse(); // oldest-first

    const messages: MessageInfo[] = [];
    for (const entry of entries) {
      if (UserEntry.is(entry) && entry.model && entry.model.length > 0) {
        const userMsg = entry.model[0] as UserMessage;
        const text = extractUserText(userMsg);
        // Omit hidden trigger messages (intro and check-in) identified by their marker prefix.
        if (text && !text.startsWith(HYDRA_MARKER_PREFIX)) {
          messages.push({
            id: String(entry.id),
            role: "user",
            text,
            // pi-ai UserMessage.timestamp is milliseconds since epoch.
            createdAt: new Date(userMsg.timestamp).toISOString(),
          });
        }
      } else if (AssistantEntry.is(entry) && entry.model && entry.model.length > 0) {
        const assistantMsg = entry.model[0] as AssistantMessage;
        const text = extractAssistantText(assistantMsg);
        // Omit NO_REPLY sentinel messages from history.
        if (text && text.trim() !== NO_REPLY) {
          messages.push({
            id: String(entry.id),
            role: "assistant",
            text,
            // pi-ai AssistantMessage.timestamp is milliseconds since epoch.
            createdAt: new Date(assistantMsg.timestamp).toISOString(),
          });
        }
      }
    }

    return ok(id, messages);
  }

  private async cmdBotsSend(
    id: string,
    req: BotsSendRequest,
  ): Promise<OkResponse<unknown> | ErrResponse> {
    const { botId, text, clientMessageId } = req;
    const convId = Number(botId) as ConversationId;

    if (!this.botsCache.has(botId)) {
      return err(id, "not_found", `Bot not found: ${botId}`);
    }

    const conv = await this.harness.conversation(convId, this.ctx);
    if (!conv) {
      return err(id, "not_found", `Conversation not found for bot: ${botId}`);
    }

    // Check credentials before submitting – fail fast with a typed event rather
    // than relying on substring matching of task_failed messages.
    const meta = this.botsCache.get(botId);
    if (meta) {
      const provider = meta.provider || DEFAULT_PROVIDER;
      const auth = await this.piModels.getAuth(provider).catch(() => undefined);
      if (!auth) {
        this.emitFn({
          type: "event",
          event: "bot.error",
          botId,
          code: "auth_required",
          message: `No credentials configured for provider "${provider}". Use auth.setApiKey or auth.login.`,
        });
        return ok(id, { accepted: false });
      }
    }

    // requestId provides dedup: same clientMessageId → same submission, no double-send.
    await conv.submit(
      { type: "input", content: text, requestId: clientMessageId, whenBusy: "followUp" },
      this.ctx,
    );

    return ok(id, { accepted: true });
  }

  private async cmdBotsStop(
    id: string,
    req: BotsStopRequest,
  ): Promise<OkResponse<unknown> | ErrResponse> {
    const { botId } = req;
    const convId = Number(botId) as ConversationId;

    if (!this.botsCache.has(botId)) {
      return err(id, "not_found", `Bot not found: ${botId}`);
    }

    const conv = await this.harness.conversation(convId, this.ctx);
    if (!conv) {
      return err(id, "not_found", `Conversation not found for bot: ${botId}`);
    }

    await conv.abort(this.ctx);
    return ok(id, { stopped: true });
  }

  // ─── Auth command handlers ─────────────────────────────────────────────────

  private async cmdAuthStatus(id: string): Promise<OkResponse<unknown>> {
    const providers: AuthStatusEntry[] = [];
    for (const providerId of KNOWN_PROVIDERS) {
      const stored = await this.credentials.read(providerId);
      if (stored) {
        providers.push({ providerId, type: stored.type, source: "stored" });
      } else if (providerId === "anthropic" && process.env["ANTHROPIC_API_KEY"]) {
        providers.push({ providerId, type: "api_key", source: "env" });
      } else {
        providers.push({ providerId, type: null });
      }
    }
    return ok(id, { providers });
  }

  private cmdAuthLogin(
    id: string,
    req: AuthLoginRequest,
  ): OkResponse<unknown> | ErrResponse {
    const { providerId, loginType = "oauth" } = req;
    if (!providerId || typeof providerId !== "string") {
      return err(id, "bad_request", "providerId is required");
    }
    if (loginType !== "oauth" && loginType !== "api_key") {
      return err(id, "bad_request", 'loginType must be "oauth" or "api_key"');
    }
    const loginId = this.authManager.startLogin(providerId, loginType);
    return ok(id, { loginId });
  }

  private cmdAuthRespond(
    id: string,
    req: AuthRespondRequest,
  ): OkResponse<unknown> | ErrResponse {
    const { loginId, promptId, value } = req;
    if (!loginId || !promptId || typeof value !== "string") {
      return err(id, "bad_request", "loginId, promptId, and value are required");
    }
    const accepted = this.authManager.respond(loginId, promptId, value);
    if (!accepted) {
      return err(
        id,
        "not_found",
        `No pending prompt for loginId "${loginId}" / promptId "${promptId}"`,
      );
    }
    return ok(id, { accepted: true });
  }

  private cmdAuthCancel(
    id: string,
    req: AuthCancelRequest,
  ): OkResponse<unknown> | ErrResponse {
    const { loginId } = req;
    if (!loginId) return err(id, "bad_request", "loginId is required");
    const cancelled = this.authManager.cancel(loginId);
    if (!cancelled) {
      return err(id, "not_found", `No active login session: ${loginId}`);
    }
    return ok(id, { cancelled: true });
  }

  private async cmdAuthSetApiKey(
    id: string,
    req: AuthSetApiKeyRequest,
  ): Promise<OkResponse<unknown> | ErrResponse> {
    const { providerId, apiKey } = req;
    if (!providerId || typeof providerId !== "string") {
      return err(id, "bad_request", "providerId is required");
    }
    if (!apiKey || typeof apiKey !== "string") {
      return err(id, "bad_request", "apiKey is required");
    }
    await this.credentials.modify(providerId, async () => ({
      type: "api_key" as const,
      key: apiKey,
    }));
    return ok(id, { stored: true });
  }

  private async cmdAuthLogout(
    id: string,
    req: AuthLogoutRequest,
  ): Promise<OkResponse<unknown> | ErrResponse> {
    const { providerId } = req;
    if (!providerId || typeof providerId !== "string") {
      return err(id, "bad_request", "providerId is required");
    }
    await this.credentials.delete(providerId);
    return ok(id, { loggedOut: true });
  }

  private cmdConnectorsList(id: string): OkResponse<unknown> | ErrResponse {
    if (!this.connectors) return err(id, "unavailable", "Connectors are not available.");
    return ok(id, this.connectors.list());
  }

  private async cmdConnectorsSignIn(
    id: string,
    req: ConnectorsSignInRequest,
  ): Promise<OkResponse<unknown> | ErrResponse> {
    return this.connectorCommand(id, req.connectorId, async (c) => {
      await c.signIn(req.connectorId);
      return { accepted: true };
    });
  }

  private async cmdConnectorsSignOut(
    id: string,
    req: ConnectorsSignOutRequest,
  ): Promise<OkResponse<unknown> | ErrResponse> {
    return this.connectorCommand(id, req.connectorId, async (c) => {
      await c.signOut(req.connectorId);
      return { signedOut: true };
    });
  }

  private async connectorCommand(
    id: string,
    connectorId: unknown,
    run: (c: ConnectorManager) => Promise<unknown>,
  ): Promise<OkResponse<unknown> | ErrResponse> {
    if (!this.connectors) return err(id, "unavailable", "Connectors are not available.");
    if (!connectorId || typeof connectorId !== "string") {
      return err(id, "bad_request", "connectorId is required");
    }
    try {
      return ok(id, await run(this.connectors));
    } catch (e: unknown) {
      if (e instanceof ConnectorError) return err(id, e.code, e.message);
      throw e;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private getAllBotInfos(): BotInfo[] {
    return Array.from(this.botsCache.entries()).map(([id, meta]) => metaToBotInfo(id, meta));
  }

  private async allEntries(conv: Conversation): Promise<EntryRecord[]> {
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conv.entries({}, 100, cursor, this.ctx);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return entries;
  }

  private async attachWatcher(convId: ConversationId): Promise<void> {
    if (this.watchers.has(convId)) return;

    const getBot: GetBotFn = (id) => this.botsCache.get(String(id));

    const updateLastMessage: UpdateLastMessageFn = async (id, preview, at) => {
      const cached = this.botsCache.get(String(id));
      if (cached) {
        const updated = { ...cached, lastMessagePreview: preview, lastMessageAt: at };
        this.botsCache.set(String(id), updated);
      }

      await this.harness.commit(async (tx) => {
        const reg = await tx.doc(BotsRegistryDoc);
        const existing = reg.bots[String(id)];
        if (existing) {
          existing["lastMessagePreview"] = preview;
          existing["lastMessageAt"] = at;
        }
      }, this.ctx);
    };

    const watcher = new BotWatcher(
      this.harness,
      convId,
      this.emitFn,
      getBot,
      updateLastMessage,
      this.ctx,
      this.onRunStart,
    );
    this.watchers.set(convId, watcher);
    await watcher.start();
  }
}

// ─── Text extraction ──────────────────────────────────────────────────────────

function extractUserText(msg: UserMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function extractAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");
}
