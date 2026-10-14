import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15_000,
    globals: false,
    // Backstop: if main.ts is ever accidentally imported by a test, the
    // process-level main() call resolves the data dir from this env var
    // instead of ~/Library/Application Support/Hydra.  Tests that need
    // their own isolated data dirs set HYDRA_DATA_DIR explicitly in
    // beforeEach (or pass it to spawned subprocesses directly).
    env: {
      HYDRA_DATA_DIR: join(tmpdir(), "hydra-vitest-backstop"),
    },
    server: {
      deps: {
        // @diegopetrucci/pi-web-access ships TypeScript source with no
        // pre-compiled output.  Vitest must transform it inline rather than
        // serving the raw .ts files from node_modules.
        inline: ["@diegopetrucci/pi-web-access"],
      },
    },
  },
});
