# Hydra Daemon Protocol

Version `1`.

## Transport

Newline-delimited JSON over **stdin** (requests) and **stdout** (results and events).
One message per line.  All diagnostic/log output goes to **stderr**.

## Message shapes

### Request (client → daemon)

```json
{ "id": "<string>", "type": "<command>", ...params }
```

`id` must be a non-empty **string**.  Requests with a missing or non-string `id` are
rejected with `{id: null, type: "error", error: {"code": "bad_request", "message": "..."}}` and are not dispatched.

### Result (daemon → client)

```json
{ "id": "<string>", "type": "result", "result": <payload> }
```

### Error (daemon → client)

```json
{ "id": "<string|null>", "type": "error", "error": { "code": "<string>", "message": "<string>" } }
```

`id` is `null` when:
- the request line is not valid JSON (`parse_error`), or
- the request `id` field is missing or is not a string (`bad_request`).

### Event (daemon → client, unsolicited)

```json
{ "type": "event", "event": "<name>", ...payload }
```

Events are emitted at any time; they are not responses to a specific request.

---

## Commands

### `hello`

Identify the daemon.

**Request**
```json
{ "id": "1", "type": "hello" }
```

**Result**
```json
{
  "protocolVersion": "1",
  "daemonVersion": "0.1.0",
  "tools": ["web_search", "fetch_content", "get_search_content"]
}
```

`tools` lists the names of every tool available to bots.  The three web tools
(`web_search`, `fetch_content`, `get_search_content`) are always present in v1.
Connector tools (`mcp__<connector>__<tool>`) and `tool_search` are dynamic: they exist only
while a connector is connected, so they are not listed here.

---

### `models.list`

List the chat models offered for new bots. Currently Claude Sonnet 5.5 only
(Haiku 4.5 and Opus are not offered); the allow list lives in `daemon/src/models.ts`.

**Request**
```json
{ "id": "1", "type": "models.list" }
```

**Result** – array of model descriptors:
```json
[
  {
    "provider": "anthropic",
    "modelId": "claude-sonnet-5-5",
    "name": "Claude Sonnet 5.5",
    "default": true
  }
]
```

---

### `bots.list`

List all bots.

**Request**
```json
{ "id": "1", "type": "bots.list" }
```

**Result** – array of bot objects:
```json
[
  {
    "id": "2",
    "name": "My Bot",
    "instructions": "Be concise.",
    "model": "anthropic/claude-sonnet-5-5",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "lastMessagePreview": "Hello there!",
    "lastMessageAt": "2025-01-02T00:00:00.000Z"
  }
]
```

---

### `bots.create`

Create a new bot backed by a fresh pi-durable conversation.

**Request**
```json
{
  "id": "1",
  "type": "bots.create",
  "name": "My Bot",
  "instructions": "You are a helpful assistant.",
  "model": "anthropic/claude-sonnet-5-5"
}
```

`model` is optional; omitting it uses the daemon default (`anthropic/claude-sonnet-5-5`).
Format: `"provider/modelId"`.
Any model that `models.list` does not offer (including unregistered providers or models) is rejected with `bad_request`.
Existing bots keep their stored model.

**Result** – the created bot object (same shape as `bots.list` items).

**Side-effects**:
1. Emits a `bot.updated` event immediately.
2. **Intro turn** (signed-in only): if the provider has usable credentials, the
   daemon automatically submits an intro prompt so the bot introduces itself.
   The app receives `message.started`, `message.delta`, and `message.completed`
   events — and `bot.activity` events — for the new bot with **no** preceding
   `bots.send`.  The trigger message is hidden: it never appears in
   `bots.history` results.  When the provider has no credentials the intro is
   silently skipped; no `bot.error` is emitted.

---

### `bots.history`

Retrieve the text-only message history of a bot.

**Request**
```json
{ "id": "1", "type": "bots.history", "botId": "2" }
```

