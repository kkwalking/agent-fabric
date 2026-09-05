# Harness Execution Contract

> v3 §10–§12: a containerized Harness Runtime Image is part of the
> execution contract, not an implementation detail. This document
> defines what an image must provide, and how AgentFabric treats images
> that do not.

A **Containerized Harness Image** is a Docker image that AgentFabric's
Docker execution backend can run a harness in directly. The image and
the harness adapter form a contract:

## Requirements

1. **Harness CLI is installed** and executable inside the image — a
   plain base image (e.g. `node:22-alpine`) that does *not* contain the
   harness violates the contract.
2. **The image entrypoint is the harness CLI.** AgentFabric executes
   `docker run … <image> <harness args…>`; it does not prepend a binary
   name. (A runtime may override the in-container command explicitly via
   `runtime.config.containerCommand`.)
3. **Workspace mount path is `/workspace`.** The backend mounts the
   task's workspace at `/workspace` and sets it as the working
   directory.
4. **Native state mount path is the harness's own state directory**
   inside the container, declared by the adapter:
   - Pi: `/root/.pi` (contains `agent/sessions/…`)
   - OpenCode: `/root/.local/share/opencode` (`$XDG_DATA_HOME/opencode`,
     containing `storage/session/…`, `auth.json`, …)

   AgentFabric mounts an opaque, managed host directory there
   read-write. The harness — and only the harness — interprets its
   contents.
5. **stdout speaks the harness's JSON protocol** (pi `--mode json`;
   OpenCode `run --format json`); stderr carries logs. The Docker
   backend transports both streams raw to the harness adapter — the
   image must not wrap, buffer-collapse or reformat them.
6. **Native resume parameters work against the mounted state**: a
   session persisted in run #1 (container A) must be resumable in run
   #2 (container B) with the same reference, e.g. `pi --session <id>` /
   `opencode run --session <ses_id>`.

## Image policy per harness

| Harness   | Default image                        | Policy (v3 §10/§11) |
|-----------|--------------------------------------|---------------------|
| OpenCode  | `ghcr.io/anomalyco/opencode`         | Maintained official runtime image; entrypoint is the CLI. (The stale `ghcr.io/sst/opencode` name must not be used.) Override with `runtime.image` or `AGENTFABRIC_OPENCODE_IMAGE`. |
| Pi        | *(none — no official image exists)*  | **Plan A:** AgentFabric refuses to start containerized Pi without an image. Configure `runtime.image` or `AGENTFABRIC_PI_IMAGE`, e.g. built from [`docker/pi.Dockerfile`](../docker/pi.Dockerfile). A plain Node image is never used as a silent fallback — it would break native resume. |

## Why the runtime image is part of the contract

Capabilities are computed from the *combination*
harness × execution backend × runtime configuration (v3 §16/§17). A
containerized runtime whose image cannot satisfy items 1, 4 or 6 does
not really support native sessions/resume — even if the harness itself
does locally — so AgentFabric narrows the declared capabilities
accordingly and refuses to run instead of silently degrading
("Containers are disposable; harness sessions stay native; runtime
native state is opaque").
