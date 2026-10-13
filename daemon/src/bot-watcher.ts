/**
 * bot-watcher.ts
 *
 * Attaches a pi-durable watchEvents stream to one bot conversation and
 * translates agent events into protocol events emitted via the emit callback.
 *
 * One BotWatcher per bot is created on startup (for existing bots) and on
 * bots.create. Watchers are long-lived and observe all future activity,
 * including proactive messages.
 */

import type { Context } from "@earendil-works/chord";
import { watchEvents } from "@earendil-works/pi-durable";
import type {
  AgentEvent,
  AgentEventStream,
  Harness,
  JsonObject,
  WatchEnd,
} from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { CONNECTORS } from "./connectors.js";
import { metaToBotInfo } from "./docs.js";
import { NO_REPLY } from "./system-prompt.js";
import type { StoredBotMeta } from "./docs.js";
import type {
  BotActivityEvent,
  BotErrorEvent,
  BotUpdatedEvent,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageStartedEvent,
  ProtocolEvent,
} from "./protocol.js";

export type EmitFn = (event: ProtocolEvent) => void;
export type GetBotFn = (convId: ConversationId) => StoredBotMeta | undefined;

/**
 * Compute a human-readable activity label for a tool invocation.
 *
 * Rules:
 *  - web_search           → "Searching the web"
 *  - fetch_content (1 URL) → "Reading <hostname>"
 *  - fetch_content (N URLs) → "Reading N pages"
 *  - get_search_content   → "Reading saved results"
 *  - anything else         → the tool name (fallback)
 *
 * Full URLs with query strings are never placed in labels.
 */
export function computeToolLabel(toolName: string, args: JsonObject): string {
  switch (toolName) {
    case "web_search":
      return "Searching the web";
    case "fetch_content": {
      const urls: string[] = [];
      if (typeof args["url"] === "string") urls.push(args["url"]);
      if (Array.isArray(args["urls"])) {
        for (const u of args["urls"] as unknown[]) {
          if (typeof u === "string") urls.push(u);
        }
      }
      if (urls.length === 0) return "Fetching content";
      if (urls.length > 1) return `Reading ${urls.length} pages`;
      try {
        return `Reading ${new URL(urls[0]!).hostname}`;
      } catch {
        return "Reading page";
      }
    }
    case "get_search_content":
      return "Reading saved results";
    case "schedule_message":
      return "Scheduling a check-in";
    case "list_schedules":
      return "Listing schedules";
    case "cancel_schedule":
      return "Cancelling schedule";
    case "watch_ci":
      return "Watching CI";
    case "stop_watching_ci":
      return "Stopping CI watch";
    case "tool_search":
      return "Looking for tools";
    default: {
      // Connector tools: never show the raw tool name or its arguments.
      const connector = CONNECTORS.find((c) => toolName.startsWith(`mcp__${c.id}__`));
      if (connector) return `Using ${connector.name}`;
      return toolName;
    }
  }
}

/**
 * When `task_failed` carries structured detail (e.g. from TaskOutcomeError),
 * attempt to classify the failure from it.  Returns true/false when the detail
 * is conclusive, or null when it provides no auth signal.
 *
 * Anthropic API errors embed `{ error: { type: "authentication_error" | "permission_error" } }`.
 * Some providers surface an HTTP status under `status`, `statusCode`, or `httpStatus`.
 */
function classifyDetailAsAuth(detail: unknown): boolean | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as Record<string, unknown>;
  // Anthropic-style error body: { error: { type: "authentication_error" | "permission_error" } }
  const errorField = d["error"];
  if (typeof errorField === "object" && errorField !== null) {
    const type = (errorField as Record<string, unknown>)["type"];
    if (type === "authentication_error" || type === "permission_error") return true;
  }
  // HTTP status code in structured data.
  const status = d["status"] ?? d["statusCode"] ?? d["httpStatus"];
  if (status === 401 || status === 403) return true;
  return null;
}

/**
 * Return true when a task_failed event indicates an authentication failure
 * (missing/invalid credential, expired OAuth token, HTTP 401/403).
 *
 * When the event carries a `detail` field (TaskOutcomeError.detail), it is
 * checked first for structured auth signals.  The message string is consulted
 * as a fallback and matched with tightly anchored patterns to avoid false
 * positives:
 *
 *  - "auth" is matched as a whole word (\bauth\b) to exclude "author", "authority".
 *  - "401" and "403" are matched as whole numbers (\b401\b) to exclude
 *    longer token counts like "4012" or "14030".
 *  - Anthropic's error type strings ("authentication_error", "permission_error")
 *    are matched explicitly because they contain non-word-boundary "auth".
 *
 * @param message  The task_failed event's `message` string.
 * @param detail   Optional structured detail from the event (may be absent).
 */
