#!/usr/bin/env bash
# Build the AgentFabric harness runtime images from docker/*.Dockerfile.
#
#   bash scripts/build-harness-images.sh                     # every image
#   bash scripts/build-harness-images.sh pi dsh              # only these
#
# Each harness image satisfies the Harness Execution Contract
# (docs/harness-image-contract.md): the harness CLI is the ENTRYPOINT,
# the workspace mounts at /workspace, the harness's native state lives at
# the path AgentFabric bind-mounts for that kind, and python3 + curl are
# available for the agent's own commands. Point a containerized Runtime
# at the tag with `runtime.image` (or the matching AGENTFABRIC_*_IMAGE
# override).
#
# OpenCode's image is derived from the official one
# (ghcr.io/anomalyco/opencode) because that image ships neither python3
# nor curl; docker/opencode.Dockerfile adds them and nothing else.
set -uo pipefail
cd "$(dirname "$0")/.."

DOCKER=${AGENTFABRIC_DOCKER_BIN:-docker}
TAG_PREFIX=${AGENTFABRIC_IMAGE_TAG_PREFIX:-agentfabric}

# kind:Dockerfile:default-tag — the tag a containerized runtime can use.
HARNESSES=(
  "opencode:docker/opencode.Dockerfile:${TAG_PREFIX}-opencode:latest"
  "pi:docker/pi.Dockerfile:${TAG_PREFIX}-pi:latest"
  "dsh:docker/dsh.Dockerfile:${TAG_PREFIX}-dsh:latest"
)

usage() {
  echo "usage: bash scripts/build-harness-images.sh [opencode] [pi] [dsh]" >&2
  echo "       (no arguments builds every harness image)" >&2
}

# Requested kinds; empty means "all".
requested=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    opencode|pi|dsh) requested+=("$arg") ;;
    *) echo "unknown harness: $arg" >&2; usage; exit 2 ;;
  esac
done

if ! "$DOCKER" info >/dev/null 2>&1; then
  echo "FAIL: the Docker daemon is not reachable ($DOCKER info failed)" >&2
  exit 1
fi

built=0
for entry in "${HARNESSES[@]}"; do
  IFS=: read -r kind dockerfile tag <<<"$entry"
  if [ ${#requested[@]} -gt 0 ]; then
    keep=0
    for want in "${requested[@]}"; do [ "$want" = "$kind" ] && keep=1; done
    [ "$keep" = 1 ] || continue
  fi

  if [ ! -f "$dockerfile" ]; then
    echo "FAIL: $dockerfile is missing" >&2
    exit 1
  fi

  echo
  echo "== building $kind → $tag ($dockerfile)"
  # Build context is docker/ so the Dockerfiles stay context-independent.
  if ! "$DOCKER" build -t "$tag" -f "$dockerfile" docker/; then
    echo "FAIL: building the $kind image failed" >&2
    exit 1
  fi
  echo "OK: $tag"
  built=$((built + 1))
done

if [ "$built" = 0 ]; then
  echo "FAIL: nothing was built (unknown harness selection)" >&2
  exit 2
fi

echo
echo "Built $built image(s). Point a containerized Runtime at one with:"
echo "  af runtimes add \"OpenCode (containerized)\" --kind opencode --isolated --image ${TAG_PREFIX}-opencode:latest"
echo "  af runtimes add \"Pi Agent (containerized)\" --kind pi       --isolated --image ${TAG_PREFIX}-pi:latest"
echo "  af runtimes add \"DSH (containerized)\"      --kind dsh      --isolated --image ${TAG_PREFIX}-dsh:latest"
