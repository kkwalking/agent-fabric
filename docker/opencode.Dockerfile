# OpenCode Runtime Image — the official OpenCode image plus the tools the
# AgentFabric Harness Execution Contract requires
# (docs/harness-image-contract.md).
#
# Why a derived image instead of the official one directly: the official
# image (ghcr.io/anomalyco/opencode) is a minimal Alpine build that ships
# only ripgrep, so an agent that runs `python3 …` or `curl …` inside it
# fails on a missing binary. The contract requires both tools in every
# harness image, so this image adds them and changes nothing else.
#
# Build it and point a containerized OpenCode runtime at it:
#
#   docker build -t agentfabric-opencode:latest -f docker/opencode.Dockerfile docker/
#   # or build every harness image at once:
#   bash scripts/build-harness-images.sh
#
# Contract satisfied by this image:
#   ✓ opencode CLI installed and executable (inherited)
#   ✓ ENTRYPOINT is the harness (`opencode …args` is the whole container command)
#   ✓ WORKDIR /workspace matches the workspace mount path
#   ✓ Native state lives under /root/.local/share/opencode (mounted rw)
#   ✓ stdout speaks the OpenCode JSON protocol (`run --format json`)
#   ✓ `--session <id>` resumes sessions persisted in the mounted state
#   ✓ python3 + curl available for the agent's own commands
#
# The base tag is an ARG so the image can track the official release (or an
# internal mirror) without editing this file:
#
#   docker build --build-arg OPENCODE_BASE=ghcr.io/anomalyco/opencode:1.2.3 …
ARG OPENCODE_BASE=ghcr.io/anomalyco/opencode:latest
FROM ${OPENCODE_BASE}

# Alpine base: add the contract tools and leave the rest untouched. The
# official image already carries ca-certificates-bundle and ripgrep.
RUN apk add --no-cache python3 curl \
  && python3 --version \
  && curl --version | head -1

# The official image sets WORKDIR to /; restate it as /workspace so the
# image matches the path AgentFabric mounts the workspace at.
WORKDIR /workspace

# ENTRYPOINT ["opencode"] is inherited from the base image — restated here
# so this file documents the whole contract on its own.
ENTRYPOINT ["opencode"]