export function isTaskFailedAuthError(message: string, detail?: unknown): boolean {
  // Prefer structured data when available.
  if (detail !== undefined && detail !== null) {
    const structured = classifyDetailAsAuth(detail);
    if (structured !== null) return structured;
  }
  const lower = message.toLowerCase();
  return (
    lower.includes("oauth") ||
    lower.includes("credential") ||
    /\bauth\b/.test(lower) ||
    lower.includes("authentication_error") ||
    lower.includes("permission_error") ||
    /\b401\b/.test(lower) ||
    /\b403\b/.test(lower) ||
    lower.includes("unauthorized") ||
    lower.includes("unauthenticated")
  );
}

/**
 * Called when an assistant message completes; updates lastMessagePreview/lastMessageAt
 * in the BotsRegistryDoc and the in-memory cache.
 */
export type UpdateLastMessageFn = (
  convId: ConversationId,
  preview: string,
  at: string,
) => Promise<void>;

interface InFlight {
  /** Streaming id emitted in message.started and message.delta. */
  messageId: string;
  /** Accumulated text from text_delta events. */
  text: string;
  /**
   * True while accumulated text (trimmed) is still a prefix of NO_REPLY.
   * message.started and deltas are suppressed until divergence or message_end.
   */
  heldBack: boolean;
}

export class BotWatcher {
  private stream?: AgentEventStream;
  private inFlight?: InFlight;
  private stopped = false;

  constructor(
    private readonly harness: Harness,
    private readonly convId: ConversationId,
    private readonly emitFn: EmitFn,
    private readonly getBot: GetBotFn,
    private readonly updateLastMessage: UpdateLastMessageFn,
    private readonly ctx: Context,
    /**
     * Called once per reply (on run_start) before the thinking event.
     * Used to reset the web-tools per-reply request budget.
     */
    private readonly onRunStart?: () => void,
  ) {}

