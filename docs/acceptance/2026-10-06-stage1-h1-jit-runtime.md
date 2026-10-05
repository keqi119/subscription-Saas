# H1 JIT 注册与固定 Runner 运行边界

阶段 1 仍未收口。本次继续已批准的 H1 一次性制作路线；已创建的 archive writer/reader 身份保持原权限。本记录不批准对象访问、不恢复旧 I 系列平台，也不把本地或合成检查作为实际 producer 成功。

## 实现

- `H1SnapshotJitGitHub` 复用既有 GitHub App 身份核验，仅取得固定仓库的 administration write / actions read / metadata read 安装令牌。原读取会话权限保持不变。创建前读完整 Runner 列表，固定名字、group 1、五标签及 `_work`；只发送一次 JIT POST，再按响应中的 ID 独立 GET 核验。新建 Runner 的 `os` 可暂为 `unknown`，不据此宣称 Linux 已连接。清理只针对本实例已取得并重新核对的 ID，确认删除后 GET 404；令牌撤销不等于 Runner 退役。
- `snapshot-h1-runner-entry.mjs` 仅接受私有 stdin 中的固定字段，核对 Runner ID、nonce、一次性设置、固定工作目录，以及 v2.337.0 的设置字段和 GitHub Actions HTTPS/OAuth 端点。仅允许三份 JIT 配置文件，拒绝重复 JSON 字段、路径越界和非规范 base64；文件原字节以 0600、exclusive/no-follow 写入 attempt 加密卷。固定调用 `Runner.Listener run`，JIT 不进入 argv 或容器环境配置。Listener 正常退出只记录进程事实，不表示 job/producer 通过。
- `H1FixedRunnerContainer` 先核验停用 swap/core、真实 LUKS2 mount/mapper/loop backing、固定官方分发包的 9,310 个文件和入口摘要，再创建 Runner 目录。调用顺序为 `prepare_directory()` → 现有控制通道 `start()` → `prepare()` → `run(frame)` → `cleanup()`。Runner 为 UID 992/GID 988，Docker socket、源库配置和现有密钥不挂载；仅绑定本次 Runner 目录、只读 bin/externals/固定入口和管理 socket。容器限制为只读根、cap drop、no-new-privileges、384 MiB、128 pids、零 core、无 Docker 日志和无重启策略。

固定配置布局依据 [Runner v2.337.0 的 JIT 展开逻辑](https://github.com/actions/runner/blob/v2.337.0/src/Runner.Listener/Runner.cs)、[RunnerSettings](https://github.com/actions/runner/blob/v2.337.0/src/Runner.Common/ConfigurationStore.cs) 和 [OAuthCredential](https://github.com/actions/runner/blob/v2.337.0/src/Runner.Listener/Configuration/OAuthCredential.cs)。不假设 REST runner group ID 与内部 pool ID 是同一字段：group 固定在创建请求中；配置核对实际 runner ID/name 和受限端点，不虚构内部 pool 映射。

## 已验证与失败保留

本轮开始 HEAD 为 `1498a86a`，工作树原本干净。`636dda` Prisma validate 通过；实际 Staging status 仍为 128 条迁移中的以下两条待执行，未修改业务代码或应用迁移。子 agent 报告的 status 结果标识为 `cd4a3c`，该标识也出现在它的初次错误隧道结果中，不能仅凭标识区分两次调用；最终结果含 `OWN_TUNNEL_CLOSED=yes`，无遗留 SSH 隧道。

- `20260925090000_stage1_operational_completion_terminal_shape`
- `20260925091000_stage1_operational_completion_settlement_guard`

入口 `47dd28` 先确认模块缺失，之后四项检查通过。限定独立审查指出连接端点未受约束；`7cb5aa` 复现该缺口，修正后 `a9cda6` 五项通过。初次 ESLint `718de3` 的无用转义已修复。最终 `88fd47` 为 JIT transport 六项、Runner 生命周期六项、入口五项和既有 GitHub 读取会话十八项，共 35 项通过、无跳过；本地 HTTP/Docker 边界使用替身，不是云端注册。

宿主检查保留全部失败：

1. `decabf` 在容器创建前因缓存父目录权限被拦住。`ee814f` 证实既有父目录是 root 0700、分发目录 0555；修正为接受父目录 0700/0755 后，`d150c2` 在 H1 对固定 manifest 和全部文件核验通过。
2. `e40b17` 未能证实入口主动拒绝；原断言名为 `INVALID_JIT_ACCEPTED`，这不是实际接受配置的证据。后续 `df92d3` 捕获真实原因：Docker 默认 `docker0` 不存在，容器保持 created、PID 0、exit 128，入口尚未启动。`499d35` 独立确认缺失。采取每次 attempt 的专用临时 bridge 网络，不重启 Docker、不使用 host 网络、不加入 Staging 网络。
3. 上述每次失败均实际卸载卷、关闭 mapper、清空 keyslot、确认旧 key 被拒绝并删除本次 backing，恢复 swap/core，读回 Staging PG healthy。`2a4ba8` 独立确认 attempt 目录为空、控制通道不存在、没有本次 Runner 容器残留。

最终宿主 `29de75` 完整通过：本次专用 bridge 与 UID 992 隔离容器实际启动，入口返回固定 `H1_RUNNER_INPUT_REJECTED`，容器 exited/exit 1/PID 0、无 OOM、未写三份凭据文件；随后精确容器、空网络和控制 socket 清理成功。LUKS 卷卸载、mapper 关闭、keyslot 清空及旧 key 拒绝均已实测，backing/mount 删除，swap/core 恢复，Staging PG healthy。此探针只发送合成空 JIT，没有实际注册 Runner 或启动 Listener、读取源数据。

H1 本次安装的生命周期文件 SHA-256 为 `3edc64382a85d68bbca06e30994fed571753f1b2ef4d84cb92d66b64bf3f73ac`。新 GitHub JIT transport 尚未用于云端；既有控制运行包 digest 未改变。生产控制面仍须将这些确定字节纳入最终安装及准入，不能复用探针的合成 admission reference。

`5ed39c` 另起 SSH 独立确认 attempt 目录空、控制通道不存在、Runner 容器及专用网络均无残留、PG healthy，并回读生命周期摘要和入口摘要 `100925d36beb0868ac9598c968e3e1b85f83c1973506a74b056e283a62d38e71`。最终合同检查 `0fb395` exit 0：304 文件、92 schemas、13 commands、128 migrations；仓库摘要 `sha256:61e6b671ed114f517300dcbb741a29462538bf6f007c9217162a0a4be4146b63`，迁移摘要仍为 `sha256:65ebe3208fc618ae82ad24f66b793e9bddd7464526dd45b8a0d9893d24a0ff62`。

## 尚未完成

真实 dispatch/current-revocation/custody、root policy、准入及 post-approval 的生产接线，持久 nonce 先行占用、JIT launch/实际 job 绑定与退役证明，以及 worker/publisher 的生产回调和三个真实 jobs 仍须完成。旧明文 snapshot workflow 没有触发。

仍按既有顺序推进：必要代码整合为同一候选并取得真实 build proof → 冻结 dispatch/state 两份原件和精确 RAM 差额供用户确认 → 真实保管、当前撤销和 producer → 同候选 R2/R3、两条获准迁移和 R4。构建不以快照为前置；当前切片不证明发布完成。
