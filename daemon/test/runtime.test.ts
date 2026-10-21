import { describe, expect, it } from "vitest";
import { mkdtemp, copyFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isSupportedNode, NODE_REQUIREMENT } from "../src/runtime.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("Node security runtime requirement", () => {
  it.each([
    "22.23.4",
    "22.23.5",
    "22.24.0",
    "24.22.1",
    "24.22.2",
    "24.23.0",
    "26.12.1",
    "26.12.2",
    "26.13.0",
  ])("accepts patched Node %s", (version) => {
    expect(isSupportedNode(version)).toBe(true);
  });

  it.each([
    "22.19.0",
    "22.23.3",
    "22.22.99",
    "24.22.0",
    "24.21.99",
    "26.12.0",
    "26.11.99",
    "20.99.0",
    "23.99.0",
    "25.99.0",
    "27.0.0",
    "28.0.0",
    "26.12.1-rc.1",
    "26.12",
    "v26.12.1",
    "26.12.1garbage",
    "",
  ])("rejects unsafe or unsupported Node %s", (version) => {
    expect(isSupportedNode(version)).toBe(false);
  });

  it("keeps the npm requirement aligned", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      engines: { node: string };
    };
    expect(packageJson.engines.node).toBe(NODE_REQUIREMENT);
  });

  it.each(["22.23.3", "24.22.0", "26.12.0", "26.12.1-rc.1", "27.0.0"])(
    "built bootstrap rejects %s before loading daemon dependencies or touching data",
    async (version) => {
      const dir = await mkdtemp(join(tmpdir(), "hydra-runtime-"));
      try {
        // Deliberately omit the implementation bundle and node_modules. Any eager
        // dependency load would fail before the expected runtime diagnostic.
        const entry = join(dir, "daemon.mjs");
        await copyFile(new URL("../dist/daemon.mjs", import.meta.url), entry);
        const preload = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`;
        const result = spawnSync(
          process.execPath,
          ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, entry],
          {
            env: { ...process.env, HYDRA_DATA_DIR: join(dir, "data") },
            encoding: "utf8",
            timeout: 5000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`Unsupported Node.js ${version}`);
        expect(result.stderr).toContain(NODE_REQUIREMENT);
        expect(result.stderr).toContain("HYDRA_NODE");
        expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
        await expect(access(join(dir, "data"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("serves the protocol and shuts down on a real patched runtime", async () => {
    expect(isSupportedNode(process.versions.node)).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "hydra-runtime-smoke-"));
    try {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../dist/daemon.mjs", import.meta.url))],
        {
          env: { ...process.env, HYDRA_DATA_DIR: dir },
          input: '{"id":"hello","type":"hello"}\n{"id":"bots","type":"bots.list"}\n',
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const responses = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(responses).toContainEqual(expect.objectContaining({ id: "hello", type: "result" }));
      expect(responses).toContainEqual({ id: "bots", type: "result", result: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
