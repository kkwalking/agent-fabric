import { RuntimeRegistry } from "@agentfabric/core";
import { mockAdapter } from "./mock.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { dockerAdapter } from "./docker.js";

export { mockAdapter, mockCapabilities } from "./mock.js";
export {
  opencodeAdapter,
  mapOpenCodeEvent,
  extractOpenCodeSessionRef,
  parseOpenCodeUsage,
  opencodeCapabilities,
  opencodeContainerizedCapabilities,
  opencodeBin,
  opencodeImage,
  OPENCODE_DEFAULT_IMAGE,
} from "./opencode.js";
export {
  piAdapter,
  mapPiEvent,
  extractPiSessionRef,
  parsePiUsage,
  piCapabilities,
  piContainerizedCapabilities,
  piBin,
  piImage,
  PI_IMAGE_CONTRACT_HINT,
} from "./pi.js";
export {
  dockerAdapter,
  runDockerContainer,
  runDockerWithLifecycle,
  ensureKeepAliveContainer,
  execDockerInContainer,
  createDockerContainerOps,
  mergedResourceLimits,
  dockerBin,
  execDocker,
  commonRunArgs,
} from "./docker.js";
export {
  localExecutionBackend,
  dockerExecutionBackend,
  selectBackend,
} from "./backend.js";
export { runHarnessCommand } from "./harness.js";

/** Builds the standard registry containing all built-in runtime adapters. */
export function buildRegistry(): RuntimeRegistry {
  const registry = new RuntimeRegistry();
  registry.register(mockAdapter);
  registry.register(opencodeAdapter);
  registry.register(piAdapter);
  registry.register(dockerAdapter);
  return registry;
}