  async start(): Promise<void> {
    this.stream = await watchEvents(this.harness, this.convId, this.ctx);
    const botId = String(this.convId);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    this.stream.start(async (events: readonly AgentEvent[], _ctx: Context) => {
      for (const ev of events) {
        if (self.stopped) break;
        await self.handleEvent(ev, botId);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.stream) await this.stream.stop();
  }

  get closed(): Promise<WatchEnd> | undefined {
    return this.stream?.closed;
  }

  private emit(event: ProtocolEvent): void {
    this.emitFn(event);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async handleEvent(ev: AgentEvent, botId: string): Promise<void> {
    switch (ev.type) {
      case "run_start": {
        // Reset the web-tools per-reply request budget before the run starts.
        this.onRunStart?.();
        this.emit({
          type: "event",
          event: "bot.activity",
          botId,
          activity: "thinking",
        } satisfies BotActivityEvent);
        break;
      }

      case "turn_start": {
        this.emit({
          type: "event",
          event: "bot.activity",
          botId,
          activity: "thinking",
        } satisfies BotActivityEvent);
        break;
      }

      case "run_end": {
        this.emit({
          type: "event",
          event: "bot.activity",
          botId,
          activity: "idle",
        } satisfies BotActivityEvent);
        break;
      }

      case "message_start": {
        // Only track assistant messages; system/user messages don't produce deltas.
        if (ev.message.role !== "assistant") break;
        const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Start held-back: suppress message.started and deltas until we know
        // the reply diverges from NO_REPLY (or the message completes).
        this.inFlight = { messageId, text: "", heldBack: true };
        break;
      }

      case "message_update": {
        if (!this.inFlight) break;
        for (const change of ev.changes) {
          if (change.type === "text_delta") {
            this.inFlight.text += change.delta;
            if (this.inFlight.heldBack) {
              // Check if accumulated text (trimmed) is still a prefix of NO_REPLY.
              const trimmed = this.inFlight.text.trim();
              if (NO_REPLY.startsWith(trimmed)) {
                // Still possibly NO_REPLY – keep holding back.
              } else {
                // Diverged: release the hold-back, emit started + one catch-up delta.
                this.inFlight.heldBack = false;
                this.emit({
                  type: "event",
                  event: "message.started",
                  botId,
                  messageId: this.inFlight.messageId,
                } satisfies MessageStartedEvent);
                this.emit({
                  type: "event",
                  event: "message.delta",
                  botId,
                  messageId: this.inFlight.messageId,
                  text: this.inFlight.text,
                } satisfies MessageDeltaEvent);
              }
            } else {
              // Already released: stream deltas as normal.
              this.emit({
                type: "event",
                event: "message.delta",
                botId,
                messageId: this.inFlight.messageId,
                text: change.delta,
              } satisfies MessageDeltaEvent);
            }
          }
        }
        break;
      }

      case "message_end": {
        const inFlight = this.inFlight;
        // Only emit completed for assistant entries (kind "pi.assistant").
        if (!inFlight || ev.entry?.kind !== "pi.assistant") break;
        this.inFlight = undefined;

        // Durable entry id – matches what bots.history returns.
        const entryId = String(ev.entry.id);

        // The committed AssistantMessage carries the authoritative full text and
        // a timestamp set by pi-ai at generation time.
        const assistantMsg = ev.entry.model?.[0] as AssistantMessage | undefined;
        const fullText = extractAssistantText(assistantMsg);
        const createdAt =
          assistantMsg?.timestamp != null
            ? new Date(assistantMsg.timestamp).toISOString()
            : new Date().toISOString();

        // NO_REPLY sentinel: if the final committed text (trimmed) is exactly
        // NO_REPLY, suppress all message.* events and preview update.
        // bot.activity still goes back to idle via the run_end event.
        // Text-less turns (tool-call only) are suppressed the same way; the
        // hold-back guarantees nothing was released while streaming.
        if (fullText.trim() === NO_REPLY || fullText.trim() === "") {
          break;
        }

        if (inFlight.heldBack) {
          // Reply never diverged during streaming (e.g. a short reply like "NO").
          // Release now: emit started, one delta with the full committed text, then
          // completed below.  Skip the empty-delta case (tool-call-only messages).
          this.emit({
            type: "event",
            event: "message.started",
            botId,
            messageId: inFlight.messageId,
          } satisfies MessageStartedEvent);
          if (fullText) {
            this.emit({
              type: "event",
              event: "message.delta",
              botId,
              messageId: inFlight.messageId,
              text: fullText,
            } satisfies MessageDeltaEvent);
          }
        } else {
          // Already released during streaming: emit any tail text not yet streamed.
          if (fullText.length > inFlight.text.length) {
            const remaining = fullText.slice(inFlight.text.length);
            this.emit({
              type: "event",
              event: "message.delta",
              botId,
              messageId: inFlight.messageId,
              text: remaining,
            } satisfies MessageDeltaEvent);
          }
        }

        const preview = fullText.slice(0, 120);

        // Persist lastMessagePreview / lastMessageAt (fire-and-forget).
        this.updateLastMessage(this.convId, preview, createdAt).catch(() => {});

        // message.completed:
        //   messageId = streaming id (correlates with message.started / message.delta)
        //   message.id = durable entry id (same value bots.history returns)
        this.emit({
          type: "event",
          event: "message.completed",
          botId,
          messageId: inFlight.messageId,
          message: {
            id: entryId,
            role: "assistant" as const,
            text: fullText,
            createdAt,
          },
        } satisfies MessageCompletedEvent);

        const meta = this.getBot(this.convId);
        if (meta) {
          const updated: StoredBotMeta = {
            ...meta,
            lastMessagePreview: preview,
            lastMessageAt: createdAt,
          };
          this.emit({
            type: "event",
            event: "bot.updated",
            bot: metaToBotInfo(botId, updated),
          } satisfies BotUpdatedEvent);
        }
        break;
      }

      case "tool_execution_start": {
        const toolLabel = computeToolLabel(ev.toolName, ev.args);
        this.emit({
          type: "event",
          event: "bot.activity",
          botId,
          activity: "tool",
          tool: ev.toolName,
          label: toolLabel,
        } satisfies BotActivityEvent);
        break;
      }

      case "tool_execution_end": {
        // Return to thinking state; generation is still running.
        this.emit({
          type: "event",
          event: "bot.activity",
          botId,
          activity: "thinking",
        } satisfies BotActivityEvent);
        break;
      }

      case "task_failed": {
        // Classify the failure: an auth error gets code "auth_required"; everything
        // else gets "generation_failed".  Never emit the raw upstream message
        // (it may contain HTTP response bodies, URLs, or refresh tokens).
        // Classification is based on pi-ai ModelsError message patterns ("auth",
        // "oauth", "credential") and HTTP 401/403 indicators in the message text.
        // The event type doesn't expose `detail` but the runtime may include it
        // when TaskOutcomeError serialises structured data; pass it when present.
        const detail = "detail" in ev ? ev.detail : undefined;
        const isAuthError = isTaskFailedAuthError(ev.message, detail);
        const code = isAuthError ? "auth_required" : "generation_failed";
        const message = isAuthError
          ? "Anthropic API key is missing or invalid."
          : "Generation failed.";
        // Log the raw upstream message to stderr only (not to stdout/events).
        process.stderr.write(
          `[hydra-daemon] task_failed (bot ${botId}, code=${code}): ${ev.kind}\n`,
        );
        this.emit({
          type: "event",
          event: "bot.error",
          botId,
          code,
          message,
        } satisfies BotErrorEvent);
        // Always transition to idle after a failure.
        this.emit({
          type: "event",
          event: "bot.activity",
          botId,
          activity: "idle",
        } satisfies BotActivityEvent);
        break;
      }
    }
  }
}

// ─── Text extraction helpers ──────────────────────────────────────────────────

function extractAssistantText(msg: AssistantMessage | undefined): string {
  if (!msg) return "";
  return msg.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");
}
