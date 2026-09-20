import { RuntimeRegistry } from "@agentfabric/core";
import { mockAdapter } from "./mock.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { codexAdapter } from "./codex.js";
import { claudeCodeAdapter } from "./claudecode.js";
import { dshAdapter } from "./dsh.js";
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
  providerSlug,
  piApiForType,
  npmPackageForType,
  effectiveBaseUrl,
  writePiModelsJson,
  buildOpenCodeConfig,
  writeOpenCodeConfig,
  PROVIDER_API_KEY_ENV,
} from "./provider-config.js";
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
  codexAdapter,
  mapCodexEvent,
  extractCodexSessionRef,
  parseCodexUsage,
  detectCodexUsageLimit,
  codexCapabilities,
  codexAuthStatus,
  codexBin,
  codexProviderCompatibility,
  CODEX_LOCAL_ONLY_HINT,
} from "./codex.js";
export { codexThreadSource, listCodexThreads, readCodexThread } from "./codexAppServer.js";
export {
  claudeCodeAdapter,
  mapClaudeEvent,
  extractClaudeSessionRef,
  parseClaudeUsage,
  detectClaudeUsageLimit,
  claudeCodeCapabilities,
  claudeCodeAuthStatus,
  claudeCodeBin,
  CLAUDE_CODE_LOCAL_ONLY_HINT,
} from "./claudecode.js";
export {
  claudeCodeThreadSource,
  listClaudeSessions,
  readClaudeSession,
  encodeClaudeProjectDir,
} from "./claudeCodeThreads.js";
export {
  zcodeThreadSource,
  listZcodeSessions,
  readZcodeSession,
  zcodeDbDir,
} from "./zcodeThreads.js";
export {
  piThreadSource,
  listPiSessions,
  readPiSession,
  piSessionsRoot,
} from "./piThreads.js";
export {
  dshAdapter,
  dshCapabilities,
  dshBin,
  dshAuthStatus,
  mapDshEvent,
  extractDshSessionRef,
  parseDshUsage,
  newDshEventMapperState,
  dshHeadlessProfileDir,
} from "./dsh.js";
export {
  dshThreadSource,
  listDshSessions,
  readDshSession,
  dshSessionsRoot,
} from "./dshThreads.js";
export {
  dockerAdapter,
  runDockerContainer,
  runDockerWithLifecycle,
  ensureKeepAliveContainer,
  execDockerInContainer,
  createDockerContainerOps,
  killContainerProcesses,
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
  registry.register(codexAdapter);
  registry.register(claudeCodeAdapter);
  registry.register(dshAdapter);
  registry.register(dockerAdapter);
  return registry;
}
