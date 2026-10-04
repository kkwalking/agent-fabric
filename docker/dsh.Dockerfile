# DSH Runtime Image — the containerized DSH (DeepSeek Harness) harness.
#
# DSH has no official published runtime image, so this Dockerfile is the
# reference image for a containerized DSH runtime. It installs the `dsh`
# CLI and nothing else: the headless bundle ships as part of that install
# and the profile is created on first use, so no `dsh plugin add` step
# (and no pnpm) is needed here — see the note below.
#
# Build it and point a containerized DSH runtime at it:
#
#   docker build -t agentfabric-dsh:latest -f docker/dsh.Dockerfile docker/
#   # or build every harness image at once:
#   bash scripts/build-harness-images.sh
#
# Contract satisfied by this image (docs/harness-image-contract.md):
#   ✓ dsh CLI installed and executable
#   ✓ ENTRYPOINT is the harness (`dsh …args` is the whole container command)
#   ✓ WORKDIR /workspace matches the workspace mount path
#   ✓ Native state lives under /root/.dsh (mounted by AgentFabric, rw)
#   ✓ stdout speaks the dsh JSON protocol (`--profile headless --json`)
#   ✓ `--session-id <id>` resumes sessions persisted in the mounted state
#   ✓ python3 + curl available for the agent's own commands
#
# Two DSH details this image is shaped around:
#
# 1. The profile directory is state, not image content. DSH keeps
#    $DSH_HOME/profiles/<name> under the same home as its sessions and
#    credentials, and AgentFabric mounts the whole of /root/.dsh as the
#    runtime's opaque native state. Whatever a profile directory baked
#    into the image would therefore be shadowed by that mount on every
#    run. DSH recreates a missing headless profile on first use, and the
#    headless bundle resolves from the global install, so the profile
#    needs no build-time provisioning at all.
#
# 2. The `dsh` version is pinned. `@deepseek-ai/dsh-headless` is published
#    with a `latest` dist-tag that trails the CLI (0.0.1-rc.1 against a
#    0.2.x CLI), and installing that pair makes DSH refuse the plugin as
#    incompatible. Pinning the CLI keeps the image reproducible; override
#    with --build-arg DSH_VERSION=<version> to move it forward.
#
# Credentials stay harness-native. Either seed the runtime's native state
# with DSH's own .credentials.yaml, or inject the provider key through
# runtime env / Secrets (DEEPSEEK_API_KEY) — the headless runner reads
# both. AgentFabric never handles DSH credentials itself.

FROM node:24-bookworm-slim

# DSH's headless runner shells out to git/ripgrep and expects a real bash.
# python3 and curl are part of the contract (docs/harness-image-contract.md
# §7) — the agent's own commands need them, not the harness.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*

ARG DSH_VERSION=0.2.0-rc.2
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
  && dsh --version

WORKDIR /workspace

ENTRYPOINT ["dsh"]