**Result** – array of message objects, oldest first:
```json
[
  {
    "id": "101",
    "role": "user",
    "text": "Hello",
    "createdAt": "2025-01-01T00:00:00.000Z"
  },
  {
    "id": "102",
    "role": "assistant",
    "text": "Hi! How can I help?",
    "createdAt": "2025-01-01T00:00:01.000Z"
  }
]
```

Only `user` and `assistant` roles are returned.  `createdAt` is an ISO 8601 timestamp
derived from the pi-ai message's `timestamp` field.

---

### `bots.send`

Send a user message to a bot.

**Request**
```json
{
  "id": "1",
  "type": "bots.send",
  "botId": "2",
  "text": "Hello!",
  "clientMessageId": "msg-uuid-1"
}
```

`clientMessageId` is used as a pi-durable `requestId` for idempotent delivery:
submitting the same `clientMessageId` twice delivers the message exactly once.
If the bot is busy, the message is queued as a follow-up.

**Result**
```json
{ "accepted": true }
```

The response is returned immediately; actual streaming events follow asynchronously.

**Auth failure** – if the provider has no usable credential (no stored credential,
no ambient env var, or a failed OAuth refresh), `bots.send` returns
`{ "accepted": false }` and immediately emits a `bot.error` event with
`code: "auth_required"`.  The app should show a login prompt rather than
retrying the send.

```json
{
  "type": "event",
  "event": "bot.error",
  "botId": "2",
  "code": "auth_required",
  "message": "No credentials configured for provider \"anthropic\". Use auth.setApiKey or auth.login."
}
```

---

### `bots.stop`

Abort the current bot reply.

**Request**
```json
{ "id": "1", "type": "bots.stop", "botId": "2" }
```

**Result**
```json
{ "stopped": true }
```

---

### `auth.status`

Report the configured credential for each known provider.  Never returns secrets.

**Request**
```json
{ "id": "1", "type": "auth.status" }
```

**Result**
```json
{
  "providers": [
    {
      "providerId": "anthropic",
      "type": "api_key",
      "source": "stored"
    }
  ]
}
```

`type` is `"oauth"`, `"api_key"`, or `null` (not configured).  
`source` indicates how the credential is resolved:
- `"stored"` – a credential is persisted in `credentials.json`.
- `"env"` – the provider reads an environment variable (e.g. `ANTHROPIC_API_KEY`); nothing is stored on disk.

`source` is omitted when `type` is `null`.

---

### `auth.login`

Start an interactive login flow.  Returns a `loginId` immediately; subsequent
events (`auth.url`, `auth.prompt`, `auth.completed` / `auth.failed`) are emitted
asynchronously.  The daemon **never** opens the browser — it emits `auth.url` so
the app can open it.

**Request**
```json
{ "id": "1", "type": "auth.login", "providerId": "anthropic", "loginType": "oauth" }
```

`loginType` is optional and defaults to `"oauth"`.  Accepted values: `"oauth"` \| `"api_key"`.

**Result**
```json
{ "loginId": "<uuid>" }
```

---

### `auth.respond`

Respond to a pending `auth.prompt` event.

**Request**
```json
{ "id": "1", "type": "auth.respond", "loginId": "<uuid>", "promptId": "<uuid>", "value": "user-input" }
```

**Result**
```json
{ "accepted": true }
```

---

### `auth.cancel`

Cancel an in-flight login.  Emits `auth.failed` as a side-effect.

**Request**
```json
{ "id": "1", "type": "auth.cancel", "loginId": "<uuid>" }
```

**Result**
```json
{ "cancelled": true }
```

---

### `auth.setApiKey`

Persist an API key for a provider.  The key is stored in `credentials.json`
(mode 0600); it is never echoed back in any response or event.

**Request**
```json
{ "id": "1", "type": "auth.setApiKey", "providerId": "anthropic", "apiKey": "sk-…" }
```

**Result**
```json
{ "stored": true }
```

---

### `auth.logout`

Remove the stored credential for a provider.

**Request**
```json
{ "id": "1", "type": "auth.logout", "providerId": "anthropic" }
```

**Result**
```json
{ "loggedOut": true }
```

---

### `connectors.list`

