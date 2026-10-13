/**
 * connector-store.ts
 *
 * File-backed OAuth state for MCP connectors: <dataDir>/connectors.json, mode
 * 0600, keyed by connector id. Same write discipline as credential-store.ts
 * (global write chain, temp file + rename, chmod 0600). Never logs contents.
 */

import { readFile, writeFile, rename, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { McpOAuthState, McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";

interface ConnectorFile {
  connectors: Record<string, McpOAuthState>;
}

export class FileConnectorStore {
  /** Absolute path to connectors.json – exposed for tests only. */
  readonly path: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, "connectors.json");
  }

  /** pi-mcp state store for one connector. */
  forConnector(id: string, allowWrite: () => boolean = () => true): McpOAuthStateStore {
    return {
      load: async () => (await this.load()).connectors[id],
      save: (state) =>
        this.enqueue(async () => {
          // Checked when the write runs, so a superseded owner's late save is dropped.
          if (!allowWrite()) return;
          const file = await this.load();
          file.connectors[id] = state;
          await this.save(file);
        }),
    };
  }

  /** Ids that hold an access or refresh token. */
  async signedInIds(): Promise<string[]> {
    const file = await this.load();
    return Object.entries(file.connectors)
      .filter(([, s]) => s.tokens !== undefined)
      .map(([id]) => id);
  }

  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      const file = await this.load();
      if (!(id in file.connectors)) return;
      delete file.connectors[id];
      await this.save(file);
    });
  }

  private async load(): Promise<ConnectorFile> {
    if (!existsSync(this.path)) return { connectors: {} };
    // Make an existing file private before reading it; if that is impossible,
    // do not read its contents.
    try {
      await chmod(this.path, 0o600);
    } catch {
      process.stderr.write("[hydra-daemon] connectors.json permissions could not be restricted; ignoring it.\n");
      return { connectors: {} };
    }
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch {
      return { connectors: {} };
    }
    try {
      const parsed = JSON.parse(raw) as ConnectorFile;
      if (!parsed || typeof parsed.connectors !== "object" || parsed.connectors === null) {
        throw new SyntaxError("unexpected shape");
      }
      return parsed;
    } catch {
      // Quarantine instead of silently overwriting on the next save.
      const dest = `${this.path}.corrupt-${Date.now()}`;
      try {
        await chmod(this.path, 0o600);
        await rename(this.path, dest);
        process.stderr.write(
          `[hydra-daemon] connectors.json could not be parsed; renamed to ${dest}.\n`,
        );
      } catch {
        process.stderr.write("[hydra-daemon] connectors.json could not be quarantined.\n");
      }
      return { connectors: {} };
    }
  }

  private async save(file: ConnectorFile): Promise<void> {
    const tmpPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    await rename(tmpPath, this.path);
    await chmod(this.path, 0o600);
  }

  /** Run fn after every previously enqueued write settles. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(() => {}, () => {});
    return result;
  }
}
