import { isSupportedNode, NODE_REQUIREMENT } from "./runtime.js";

// Keep dependencies behind this check, including in the built artifact.
// npm engines is advisory and the macOS launcher invokes Node directly.
if (!isSupportedNode(process.versions.node)) {
  process.stderr.write(
    `[hydra-daemon] Unsupported Node.js ${process.versions.node}. Require ${NODE_REQUIREMENT}. ` +
      "Install a patched Node.js runtime and select it with HYDRA_NODE.\n",
  );
  process.exitCode = 1;
} else {
  await import("./daemon.js");
}
