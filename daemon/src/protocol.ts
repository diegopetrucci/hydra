/**
 * TypeScript types for the Hydra JSON-lines protocol.
 *
 * Requests flow in on stdin; results and events flow out on stdout.
 * See PROTOCOL.md for the full specification.
 */

// ─── Requests ────────────────────────────────────────────────────────────────

export type HelloRequest = { id: string; type: "hello" };
export type ModelsListRequest = { id: string; type: "models.list" };
export type BotsListRequest = { id: string; type: "bots.list" };
export type BotsCreateRequest = {
  id: string;
  type: "bots.create";
  name: string;
  instructions: string;
  model?: string; // "provider/modelId", e.g. "anthropic/claude-sonnet-4-5"
};
export type BotsHistoryRequest = { id: string; type: "bots.history"; botId: string };
export type BotsSendRequest = {
  id: string;
  type: "bots.send";
  botId: string;
  text: string;
  clientMessageId: string;
};
export type BotsStopRequest = { id: string; type: "bots.stop"; botId: string };

// ─── Auth requests ───────────────────────────────────────────────────────────

export type AuthStatusRequest = { id: string; type: "auth.status" };
export type AuthLoginRequest = {
  id: string;
  type: "auth.login";
  providerId: string;
  /** "oauth" (default) or "api_key". */
  loginType?: "oauth" | "api_key";
};
export type AuthRespondRequest = {
  id: string;
  type: "auth.respond";
  loginId: string;
  promptId: string;
  value: string;
};
export type AuthCancelRequest = { id: string; type: "auth.cancel"; loginId: string };
export type AuthSetApiKeyRequest = {
  id: string;
  type: "auth.setApiKey";
  providerId: string;
  apiKey: string;
};
export type AuthLogoutRequest = { id: string; type: "auth.logout"; providerId: string };

// ─── Connector requests ──────────────────────────────────────────────────────

export type ConnectorsListRequest = { id: string; type: "connectors.list" };
export type ConnectorsSignInRequest = {
  id: string;
  type: "connectors.signIn";
  connectorId: string;
};
export type ConnectorsSignOutRequest = {
  id: string;
  type: "connectors.signOut";
  connectorId: string;
};

export type Request =
  | HelloRequest
  | ModelsListRequest
  | BotsListRequest
  | BotsCreateRequest
  | BotsHistoryRequest
  | BotsSendRequest
  | BotsStopRequest
  | AuthStatusRequest
  | AuthLoginRequest
  | AuthRespondRequest
  | AuthCancelRequest
  | AuthSetApiKeyRequest
  | AuthLogoutRequest
  | ConnectorsListRequest
  | ConnectorsSignInRequest
  | ConnectorsSignOutRequest;

// ─── Results ─────────────────────────────────────────────────────────────────

export type HelloResult = {
  protocolVersion: string;
  daemonVersion: string;
  tools: string[];
};

export type ModelInfo = {
  provider: string;
  modelId: string;
  name: string;
  default: boolean;
};

export type BotInfo = {
  id: string;
  name: string;
  instructions: string;
  model: string; // "provider/modelId"
  createdAt: string;
  lastMessagePreview: string;
  lastMessageAt: string;
};

export type MessageInfo = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

export type SendResult = { accepted: true };

export type StopResult = { stopped: true };

/** One entry in the auth.status providers array. */
export type AuthStatusEntry = {
  providerId: string;
  /** Credential type, or null when no credential is configured. */
  type: "oauth" | "api_key" | null;
  /**
   * How the credential is sourced:
   * - "stored"  – a credential is persisted in credentials.json.
   * - "env"     – the provider resolves from an environment variable
   *               (e.g. ANTHROPIC_API_KEY); no secret is stored on disk.
   * Omitted when type is null.
   */
  source?: "stored" | "env";
};

export type AuthStatusResult = { providers: AuthStatusEntry[] };
export type AuthLoginResult = { loginId: string };

// ─── Responses ───────────────────────────────────────────────────────────────

