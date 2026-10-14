/**
 * Custom pi-durable document definitions for Hydra, plus the shared
 * metaToBotInfo helper used by both daemon-core and bot-watcher.
 *
 * BotsRegistryDoc – session-scoped; maps conversation-id → bot metadata.
 *
 * Types use only JSON-primitive-compatible shapes so they satisfy the
 * pi-durable `JsonObject` constraint (`{ [key: string]: JsonValue }`).
 * StoredBotMeta is cast to/from the doc values at call sites.
 */

import { defineDoc } from "@earendil-works/pi-durable";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER } from "./models.js";
import type { BotInfo } from "./protocol.js";
import { formatModelRef } from "./protocol.js";

/** Typed view of one stored bot.  All values are strings so the record is a JsonValue. */
export interface StoredBotMeta {
  name: string;
  createdAt: string;
  /** pi-ai provider id, e.g. "anthropic". */
  provider: string;
  /** pi-ai model id, e.g. "claude-sonnet-5-5". */
  modelId: string;
  instructions: string;
  lastMessagePreview: string;
  lastMessageAt: string;
}

/**
 * A flat string-to-string map satisfies JsonValue:
 *   Record<string, string> ≈ { [key: string]: string } ≈ { [key: string]: JsonValue }
 *
 * The stored value for each bot is Record<string, string>; we cast to/from
 * StoredBotMeta at call sites.
 */
export const BotsRegistryDoc = defineDoc<{ bots: Record<string, Record<string, string>> }>({
  kind: "hydra.bots-registry",
  version: 1,
  scope: "session",
  initial: () => ({ bots: {} }),
});

// ─── Serialisation helpers ────────────────────────────────────────────────────

export function metaToRecord(meta: StoredBotMeta): Record<string, string> {
  return {
    name: meta.name,
    createdAt: meta.createdAt,
    provider: meta.provider,
    modelId: meta.modelId,
    instructions: meta.instructions,
    lastMessagePreview: meta.lastMessagePreview,
    lastMessageAt: meta.lastMessageAt,
  };
}

export function recordToMeta(rec: Record<string, string>): StoredBotMeta {
  return {
    name: rec["name"] ?? "",
    createdAt: rec["createdAt"] ?? "",
    provider: rec["provider"] ?? "",
    modelId: rec["modelId"] ?? "",
    instructions: rec["instructions"] ?? "",
    lastMessagePreview: rec["lastMessagePreview"] ?? "",
    lastMessageAt: rec["lastMessageAt"] ?? "",
  };
}

/**
 * Convert stored bot metadata to the protocol's BotInfo shape.
 * Shared by daemon-core and bot-watcher so there is one source of truth
 * for fallback provider/model values.
 */
export function metaToBotInfo(id: string, meta: StoredBotMeta): BotInfo {
  return {
    id,
    name: meta.name,
    instructions: meta.instructions,
    model: formatModelRef(meta.provider || DEFAULT_PROVIDER, meta.modelId || DEFAULT_MODEL_ID),
    createdAt: meta.createdAt,
    lastMessagePreview: meta.lastMessagePreview,
    lastMessageAt: meta.lastMessageAt,
  };
}
