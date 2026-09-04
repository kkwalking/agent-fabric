import { RuntimeRegistry } from "@agentfabric/core";
import { mockAdapter } from "./mock.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { dockerAdapter } from "./docker.js";

export { mockAdapter, mockCapabilities } from "./mock.js";
export { opencodeAdapter, mapOpenCodeEvent, opencodeCapabilities } from "./opencode.js";
export { piAdapter, mapPiEvent, extractPiSessionRef, piCapabilities } from "./pi.js";
export {
  dockerAdapter,
  runDockerContainer,
  runDockerWithLifecycle,
  execDockerInContainer,
  createDockerContainerOps,
  mergedResourceLimits,
} from "./docker.js";

/** Builds the standard registry containing all built-in runtime adapters. */
export function buildRegistry(): RuntimeRegistry {
  const registry = new RuntimeRegistry();
  registry.register(mockAdapter);
  registry.register(opencodeAdapter);
  registry.register(piAdapter);
  registry.register(dockerAdapter);
  return registry;
}
