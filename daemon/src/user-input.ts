import { UserEntry } from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { TextContent, UserMessage } from "@earendil-works/pi-ai";
import { HYDRA_MARKER_PREFIX } from "./schedules.js";

/** Tool-result text returned when a proactive tool is called without a real user request. */
export const NOT_REQUESTED_TEXT =
  "Not started: the user hasn't asked for this yet. Tell them what you'd set up and ask them to confirm first.";

function userText(msg: UserMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  return c
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Pure decision on one UserEntry's model messages: human only when the LAST
 * message is a user-role message whose text is non-empty and lacks the marker
 * prefix. Empty model, non-user role, or no text all fail closed.
 */
export function modelMessagesAreHuman(model: readonly unknown[] | undefined): boolean {
  if (!model || model.length === 0) return false;
  const last = model[model.length - 1] as { role?: string } | undefined;
  if (!last || last.role !== "user") return false;
  const text = userText(last as UserMessage);
  return text.length > 0 && !text.startsWith(HYDRA_MARKER_PREFIX);
}

/**
 * True when the conversation's newest user-role entry is a real human message
 * (not a Hydra hidden trigger: intro, check-in or CI wake).
 *
 * Why a transcript scan: ToolExecutionApi exposes no entry reader, but the tool's
 * `commit` gives a Tx whose `scanEntries` walks the conversation's visible history
 * newest-first. The triggering input is appended before the model turn that calls
 * the tool, so the newest UserEntry is always the input driving the current turn;
 * tool results and assistant entries are other kinds and are skipped.
 * Fails closed: no user entry, or an unusable newest one, means not human.
 */
export async function latestUserInputIsHuman(
  api: ToolExecutionApi,
  ctx: Context,
): Promise<boolean> {
  return api.commit(async (tx) => {
    let cursor: Parameters<typeof tx.scanEntries>[2];
    do {
      const page = await tx.scanEntries({ conversationId: api.conversationId }, 50, cursor);
      for (const entry of page.items) {
        // Decide on the newest UserEntry only; never skip to an older one.
        if (UserEntry.is(entry)) return modelMessagesAreHuman(entry.model);
      }
      cursor = page.next;
    } while (cursor);
    return false;
  }, ctx);
}

/**
 * True when ANY user-role entry in the conversation is a real human message,
 * not only the newest. Used by consent-first tools that may also run on a later
 * scheduled check-in or CI wake, which a human set up earlier. Fails closed:
 * no human entry found means false.
 */
export async function conversationHasHumanInput(
  api: ToolExecutionApi,
  ctx: Context,
): Promise<boolean> {
  return api.commit(async (tx) => {
    let cursor: Parameters<typeof tx.scanEntries>[2];
    do {
      const page = await tx.scanEntries({ conversationId: api.conversationId }, 50, cursor);
      for (const entry of page.items) {
        if (UserEntry.is(entry) && modelMessagesAreHuman(entry.model)) return true;
      }
      cursor = page.next;
    } while (cursor);
    return false;
  }, ctx);
}
