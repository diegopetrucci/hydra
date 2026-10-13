/**
 * auth-manager.ts
 *
 * Bridges pi-ai's AuthInteraction callback API with the daemon's JSON-lines
 * protocol. Manages in-flight login sessions.
 *
 * The daemon never opens the browser itself. It emits auth.url so the app can.
 * Never logs or emits tokens, keys, or raw secrets.
 */

import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Credential } from "@earendil-works/pi-ai";
import { ModelsError } from "@earendil-works/pi-ai";
import type { EmitFn } from "./daemon-core.js";
import type {
  AuthCompletedEvent,
  AuthFailedEvent,
  AuthInfoEvent,
  AuthPromptEvent,
  AuthUrlEvent,
} from "./protocol.js";

/** Injectable login function. Production: piModels.login. Tests: stub. */
export type LoginFn = (
  providerId: string,
  type: AuthType,
  interaction: AuthInteraction,
) => Promise<Credential>;

interface PendingPrompt {
  promptId: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

interface LoginSession {
  loginId: string;
  providerId: string;
  abort: AbortController;
  pendingPrompt: PendingPrompt | undefined;
}

export class AuthManager {
  private readonly sessions = new Map<string, LoginSession>();

  constructor(
    private readonly loginFn: LoginFn,
    private readonly emitFn: EmitFn,
  ) {}

  /**
   * Start a login flow. Returns loginId immediately; subsequent events are
   * emitted asynchronously: auth.url, auth.prompt, and finally auth.completed
   * or auth.failed.
   */
  startLogin(providerId: string, type: AuthType): string {
    const loginId = randomUUID();
    const abort = new AbortController();
    const session: LoginSession = {
      loginId,
      providerId,
      abort,
      pendingPrompt: undefined,
    };
    this.sessions.set(loginId, session);

    const interaction: AuthInteraction = {
      signal: abort.signal,

      notify: (event: AuthEvent): void => {
        // Emit nothing if the session was cancelled or removed before this
        // callback fires (e.g. a delayed network event after auth.cancel).
        if (!this.sessions.has(loginId)) return;
        if (event.type === "auth_url") {
          this.emitFn({
            type: "event",
            event: "auth.url",
            loginId,
            url: event.url,
            instructions: event.instructions,
          } satisfies AuthUrlEvent);
        } else if (event.type === "info" || event.type === "progress") {
          this.emitFn({
            type: "event",
            event: "auth.info",
            loginId,
            message: event.message,
          } satisfies AuthInfoEvent);
        }
        // device_code events are not currently surfaced; ignored.
      },

      prompt: (prompt: AuthPrompt): Promise<string> => {
        // Reject immediately if the session no longer exists (cancelled).
        if (!this.sessions.has(loginId)) {
          return Promise.reject(new Error("Session cancelled"));
        }
        return new Promise<string>((resolve, reject) => {
          const promptId = randomUUID();
          // Guard: reject any stale pending prompt (shouldn't happen in practice).
          if (session.pendingPrompt) {
            session.pendingPrompt.reject(new Error("Superseded by a new prompt"));
          }
          session.pendingPrompt = { promptId, resolve, reject };

          const ev: AuthPromptEvent = {
            type: "event",
            event: "auth.prompt",
            loginId,
            promptId,
            kind: prompt.type,
            message: prompt.message,
            placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
            options: "options" in prompt ? [...prompt.options] : undefined,
          };
          this.emitFn(ev);

          // If the flow provides a per-prompt cancellation signal (e.g. manual_code
          // racing a callback server), honour it.
          if (prompt.signal) {
            prompt.signal.addEventListener(
              "abort",
              () => {
                if (session.pendingPrompt?.promptId === promptId) {
                  session.pendingPrompt = undefined;
                  reject(new Error("Prompt cancelled by flow"));
                }
              },
              { once: true },
            );
          }
        });
      },
    };

    // Run the login flow in the background; never await here.
    this.loginFn(providerId, type, interaction)
      .then(() => {
        // If the session was removed by cancel(), stay quiet 
        // (auth.failed was already emitted by cancel()).
        if (!this.sessions.has(loginId)) return;
        this.sessions.delete(loginId);
        this.emitFn({
          type: "event",
          event: "auth.completed",
          loginId,
          providerId,
        } satisfies AuthCompletedEvent);
      })
      .catch((err: unknown) => {
        // If the session was already removed by cancel(), stay quiet.
        if (!this.sessions.has(loginId)) return;
        this.sessions.delete(loginId);
        // Sanitize: never emit raw upstream error strings (they may embed HTTP
        // response bodies, URLs, or OAuth tokens).  Map to stable user messages.
        const msg = sanitizeLoginError(err);
        // Log only the error class and code (not the message which may contain
        // secrets, HTTP bodies, or URLs).
        const errClass = err instanceof Error ? err.constructor.name : "Error";
        const errCode = err instanceof ModelsError ? ` code=${err.code}` : "";
        process.stderr.write(
          `[hydra-daemon] auth.failed (${loginId}): ${errClass}${errCode}\n`,
        );
        this.emitFn({
          type: "event",
          event: "auth.failed",
          loginId,
          message: msg,
        } satisfies AuthFailedEvent);
      });

    return loginId;
  }

