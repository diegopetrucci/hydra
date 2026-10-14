/**
 * ambient.d.ts – Minimal ambient module declarations for packages that are
 * either type-only dependencies or whose TypeScript source is deep-imported
 * for esbuild bundling.
 */

// @earendil-works/pi-coding-agent is referenced only as `import type` inside
// @diegopetrucci/pi-web-access (web-tools.ts and index.ts). The package is not
// installed at runtime; this declaration satisfies tsc without requiring it.
declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerTool(tool: Record<string, unknown>): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
    appendEntry(kind: string, data: unknown): void;
  }
  export type ExtensionContext = Record<string, unknown>;
}

// @diegopetrucci/pi-web-access ships TypeScript source with no export map.
// esbuild resolves this path to the real .ts file in node_modules and bundles
// it; TypeScript uses this declaration instead of following into the source.
declare module "@diegopetrucci/pi-web-access/web-tools.ts" {
  type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  export interface WebToolsOptions {
    fetch?: FetchLike;
  }
  function registerWebTools(
    pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
    options?: WebToolsOptions,
  ): void;
  export default registerWebTools;
}
