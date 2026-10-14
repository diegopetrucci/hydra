/**
 * describe-error.ts – Safe error description for log lines.
 *
 * Kept in its own module so tests can import it without importing main.ts
 * (which calls main() at module scope and would touch the data directory).
 */

import type { ModelsErrorCode } from "@earendil-works/pi-ai";

const MODELS_ERROR_CODES: readonly ModelsErrorCode[] = [
  "model_source",
  "model_validation",
  "provider",
  "stream",
  "auth",
  "oauth",
];

/** The only codes ever copied into error text; anything else is upstream-controlled. */
const ALLOWED_CODES: ReadonlySet<string> = new Set([
  // Node system codes
  "ENOENT",
  "EACCES",
  "EPERM",
  "EEXIST",
  "ENOTDIR",
  "EISDIR",
  "ENOTEMPTY",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EBUSY",
  "EROFS",
  "EINVAL",
  "EIO",
  "EPIPE",
  "EAGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  // RFC 6749 / 6750 OAuth errors
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "unsupported_response_type",
  "server_error",
  "temporarily_unavailable",
  "invalid_token",
  "insufficient_scope",
  // pi-ai ModelsError
  ...MODELS_ERROR_CODES,
  // ConnectorError (connectors.ts)
  "not_connected",
  "sign_in_busy",
  "sign_in_failed",
  "unknown_connector",
  "port_busy",
  "superseded",
]);

/**
 * Returns a concise, safe description of an error for log lines: the
 * constructor name plus the `code` property when it is on the fixed allowlist.
 * The raw `message` is intentionally excluded because it may contain secrets,
 * HTTP response bodies, or upstream URLs.
 *
 * Exported so that tests can verify the no-secret guarantee directly
 * without importing main.ts.
 */
export function describeError(e: unknown): string {
  const errClass = e instanceof Error ? e.constructor.name : "Error";
  const code = (e as { code?: unknown })?.code;
  // `code` can be an arbitrary upstream string (e.g. an OAuth token endpoint's
  // `error` field), so only allowlisted codes are copied.
  const errCode = typeof code === "string" && ALLOWED_CODES.has(code) ? ` code=${code}` : "";
  return `${errClass}${errCode}`;
}
