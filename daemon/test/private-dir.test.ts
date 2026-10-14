import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateDir } from "../src/private-dir.js";
import { ensureWebAccessDir } from "../src/web-tools.js";

const mode = (p: string): number => statSync(p).mode & 0o777;

describe("private dirs", () => {
  let root: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hydra-private-"));
    savedEnv = process.env["PI_CODING_AGENT_DIR"];
    delete process.env["PI_CODING_AGENT_DIR"];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = savedEnv;
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a new dir as 0700", () => {
    const dir = join(root, "a", "b");
    ensurePrivateDir(dir);
    expect(existsSync(dir)).toBe(true);
    expect(mode(dir)).toBe(0o700);
  });

  it("tightens an existing 0755 dir to 0700", () => {
    const dir = join(root, "existing");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it("ensureWebAccessDir tightens an existing 0755 web-access dir", () => {
    const dir = join(root, "web-access");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensureWebAccessDir(root);
    expect(mode(dir)).toBe(0o700);
    expect(process.env["PI_CODING_AGENT_DIR"]).toBe(dir);
  });
});