List the MCP connectors. The list is fixed (`sentry`, `notion`, `swarmia`, `amplitude`) and belongs to the
account: every bot can use every connected connector.

**Request**
```json
{ "id": "1", "type": "connectors.list" }
```

**Result**
```json
[
  { "id": "sentry", "name": "Sentry", "status": "connected" },
  { "id": "notion", "name": "Notion", "status": "signed_out", "error": "Sign-in timed out. Try again." }
]
```

`status` is one of `signed_out`, `connecting`, `connected`, `needs_sign_in`
(stored credentials were refused, including a refused token refresh) or `error`.
`error` is a short user-facing string, present for `error` and after a failed or
timed-out sign-in; raw upstream text is never included. Stored connectors
reconnect in the background at daemon start (`connecting`, then `connected`). A connector that fails for a non-auth reason (offline, a 5xx) stays `error` with its message while the daemon retries in the background (5 s, doubling, capped at 5 min), and moves to `connected` on success.

---

### `connectors.signIn`

Start the browser sign-in for a connector. Returns once the flow is under way; the
sign-in URL arrives as `connector.signInUrl` and the outcome as `connector.updated`.
Only one sign-in runs at a time. A sign-in with no browser callback within 5 minutes
returns the connector to `signed_out` with an error.

**Request**
```json
{ "id": "1", "type": "connectors.signIn", "connectorId": "sentry" }
```

**Result**
```json
{ "accepted": true }
```

Errors: `bad_request` (missing `connectorId`), `unknown_connector`, `sign_in_busy`
(another sign-in is pending), `port_busy` (the fixed loopback callback port 47619
is in use), `sign_in_failed`.

---

### `connectors.signOut`

Delete the stored credentials for a connector and close its connection.

**Request**
```json
{ "id": "1", "type": "connectors.signOut", "connectorId": "sentry" }
```

**Result**
```json
{ "signedOut": true }
```

Errors: `bad_request`, `unknown_connector`.

---

### `schedule_message`

Ask a bot to send a check-in message at a future time or on a recurring schedule.
This tool is available to every bot; the bot calls it when the user asks it to
check in or send something later.

Tool parameters (sent by the model, not by the app):

| Field | Type | Required | Description |
|---|---|---|---|
| `what` | string | ✓ | What the bot should do or say when the check-in fires. |
| `kind` | `"every"` \| `"daily"` \| `"once"` | ✓ | Schedule type. |
| `every_minutes` | number | for `every` | Interval in minutes between fires. |
| `time` | string `"HH:MM"` | for `daily` | Local 24-hour time. |
| `weekdays_only` | boolean | optional for `daily` | Skip Saturday and Sunday. |
| `at` | string | for `once` | `"HH:MM"` (next occurrence today/tomorrow) or `"YYYY-MM-DDTHH:MM"` (local date-time). |
| `in_minutes` | number | for `once` | Fire after this many minutes from now. |

The tool returns a schedule id, a one-line summary, and the next run time in local
time, or an error message the model can read.

Production limits: minimum interval 1 minute, at most 5 active schedules per bot.

**Consent-first rule.** `schedule_message` and `watch_ci` only run when the
conversation's latest user-role input is a real user message. If it starts with
`[Hydra ` (the hidden intro, check-in and CI wake messages), the tool
returns an error result — "Not started: the user hasn't asked for this yet. Tell
them what you'd set up and ask them to confirm first." — and creates no task or
document. `list_schedules`, `cancel_schedule` and `stop_watching_ci` are always
allowed. Existing schedules and watchers are unaffected.

---

### `list_schedules`

List this bot's active scheduled check-ins.

Tool parameters: none.

Returns: one line per active schedule with id, rule summary, next run time, and
what the bot will do.

---

### `cancel_schedule`

Cancel an active scheduled check-in by its id.

Tool parameters:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | number | ✓ | The schedule id returned by `schedule_message` or `list_schedules`. |

Rejects unknown ids and ids that belong to a different bot.

---

### `watch_ci`

