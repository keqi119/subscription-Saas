# H1 固定数据运行包安装

2026-10-05，实施于已批准 H1 `139.196.227.195`。

## 安装及实际回读

`snapshot-h1-runtime-bundle.mjs` 只读收集既有 worker 的静态模块闭包、固定合同/schema、当前锁定的 pg/ajv/canonicalize 依赖。路径限于 ASCII 相对路径，拒绝越界/软链接/重复文件/冲突包版本；文件总量上限 32 MiB，不下载或执行依赖。安装摘要同时绑定每个文件内容、既有 Node 摘要和 PostgreSQL 工具镜像。

H1 `17cb3a` 实际安装成功：

- bundle digest：`sha256:239b95e7d513cd80956f71f7616b6bd3ea7bfc99afb80af594422b82b9b17b4f`。
- 路径：`/opt/subscription-saas/snapshot-adapter/v2/bundles/239b95e7d513cd80956f71f7616b6bd3ea7bfc99afb80af594422b82b9b17b4f`。
- 内容：401 个文件，20 个依赖包，1,432,599 字节；另有绑定全部内容的安装 manifest。
- 全部文件摘要、字节数、root 所有权、0444 文件及 0555 目录逐项回读通过；未覆盖任何既有不同内容。
- 实际 UID/GID 65532、无网络/无 Docker socket/只读根文件系统的容器可加载此入口；非法私有输入得到 `H1_CONFIG_INVALID` 和退出码 1，无 stderr/OOM；探针容器已移除。

独立 SSH `25a82b` 确认加载探针无残留，Staging PostgreSQL 为 running/healthy。安装不会把该摘要自动当作生产批准：正式 root policy/admission 仍须绑定它。

本地 `8a72c3` 再次构建得到相同摘要、文件数和字节数，相关 ESLint、Prettier 与差异检查通过；`7c6148` 合同检查为 286 个文件、91 个 schema、13 个命令及 128 项迁移。其后附带的下载文件查询因文件尚未生成而失败，不计入合同失败或安装成功证据。本轮未修改业务逻辑；Staging 仍只有 `20260925090000_stage1_operational_completion_terminal_shape` 和 `20260925091000_stage1_operational_completion_settlement_guard` 两项迁移待执行。

## Runner 与 job 隔离的实施裁定

标准 GitHub Runner 的 JIT 参数会在 listener 根目录落成本次配置，同 UID 的原生 job 不能据此宣称隔离。固定 `v2.337.0` 的官方实现支持 container hooks：启用后，prepare/cleanup 和容器内 script step 由 hook 接管并返回，跳过默认 Docker 或 host script 执行。[ContainerOperationProvider](https://github.com/actions/runner/blob/v2.337.0/src/Runner.Worker/ContainerOperationProvider.cs)、[StepHost](https://github.com/actions/runner/blob/v2.337.0/src/Runner.Worker/Handlers/StepHost.cs)。

后续采用该受限接口保持已批准边界：Listener/Worker 仍为 UID 992，无 Docker group/sudo；root 所有的 hook 仅向一次性 root controller 请求固定 prepare/run/cleanup。job 使用独立 UID 65533 容器，只挂固定入口和自己的工作请求 socket，不挂 Runner 凭据、宿主 `/proc`、Docker socket 或 hook 管理 socket。实际数据进程继续使用独立 UID 65532。root 忽略外部命令/路径配置，只执行当前已准入 job 的固定入口，且最多执行一次；禁止 `uses`/service container/任意镜像、挂载或附加步骤。

控制器须强制 `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER=true`，固定 hook 路径和 Runner 版本，并为 hook 设置自身超时。该接口为 public preview，参数或路由不符即拒绝；不能退回 host script。上述为现有 H1 root 编排的实现细化，不新增登录账号或通用 Docker 权限。[GitHub 官方 hook 说明](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/customize-containers)。

此裁定尚未代替实际接线及验证。JIT 配置仍须留在本次受保护的 Runner 层，自动更新设置须在实际生成配置中核验；不能假定 JIT 自动禁用更新。尚未注册 Runner、制作真实快照、上传 OSS、执行迁移或完成 R2/R3/R4。
