/**
 * pi-web-access-web-tools-stub.d.ts
 *
 * TypeScript stub for @diegopetrucci/pi-web-access/web-tools.ts.
 *
 * tsconfig.json `paths` redirects TypeScript to this file instead of
 * following into the real TypeScript source in node_modules (which fails
 * strict-mode checks against our tsconfig settings).
 *
 * esbuild does NOT read tsconfig paths; it resolves the import through
 * Node.js resolution and bundles the real source from node_modules.
 * Vitest (without vite-tsconfig-paths) also follows Node.js resolution at
 * runtime, so the real source is executed in tests.
 */

/** Minimal fetch-compatible override used in tests to avoid real network calls. */
export interface WebToolsOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch?: (...args: any[]) => Promise<any>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const registerWebTools: (pi: any, options?: WebToolsOptions) => void;
export default registerWebTools;
