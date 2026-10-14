import { chmodSync, mkdirSync } from "node:fs";

/** Create `dir` (and parents) and ensure it is mode 0700, even if it already existed. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