Watch CI on the user's own open and draft GitHub PRs (requires the `gh` CLI,
installed and logged in). Polls once a minute and wakes the bot with a hidden
`[Hydra CI]` message only when a check newly fails (the first poll sends one
summary of everything currently failing). One watcher per bot. Subject to the
consent-first rule described under `schedule_message`.

| Argument | Type | Required | Description |
|---|---|---|---|
| `include_logs` | boolean | | Stored for opt-in failed-job logs. |

### `stop_watching_ci`

Stop the bot's CI watcher. Takes no arguments.

---

## Scheduled check-in turns

When a scheduled check-in fires, it submits a hidden user message to the bot's
conversation (starting with `[Hydra check-in]`) and the bot generates a reply.
This produces the same sequence of events as a `bots.send` turn:

- `message.started`
- `message.delta` (zero or more)
- `message.completed`
- `bot.updated`

**No `bots.send` request is involved.**  The app does not need to distinguish
between user-initiated turns and check-in turns; both appear as `message.*` events
and are stored in the bot's conversation history.  The hidden check-in trigger
message is filtered out of `bots.history` results.

A schedule survives quitting and relaunching the app; the durable task resumes
automatically when the daemon restarts.

---

## Silent replies (`NO_REPLY`)

A bot can stay silent by replying with exactly the word `NO_REPLY` (trimmed).
When the daemon sees this sentinel:

- No `message.started`, `message.delta`, or `message.completed` events are emitted.
- The same applies to text-less assistant turns (e.g. a tool call with no
  accompanying text): they emit no `message.*` events and leave the preview
  unchanged, so `message.completed` fires only for turns with visible text.
- `lastMessagePreview` and `lastMessageAt` are **not** updated.
- The entry is **omitted** from `bots.history` results.
- `bot.activity` still transitions back to `idle` as normal.

This lets a bot decline to reply to a scheduled check-in (or any other trigger)
without surfacing noise in the UI.  The app needs no change; unread counts and
notifications are driven by `message.completed`, which is simply absent.

---

## Events

Events are emitted for **every** assistant message in **every** bot conversation,
not only replies to `bots.send`.  Future proactive messages require no protocol change.

### `bot.updated`

Emitted when a bot's metadata changes (creation, last-message update).

```json
{
  "type": "event",
  "event": "bot.updated",
  "bot": { ...bot object... }
}
```

### `message.started`

Emitted when the model starts generating a new assistant message.

```json
{
  "type": "event",
  "event": "message.started",
  "botId": "2",
  "messageId": "msg-17200000-abc123"
}
```

`messageId` is a transient streaming id.  Use it to correlate `message.delta` and
`message.completed` events for the same generation.

### `message.delta`

Emitted for each text chunk streamed from the model.

```json
{
  "type": "event",
  "event": "message.delta",
  "botId": "2",
  "messageId": "msg-17200000-abc123",
  "text": "Hello"
}
```

### `message.completed`

Emitted when the assistant message is fully committed to storage.

```json
{
  "type": "event",
  "event": "message.completed",
  "botId": "2",
  "messageId": "msg-17200000-abc123",
  "message": {
    "id": "102",
    "role": "assistant",
    "text": "Hello! How can I help?",
    "createdAt": "2025-01-01T00:00:01.000Z"
  }
}
```

- **`messageId`** – streaming id, matches the `message.started` / `message.delta` events
  for this generation.
- **`message.id`** – durable entry id; the same value returned by `bots.history` for this
  message.  Numeric string assigned by the pi-durable storage layer.
- **`message.createdAt`** – ISO 8601 timestamp from the committed pi-ai `AssistantMessage`.

### `bot.activity`

Emitted when the bot's activity state changes.

```json
{
  "type": "event",
  "event": "bot.activity",
  "botId": "2",
  "activity": "thinking"
}
```

When `activity` is `"tool"`, two additional fields are present:

```json
{
  "type": "event",
  "event": "bot.activity",
  "botId": "2",
  "activity": "tool",
  "tool": "web_search",
  "label": "Searching the web"
}
```

