/**
 * credential-store.ts
 *
 * File-backed CredentialStore for Hydra. Stores credentials in
 * <dataDir>/credentials.json with mode 0600. Atomic writes use a temp
 * file + rename on the same filesystem. Writes are serialized per provider
 * through a promise chain so concurrent modify() calls never corrupt data.
 *
 * Never reads or writes ~/.pi/agent/auth.json or any other pi-ai path.
 * Never logs or returns secret values.
 */

import { readFile, writeFile, rename, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

interface StoredCredentialFile {
  credentials: Record<string, Credential>;
}

export class FileCredentialStore implements CredentialStore {
  /** Absolute path to credentials.json – exposed for tests only. */
  readonly path: string;

  /**
   * Global write serialisation chain.
   *
   * Each write rewrites the entire credentials.json file, so two concurrent
   * writes for different providers would race and corrupt each other.  A single
   * global chain prevents that: every enqueued write task runs after the
   * previous one settles, regardless of which provider it targets.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, "credentials.json");
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const file = await this.load();
    return file.credentials[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const file = await this.load();
    return Object.entries(file.credentials).map(([providerId, cred]) => ({
      providerId,
      type: cred.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      options?.signal?.throwIfAborted();
      const file = await this.load();
      const current = file.credentials[providerId];
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        file.credentials[providerId] = next;
        await this.save(file);
        return next;
      }
      // fn returned undefined → leave unchanged, return current value.
      return current;
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(providerId, async () => {
      options?.signal?.throwIfAborted();
      const file = await this.load();
      if (!(providerId in file.credentials)) return;
      delete file.credentials[providerId];
      await this.save(file);
    });
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private async load(): Promise<StoredCredentialFile> {
    if (!existsSync(this.path)) {
      return { credentials: {} };
    }
    // Make an existing file private before reading it; if that is impossible,
    // do not read its contents.
    try {
      await chmod(this.path, 0o600);
    } catch {
      process.stderr.write(
        "[hydra-daemon] credentials.json permissions could not be restricted; ignoring it.\n",
      );
      return { credentials: {} };
    }
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch {
      // Unreadable file (permissions etc.); treat as empty without quarantine.
      return { credentials: {} };
    }
    try {
      const parsed = JSON.parse(raw) as StoredCredentialFile;
      if (!parsed || typeof parsed.credentials !== "object" || parsed.credentials === null) {
        // Valid JSON but wrong shape 	at treat as corrupt.
        throw new SyntaxError("credentials.json: unexpected shape");
      }
      return parsed;
    } catch {
      // Corrupt JSON or wrong shape: quarantine the file instead of silently
      // overwriting it on the next save.
      await this.quarantine();
      return { credentials: {} };
    }
  }

  /**
   * Rename credentials.json aside to credentials.json.corrupt-<timestamp> so
   * the next save does not silently destroy it.  Sets mode 0600 on the
   * quarantined file.  Logs a one-line notice to stderr (no file contents).
   */
  private async quarantine(): Promise<void> {
    const dest = `${this.path}.corrupt-${Date.now()}`;
    try {
      await chmod(this.path, 0o600);
      await rename(this.path, dest);
      process.stderr.write(
        `[hydra-daemon] credentials.json could not be parsed; ` +
          `renamed to ${dest}. Starting with empty credentials.\n`,
      );
    } catch {
      // If quarantine itself fails (e.g. concurrent deletion), just continue.
    }
  }

  private async save(file: StoredCredentialFile): Promise<void> {
    const tmpPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    await rename(tmpPath, this.path);
    // Enforce 0600 even when the file was first created by a different code path.
    await chmod(this.path, 0o600);
  }

  /**
   * Serialise fn globally: fn runs after every previously enqueued task
   * settles.  Because each write rewrites credentials.json wholesale, a per-
   * provider chain is insufficient
   *
   * @param _providerId kept for call-site readability only.
   */
  private enqueue<T>(_providerId: string, fn: () => Promise<T>): Promise<T> {
    const chain = this.chain;
    let resolveOuter!: (v: T) => void;
    let rejectOuter!: (e: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    });
    const next = chain.then(
      () => fn().then(resolveOuter, rejectOuter),
      () => fn().then(resolveOuter, rejectOuter),
    );
    // Advance the global chain; drop the resolved value.
    this.chain = next.then(
      () => {},
      () => {},
    );
    return result;
  }
}
