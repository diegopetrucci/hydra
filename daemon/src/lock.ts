/**
 * lock.ts – single-instance PID lock for the Hydra daemon.
 *
 * acquireLock(dataDir): string
 *   Creates daemon.pid atomically using link().  If the file already exists and
 *   its PID is alive, throws LockError.  If the PID is dead (stale lock),
 *   verifies the file still names that PID, removes it, and retries once.
 *   Returns the lock-file path on success.
 *
 * releaseLock(lockPath): void
 *   Deletes the lock file only when it still names this process.  Idempotent.
 */

import { writeFileSync, readFileSync, unlinkSync, linkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_FILENAME = "daemon.pid";

/** Thrown when another daemon instance holds the lock. */
export class LockError extends Error {
  constructor(public readonly pid: number) {
    super(`Another Hydra daemon instance is already running (pid ${pid})`);
    this.name = "LockError";
  }
}

/**
 * Acquire the PID lock in `dataDir`.  Returns the lock-file path.
 * Throws `LockError` when a live foreign process holds the lock.
 */
export function acquireLock(dataDir: string): string {
  const lockPath = join(dataDir, LOCK_FILENAME);
  tryCreate(lockPath, false);
  return lockPath;
}

/**
 * Release the lock.  Only deletes the file when it still names this process
 * (prevents removing a lock that another instance has since acquired).
 * Idempotent on any error.
 */
export function releaseLock(lockPath: string): void {
  try {
    const pid = readPid(lockPath);
    if (pid === process.pid) {
      unlinkSync(lockPath);
    }
  } catch {
    // Already gone or unreadable; no-op.
  }
}

// ─── internals ────────────────────────────────────────────────────────────────

/**
 * Attempt to create the lock file atomically.
 *
 * Strategy:
 *  1. Write PID to a private temp file.
 *  2. Hard-link the temp file to lockPath
 *     (link() fails atomically with EEXIST if lockPath already exists).
 *  3. Clean up the temp file regardless.
 *
 * This ensures the lock file is never empty: it contains our PID as soon as it
 * becomes visible to other processes.
 */
function tryCreate(lockPath: string, isRetry: boolean): void {
  // Place the temp file in the same directory as daemon.pid so that link()
  // operates within one filesystem and cannot fail with EXDEV.
  const tmpPath = join(dirname(lockPath), `daemon-lock-${randomUUID()}.tmp`);
  writeFileSync(tmpPath, String(process.pid), { mode: 0o600 });
  try {
    linkSync(tmpPath, lockPath);
  } catch (e: unknown) {
    if (!isEnoent(e, "EEXIST")) throw e;
    // File already exists — inspect the recorded PID.
    handleExisting(lockPath, isRetry);
    return;
  } finally {
    try { unlinkSync(tmpPath); } catch { /* clean up regardless */ }
  }
}

function handleExisting(lockPath: string, isRetry: boolean): void {
  if (isRetry) {
    throw new Error(`Lock file still present after stale removal: ${lockPath}`);
  }

  const pid = readPid(lockPath);
  if (pid === null || pid === process.pid) {
    // Corrupt file or it's our own PID — remove and retry.
    try { unlinkSync(lockPath); } catch { /* may already be gone */ }
    tryCreate(lockPath, true);
    return;
  }

  // Check whether the recorded PID is alive.
  let alive = false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    alive = true;
  } catch {
    alive = false;
  }

  if (alive) {
    throw new LockError(pid);
  }

  // Stale lock from a dead process.
  // NOTE: the window between the readPid() above and the unlink() below is a
  // known non-atomic race (accepted spike risk): two processes could both see
  // the same dead PID and both attempt to remove and recreate the lock.  The
  // subsequent link() call is still atomic, so at most one wins.
  // Re-read the file to verify the dead PID is still there before removing it;
  // another process could have acquired the lock between our read and now.
  const currentPid = readPid(lockPath);
  if (currentPid !== pid) {
    // The lock was updated by another process between reads.  Retry from scratch
    // to observe the new state (isRetry=true prevents infinite recursion).
    tryCreate(lockPath, true);
    return;
  }

  try {
    unlinkSync(lockPath);
  } catch {
    // Another process might have removed it already.
  }
  tryCreate(lockPath, true);
}

function readPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isEnoent(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === code;
}