`activity` values:
- `"thinking"` – the model is generating a response.
- `"tool"` – a tool call is in progress; `tool` is the registered tool name and
  `label` is a short human-readable description for the UI:
  - `web_search` → `"Searching the web"`
  - `fetch_content` (1 URL) → `"Reading <hostname>"`
  - `fetch_content` (N URLs) → `"Reading N pages"`
  - `get_search_content` → `"Reading saved results"`
- `"idle"` – the bot is idle (run ended).

### `bot.error`

Emitted when an unrecoverable error occurs during a run.

```json
{
  "type": "event",
  "event": "bot.error",
  "botId": "2",
  "code": "auth_required",
  "message": "Anthropic API key is missing or invalid."
}
```

`code` values:
- `"auth_required"` – missing or invalid credentials.
- `"generation_failed"` – other model/generation failure.

`message` is always a stable, user-facing string.  Raw upstream error strings
(HTTP response bodies, provider error details) are never surfaced in this event.

---

## Error codes

| Code | Meaning |
|---|---|
| `parse_error` | The request line is not valid JSON. |
| `bad_request` | The request is missing a required field (including `id`) or has invalid values. |
| `unknown_command` | The `type` field names a command that does not exist. |
| `not_found` | The referenced bot or conversation does not exist. |
| `internal_error` | An unexpected error occurred in the daemon. |
| `auth_required` | A credential is missing; re-configure and retry. |
| `unknown_connector` | `connectorId` is not a known connector. |
| `sign_in_busy` | Another connector sign-in is already pending. |
| `port_busy` | The connector sign-in callback port (47619) is in use. |
| `sign_in_failed` | The connector sign-in could not be started. |
| `unavailable` | Connectors are not available in this daemon. |

---

### `auth.url`

Emitted during an OAuth login when the user must visit a URL to authorise.  The
daemon never opens the browser; the app receives this event and opens it.

```json
{
  "type": "event",
  "event": "auth.url",
  "loginId": "<uuid>",
  "url": "https://claude.ai/oauth/authorize?...",
  "instructions": "Open this URL to sign in."
}
```

`instructions` is optional.

---

### `auth.info`

Informational message from the login flow (e.g. progress or status updates).

```json
{
  "type": "event",
  "event": "auth.info",
  "loginId": "<uuid>",
  "message": "Exchanging authorisation code…"
}
```

---

### `auth.prompt`

The login flow requires user input.  Respond with `auth.respond`.

```json
{
  "type": "event",
  "event": "auth.prompt",
  "loginId": "<uuid>",
  "promptId": "<uuid>",
  "kind": "manual_code",
  "message": "Paste the redirect URL or authorisation code:",
  "placeholder": "https://..."
}
```

`kind` values: `"text"` | `"secret"` | `"select"` | `"manual_code"`.
For `"select"` prompts, `options` is an array of `{ id, label, description? }` objects.

---

### `auth.completed`

The login flow succeeded and credentials are persisted.

```json
{
  "type": "event",
  "event": "auth.completed",
  "loginId": "<uuid>",
  "providerId": "anthropic"
}
```

---

### `auth.failed`

The login flow failed or was cancelled.

```json
{
  "type": "event",
  "event": "auth.failed",
  "loginId": "<uuid>",
  "message": "Login cancelled"
}
```

`message` is a stable, user-facing string.  Raw upstream error text (HTTP bodies,
OAuth token details) is never included.  Possible values:
- `"Login cancelled"` 
- `"OAuth authentication failed. Please sign in again."`
- `"Authentication failed. Check your credentials and try again."`
- `"Login failed."`

After `auth.cancel`, any later resolution or rejection of the same `loginId`
produces no further events.

---

### `connector.signInUrl`

Emitted during `connectors.signIn` when the user must visit a URL to authorise. The
daemon never opens the browser; the app opens it.

```json
{ "type": "event", "event": "connector.signInUrl", "connectorId": "sentry", "url": "https://…" }
```

---

### `connector.updated`

Emitted whenever a connector's status changes (`connector` has the shape of a
`connectors.list` entry).

```json
{
  "type": "event",
  "event": "connector.updated",
  "connector": { "id": "sentry", "name": "Sentry", "status": "connected" }
}
```
