# Harness Execution Contract

一个 **Containerized Harness Image** 必须满足什么条件，才能被 AgentFabric 当作某个
Runtime kind 的执行环境。这不是建议清单，而是 Adapter、Execution Backend 与
Orchestrator 共同依赖的接口；镜像不满足时 Run 会失败（且**不会**回退到宿主执行或
普通 node 镜像）。

参考实现：

| 镜像 | Kind | 来源 |
| --- | --- | --- |
| `agentfabric-opencode:latest` | `opencode` | `docker/opencode.Dockerfile`（派生自官方 `ghcr.io/anomalyco/opencode`） |
| `agentfabric-pi:latest` | `pi` | `docker/pi.Dockerfile` |
| `agentfabric-dsh:latest` | `dsh` | `docker/dsh.Dockerfile` |

```bash
bash scripts/build-harness-images.sh        # 构建 opencode + pi + dsh
```

三个镜像都**没有** `defaultImage`：容器化 Runtime 必须显式指定 `runtime.image`。官方
OpenCode 镜像虽然是官方维护的，但它是一个只带 ripgrep 的极简 Alpine 构建，不满足下面
第 7 条，因此不能作为默认值。

## 契约条目

1. **Harness CLI 已安装且可执行**，并且在镜像的 `PATH` 上。
2. **ENTRYPOINT 就是 Harness**。容器命令形如 `docker run <image> <harness args…>`，
   本地二进制名会被丢掉（`packages/runtimes/src/backend.ts`）。没有 harness
   entrypoint 的镜像用 `runtime.config.containerCommand` 显式给出容器内命令前缀。
3. **Workspace 挂载路径明确**：`/workspace`，同时也是容器的工作目录。AgentFabric 把
   Workspace 以 `rw`（或按 filesystem policy 以 `ro`）挂到这里。
4. **Native State 挂载路径明确**：该 kind 的 `nativeStateMountPath`，以 `rw` 挂载。
   这是 Harness 私有状态（原生 session 存储、内部数据库），**不是**用户工作内容：
   * `opencode` → `/root/.local/share/opencode`
   * `pi` → `/root/.pi`
   * `dsh` → `/root/.dsh`

   容器销毁不影响它，因此「Native Resume 跨容器销毁」成立的前提就是这个目录真的
   被挂载、且 Harness 真的把 session 写进去。
5. **stdout 输出该 Harness 的协议**。Execution Backend 只做传输：容器的
   stdout/stderr 以原始行流交给 Adapter，由**同一个** Parser 处理，Local 与
   Container 的事件/Usage/Session Ref 解析完全一致（`packages/runtimes/src/harness.ts`）。
   stderr 是诊断，不承载结构化事件。
6. **Native Resume 参数可用**：容器里用同一套 resume 参数（`--session` /
   `--session-id` / `--resume`）能真的采纳挂载状态里的 session。采纳失败必须**响亮地**
   失败，不能静默开一个空会话。
7. **python3 与 curl 必须可用**。Agent 的日常命令大量使用这两者：跑一段脚本用
   `python3`，取一个 URL 用 `curl`。缺了它们，任务会因为一个跟任务本身无关的原因失败。
   这条要求针对**所有** Harness 镜像，与具体 Harness 无关——所以官方 OpenCode 镜像
   必须派生（`docker/opencode.Dockerfile` 只加这两个包，其它一概不动）。

## 认证

Harness-native 的 Runtime 在**容器内**解析自己的认证。宿主是否装了 CLI、是否登录过，
**不决定**容器化 Run 能不能跑——宿主侧的可用性探测只作用于本地执行。因此：

* 凭据要么预置进该 Runtime 挂载的 Native State（例如 OpenCode 的 `auth.json`、
  DSH 的 `.credentials.yaml`），
* 要么通过 Runtime `env` / Secrets 注入（例如 `DEEPSEEK_API_KEY`）。

两者都没有时，由 Harness 自己在 Run 内报错；Adapter 负责把这个失败原样暴露出来
（例如 DSH 的 `turn_end` reason → `runtime.error`），而不是让 Run 只剩一个裸退出码。

## 镜像里不要放什么

* **不要预置会与挂载冲突的 profile / 状态目录**。Native State 是整目录挂载，镜像里
  烤进去的同名目录每次 Run 都会被遮蔽。DSH 的 `docker/dsh.Dockerfile` 就是例子：
  `$DSH_HOME/profiles/<name>` 与 sessions、credentials 同处一个 home，所以镜像不预置
  profile，由 DSH 首次使用时自行重建。
* **不要依赖宿主路径**。镜像必须自包含；宿主目录只通过显式 bind mount 进入容器。

## 新增一个 Harness 镜像时

1. 写 `docker/<kind>.Dockerfile`，逐条满足上面的契约（含第 7 条的 python3 + curl）。
2. 在 `scripts/build-harness-images.sh` 的 `HARNESSES` 里登记（kind、Dockerfile、默认 tag）。
3. Adapter **不要**声明 `defaultImage`：未配置 `runtime.image` 时应拒绝启动并给出契约提示
   （`OPENCODE_IMAGE_CONTRACT_HINT` / `PI_IMAGE_CONTRACT_HINT` / `DSH_IMAGE_CONTRACT_HINT`），
   而不是回退到一个跑不了 Harness 或缺少契约工具的镜像。官方镜像不等于合格镜像——
   OpenCode 官方镜像就是反例。
4. 加测试：无镜像时拒绝、有镜像时真的进容器、跨容器销毁后 Native Resume 仍成立
   （`packages/core/src/v3.test.ts` 的 dsh 用例是模板）。