export type OkResponse<T> = { id: string; type: "result"; result: T };
export type ErrResponse = {
  id: string | null;
  type: "error";
  error: { code: string; message: string };
};
export type Response<T> = OkResponse<T> | ErrResponse;

// ─── Events ──────────────────────────────────────────────────────────────────

export type BotUpdatedEvent = {
  type: "event";
  event: "bot.updated";
  bot: BotInfo;
};

export type MessageStartedEvent = {
  type: "event";
  event: "message.started";
  botId: string;
  messageId: string;
};

export type MessageDeltaEvent = {
  type: "event";
  event: "message.delta";
  botId: string;
  messageId: string;
  text: string;
};

export type MessageCompletedEvent = {
  type: "event";
  event: "message.completed";
  botId: string;
  /** Streaming id from the corresponding message.started / message.delta events. */
  messageId: string;
  /** The committed message; message.id is the durable entry id (same as bots.history). */
  message: MessageInfo;
};

export type BotActivityEvent = {
  type: "event";
  event: "bot.activity";
  botId: string;
  activity: "thinking" | "tool" | "idle";
  /** Present when activity === "tool": the tool's registered name. */
  tool?: string;
  /** Present when activity === "tool": a human-readable label for the UI. */
  label?: string;
};

export type BotErrorEvent = {
  type: "event";
  event: "bot.error";
  botId: string;
  code: string;
  message: string;
};

// ─── Auth events ─────────────────────────────────────────────────────────────

/** Emitted when the OAuth flow has a browser URL for the app to open. */
export type AuthUrlEvent = {
  type: "event";
  event: "auth.url";
  loginId: string;
  url: string;
  instructions?: string;
};

/** Informational message from the auth flow (e.g. progress updates). */
export type AuthInfoEvent = {
  type: "event";
  event: "auth.info";
  loginId: string;
  message: string;
};

/** The flow needs input from the user. */
export type AuthPromptEvent = {
  type: "event";
  event: "auth.prompt";
  loginId: string;
  promptId: string;
  kind: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
};

/** The login flow completed successfully. */
export type AuthCompletedEvent = {
  type: "event";
  event: "auth.completed";
  loginId: string;
  providerId: string;
};

/** The login flow failed or was cancelled. */
export type AuthFailedEvent = {
  type: "event";
  event: "auth.failed";
  loginId: string;
  message: string;
};

// ─── Connector events ────────────────────────────────────────────────────────

export type ConnectorStatus = "signed_out" | "connecting" | "connected" | "needs_sign_in" | "error";

export type ConnectorInfo = {
  id: string;
  name: string;
  status: ConnectorStatus;
  /** Present for "error", and for "signed_out" after a failed or timed-out sign-in. */
  error?: string;
};

/** Emitted when a connector sign-in has a browser URL for the app to open. */
export type ConnectorSignInUrlEvent = {
  type: "event";
  event: "connector.signInUrl";
  connectorId: string;
  url: string;
};

/** Emitted whenever a connector's status changes. */
export type ConnectorUpdatedEvent = {
  type: "event";
  event: "connector.updated";
  connector: ConnectorInfo;
};

export type ProtocolEvent =
  | BotUpdatedEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | BotActivityEvent
  | BotErrorEvent
  | AuthUrlEvent
  | AuthInfoEvent
  | AuthPromptEvent
  | AuthCompletedEvent
  | AuthFailedEvent
  | ConnectorSignInUrlEvent
  | ConnectorUpdatedEvent;

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function ok<T>(id: string, result: T): OkResponse<T> {
  return { id, type: "result", result };
}

export function err(id: string | null, code: string, message: string): ErrResponse {
  return { id, type: "error", error: { code, message } };
}

/** Parse "provider/modelId" → {provider, modelId}. */
export function parseModelRef(model: string): { provider: string; modelId: string } | null {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) return null;
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/** Format {provider, modelId} → "provider/modelId". */
export function formatModelRef(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export const PROTOCOL_VERSION = "1";
export const DAEMON_VERSION = "0.1.0";