  /**
   * Resolve a pending auth.prompt. Returns true when the response was accepted.
   */
  respond(loginId: string, promptId: string, value: string): boolean {
    const session = this.sessions.get(loginId);
    if (!session?.pendingPrompt) return false;
    if (session.pendingPrompt.promptId !== promptId) return false;
    const { resolve } = session.pendingPrompt;
    session.pendingPrompt = undefined;
    resolve(value);
    return true;
  }

  /**
   * Silently cancel all in-flight login sessions. Called during daemon shutdown.
   *
   * No events are emitted – stdout's reader is gone by the time shutdown runs,
   * and emitting auth.failed or auth.completed to a closed pipe would either
   * throw or be silently dropped.
   *
   * Aborting each session's AbortController causes pi-ai's OAuth callback
   * server (startOAuthCallbackServer) to call its onAbort listener and close
   * the HTTP server, releasing the event-loop reference that would otherwise
   * orphan the process.
   */
  cancelAll(): void {
    for (const session of this.sessions.values()) {
      session.abort.abort();
      if (session.pendingPrompt) {
        session.pendingPrompt.reject(new Error("Daemon shutting down"));
        session.pendingPrompt = undefined;
      }
    }
    this.sessions.clear();
  }

  /**
   * Cancel an in-flight login. Emits auth.failed and returns true if a session
   * was found.
   */
  cancel(loginId: string): boolean {
    const session = this.sessions.get(loginId);
    if (!session) return false;
    // Abort the interaction signal so any blocking network/callback-server waits stop.
    session.abort.abort();
    if (session.pendingPrompt) {
      session.pendingPrompt.reject(new Error("Login cancelled"));
      session.pendingPrompt = undefined;
    }
    this.sessions.delete(loginId);
    this.emitFn({
      type: "event",
      event: "auth.failed",
      loginId,
      message: "Login cancelled",
    } satisfies AuthFailedEvent);
    return true;
  }
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

/**
 * Return a stable, user-facing error message for a failed login.
 *
 * Never includes raw upstream strings: pi-ai's OAuth errors embed HTTP
 * response bodies, URLs, and sometimes partial tokens.  Only the error
 * classification (ModelsError code) reaches the client; full detail goes to
 * stderr.
 */
function sanitizeLoginError(err: unknown): string {
  if (err instanceof ModelsError) {
    if (err.code === "oauth") {
      return "OAuth authentication failed. Please sign in again.";
    }
    if (err.code === "auth") {
      return "Authentication failed. Check your credentials and try again.";
    }
  }
  return "Login failed.";
}
