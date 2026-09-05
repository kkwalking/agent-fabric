# Pi Runtime Image — reference implementation of the AgentFabric
# Harness Execution Contract (docs/harness-image-contract.md).
#
# pi has no official published container image; this Dockerfile follows
# the pi documentation's containerization recipe (node base + global
# @earendil-works/pi-coding-agent install). Build it and point a
# containerized Pi runtime at it:
#
#   docker build -t agentfabric-pi:latest -f docker/pi.Dockerfile docker/
#
# Contract satisfied by this image:
#   ✓ pi CLI installed and executable
#   ✓ ENTRYPOINT is the harness (`pi …args` is the whole container command)
#   ✓ WORKDIR /workspace matches the workspace mount path
#   ✓ Native state lives under /root/.pi (mounted by AgentFabric, rw)
#   ✓ stdout speaks the pi JSON protocol (`--mode json`)
#   ✓ `--session <id>` resumes sessions persisted in the mounted state

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /workspace

ENTRYPOINT ["pi"]
