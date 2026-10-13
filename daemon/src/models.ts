/**
 * The only place in the daemon that constructs pi-ai Models.
 *
 * createModels(credentials?)   → MutableModels (production; Anthropic only)
 * createTestModels(credentials?) → { models, faux } (tests; faux provider)
 *
 * The faux/fake model is never registered by createModels(); it is only
 * reachable through the exported createTestModels() helper, which must never
 * be called from production paths.
 *
 * The default model is claude-sonnet-5-5 on the anthropic provider.
 * Honours ANTHROPIC_API_KEY from the environment (pi-ai resolves it by default).
 * With a Claude OAuth token (sk-ant-oat...), pi-ai's Anthropic provider
 * (dist/api/anthropic-messages.js) sends a claude-cli user-agent, x-app: cli,
 * the claude-code-20250219 beta flag, a "You are Claude Code..." system prompt
 * line, and Claude Code tool names. API keys get none of this.
 */

import { createModels as piCreateModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

export type { CredentialStore };

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL_ID = "claude-sonnet-5-5";

/**
 * Anthropic models offered for new bots. Sonnet only for now (Diego, 13 Oct
 * 2026); Haiku 4.5 and Opus to be re-evaluated later. Existing bots keep
 * whatever model they were created with.
 */
export const OFFERED_ANTHROPIC_MODEL_IDS: readonly string[] = [DEFAULT_MODEL_ID];

/**
 * Whether a model may be listed and used for new bots. The allow list applies
 * to the anthropic provider only, so the test-only faux provider is unaffected.
 */
export function isOfferedModel(provider: string, modelId: string): boolean {
  return provider !== DEFAULT_PROVIDER || OFFERED_ANTHROPIC_MODEL_IDS.includes(modelId);
}

/** Build a production Models collection backed by the Anthropic provider. */
export function createModels(credentials?: CredentialStore): MutableModels {
  const store = credentials ?? new InMemoryCredentialStore();
  const models = piCreateModels({ credentials: store });
  // Register bundled OAuth flow handlers so that the Anthropic OAuth sign-in
  // works inside the esbuild bundle (dist/daemon.mjs). Without this call,
  // pi-ai's lazyOAuth tries to dynamic-import("./anthropic.ts") relative to
  // import.meta.url, which bundlers cannot follow, causing auth.failed
  // "Login failed." immediately. registerBunOAuthFlows() provides statically
  // imported flow loaders that work at bundle time.
  registerBunOAuthFlows();
  models.setProvider(anthropicProvider());
  return models;
}

/**
 * Build a test Models collection backed only by the pi-ai faux provider.
 * Must never be called from production code paths.
 */
export async function createTestModels(credentials?: CredentialStore): Promise<{
  models: MutableModels;
  faux: import("@earendil-works/pi-ai/providers/faux").FauxProviderHandle;
}> {
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  const store = credentials ?? new InMemoryCredentialStore();
  const models = piCreateModels({ credentials: store });
  // tokensPerSecond: 3 forces setTimeout delays (instead of microtasks) so that
  // pi-durable's progress committer can commit partial answers and emit
  // message_update / text_delta agent events during the response.
  // tokenSize:{min:1,max:1} streams one character per token for max granularity.
  const faux = fauxProvider({ tokensPerSecond: 3, tokenSize: { min: 1, max: 1 } });
  models.setProvider(faux.provider);
  return { models, faux };
}
