# H1 一次性快照制作宿主准备

> **For agentic workers:** 使用 superpowers:executing-plans 实施；账号脚本由一个中等推理子 agent 编写，root 负责应用和实际宿主核验。

**Goal:** 落实已批准 H1 制作方案的账号与宿主前提，为后续固定入口/JIT 接线提供真实事实。阶段 1 的最终目标仍包括真实 producer、R2/R3、两项迁移和 R4。

**Architecture:** root 仅进行固定安装、资源准备及独立检查，`stage1snapshot` 不获得 sudo、Docker socket 或已有私钥访问。制作只使用每次新建的 1 GiB LUKS2 卷；本切片先验证宿主确实支持其生命周期，不导出真实数据、不注册 Runner。

**Tech Stack:** H1 Alibaba Cloud Linux 3、Python 3.6、cryptsetup 2.3.7、systemd 239/cgroup v1，复用已安装工具。

**Spec:** `docs/acceptance/2026-10-01-stage1-snapshot-producer-host-decision.md` 的选择 A；SHA-256 `d0f4b6a92781de81ff5c0948565b490940900fc401363e9c467955b32d94765d`。用户于 2026-10-05 明确“批准H1 一次性制作”。原批准稿保持字节不变；本记录前向确认选择，原 WSL 限制不再用于阻断已批准的 H1 路线。

## 约束与审查重点

- 无商用 KMS、新业务功能或全量测试矩阵；不重新申请 Docker/主机许可。
- 三 job、精确五标签和 root 固定入口的准入要求保留。两个主机选项原本都使用 JIT；没有选择非 Actions 路线。
- 现有 Ed25519/RSA 主备卷保持隔离，不能充作制作临时卷。
- swap 必须实际停止，core 限额必须为零；容量不足拒绝，不能向普通磁盘回退。准备检查不等于 job 准入或真实销毁证明。
- 既有同名资源不符合预期时拒绝接管；新账号不能读取源配置/私钥或访问 Docker。
- LUKS 使用内存中的独立随机高熵 key；不得把 key 写入 argv、环境变量、日志或普通磁盘。合成探针清理后恢复原有 swap，真实制作期间另由受控执行保持停用。

## Task 1：固定账号及目录

**Files:** 新增 `scripts/release/prepare-h1-snapshot-host.py`；记录 `docs/acceptance/2026-10-05-stage1-h1-snapshot-host-readback.md`。

**Interfaces:** root 运行 `python3 prepare-h1-snapshot-host.py --check|--apply`，仅输出非秘密 JSON。固定 `stage1snapshot`、root-owned home `/var/lib/stage1snapshot`、root-only `/var/lib/subscription-saas/snapshot-volumes` 和专用 core limits 文件；不提供可替换路径/账号参数。

- [x] 只读核实既有账号、路径、实际权限与资源（`2264f1`、`503856`）。
- [x] 编写脚本并进行语法检查；限定审查结果见 acceptance 记录。
- [x] `a5416c` 先确认缺失，应用后修正实际账号过期差异，新 SSH `fac9f7` 全部检查通过。

## Task 2：实际宿主加密生命周期

**Files:** 忽略目录 `.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/` 中保留单次探针及非秘密结果；更新同一 acceptance 记录。

**Interfaces:** 单次 root 合成探针只在新 UUID 对应的固定根目录中创建 1 GiB 卷，记录 UUID、mapper、挂载、keyslot 与清理事实，不生成 producer/completion 成功原件。

- [x] 实测停用 swap，core 限额零并临时禁止 systemd core 管道；停用后约 862 MiB 可用（`ab4985`）。
- [x] 新建 1 GiB LUKS2、打开、格式化、挂载及合成标记读回。
- [x] 卸载、关闭、keyslot 清空和旧 key 拒绝；删除本次资源、恢复 swap/core。独立 SSH `2256de` 确认目录/mapper 无残留及 Staging PG 健康。
- [x] 两次 cryptsetup 兼容性失败及各自清理记录保留，第三次 `ab4985` 才计完整通过。

## 后续真实接线

以上事实通过后继续固定 adapter、低权限进程/数据库工具的受限交接和 root JIT 控制。替换旧明文 workflow 为 admission/data/custody；实际 run 确定后，按用户既有要求提交精确 publisher/custody RAM 草案。随后只构建必要的同一最终候选并运行 R2/R3、获准迁移与 R4。不得把本宿主切片作为阶段 1 收口。

## Task 3：固定加密子进程入口

**Files:** `scripts/release/snapshot-h1-data-worker.mjs`、相关有限测试；复用现有 PostgreSQL source/workspace、native 工具和 `runProtectedSnapshotEncryption`，不再设计一套扫描或加密协议。

**Interfaces:** root 控制面通过专用 stdin pipe 发送一条封闭 JSON 配置，含既有 v2 crypto authorization、公钥、两个已核实的 loopback 端口与物理数据库指纹、一次性数据库口令和 tokenization key。代码固定源数据库/只读角色、临时目标数据库/角色、合同文件和 `/work/crypto`；不接收 URL、SQL、模块/脚本路径、输出目录或任意命令。子进程 stdout 只发固定的销毁请求及完成/失败记录；root 实际销毁本次目标容器后才回传唯一确认并关闭输入管道，子进程收到确认及 EOF 后才允许进入加密。Job 本身仍只有 opaque admission reference，不能直接使用该私有 pipe。

**Ruling:** Runner 保持 UID 992/GID 988；处理凭据和明文的固定容器使用不同的数值 UID/GID 65532，根控制面每次验证该宿主 UID 未被占用。`9c5530` 实测没有账号/进程占用；不创建登录账号。其目录仅在 root 控制的 attempt 卷内挂载给容器。两个独立进程身份用于阻止 Runner 从 `/proc` 或目录读取加密子进程凭据，不能只依赖同 UID 的文件 0600。

- [x] 5 项有限协议测试通过，包括无确认和确认后的延迟额外数据；既有加密组合相关 2 项通过。
- [x] 专用 worker 复用原有 native/source/workspace/crypto；H1 `91463c` 实际合成整链通过，父进程在 ACK 前核查源/目标会话关闭及目标容器删除，worker 退出后真实解密验证摘要。
- [x] 更新固定入口清单、相关 lint/合同检查和限定静态审查；记录见 `docs/acceptance/2026-10-05-stage1-h1-data-worker-readback.md`。正式 root controller 仍须独立核验，不能把本探针或 worker 回显当作生产证明。

本步骤使用已批准 H1 数据平面方案内的实现细化，不再请求制作主机、Docker 或 GitHub App 批准。仍未完成的 root JIT/controller、adapter 安装闭包、三个真实 jobs、独立 OSS 身份、真实 producer、R2/R3、迁移与 R4 保持原范围和门槛。

## Task 4：固定运行包安装

**Files:** `scripts/release/snapshot-h1-runtime-bundle.mjs`；本计划忽略目录保留一次性安装脚本及只读回执。

**Interfaces:** 打包器只读取当前 checkout 中固定 worker 的静态相对 import 闭包、固定合同/schema 与已经锁定的 pg/ajv/canonicalize 依赖，不执行下载或安装。返回含每个相对路径、字节数、SHA-256 和内容的固定安装包；整个运行包摘要同时绑定既有 root Node 摘要和固定 PostgreSQL 工具镜像。H1 安装到 root 管理的 `v2/bundles/<digest>` 新目录，仅允许 root 所有、文件 0444/目录 0555，无软链接、不覆盖现有不同内容；正式准入仍须固定这个摘要。

- [x] 有限依赖闭包：401 文件、20 包、1,432,599 字节；digest `239b95e7d513cd80956f71f7616b6bd3ea7bfc99afb80af594422b82b9b17b4f`。
- [x] H1 `17cb3a` 安装并逐文件回读；无网络 UID 65532 容器加载成功且实际拒绝非法输入，容器已移除。
- [x] `docs/acceptance/2026-10-05-stage1-h1-runtime-installation.md` 记录安装事实和 Runner/job 隔离裁定；正式准入及真实制作仍未完成。

## Task 5：一次性 Runner 与受限 root 交接

沿用上项裁定，仅实现固定版本官方 container hooks 所需 prepare/run/cleanup，禁止通用命令、Docker API 或新业务功能。先封闭 root 状态机与不同 UID 的两个 socket，再接已有准入/撤销核验及 JIT；生产制作必须等待全部准入成立。

**2026-10-06 范围纠正：** 旧 2026-09-03 计划首页的 Task6/I 系列冻结仍有效。本任务复用当前 dispatch verifier 所需的两份原件及真实 custody，不以 `I0_CLOSED` 或完整 I0 bootstrap 为前置，不扩建通用 API/批准原件归档、在线撤销服务或自动批准平台。已获用户精确批准并创建的独立 RAM 身份保留；该批准不扩展为对象权限。具体有限接口与后续顺序见 [dispatch 证据范围核对](../../acceptance/2026-10-06-stage1-dispatch-evidence-scope.md)。原 verifier 的签名、fresh nonce 撤销检查、真实 custody、持久 checkpoint 及 GitHub 准入均保持。

- [x] 官方 Runner 2.337.0 distribution 摘要核验及只读缓存（不配置/注册）；`44273c` 隔离容器版本检查及 `eefb48` 独立目录/清理回读通过。
- [x] 固定 hook→root 管理通道、独立 job→root 请求通道及实际容器隔离；`bf79ad` 真实 hook/UID 65533 容器合成探针与 `6e51c2` 独立回读通过。生产准入和制作回调仍由下面两项接线。
- [x] root 专用 GitHub 只读接口，真实 App/run/job/Environment 读取及令牌撤销；`5cf1dd` 实际 API、`0e3b01` 最终代码安装回读通过。首轮令牌格式失败及撤销 UNKNOWN 保留于 `docs/acceptance/2026-10-05-stage1-h1-github-read-session.md`。本项不是准入签名或 JIT 注册。
- [x] 固定主卷 App JWT supplier 与持久 dispatch checkpoint 接口；`bd8997` 实际签名/claims 验证，`89e153` Linux root 隔离台账验证通过。真实 dispatch/current-revocation 来源及其初始 checkpoint 仍由下一项接线，不能以本项合成 head 初始化生产状态。
- [x] 既有 H1 Ed25519 固定描述符及实际持有挑战；`46c3c3` H1 签名、`bbe272` 本机独立验签/SSH 清理回读通过。完整准入仍须下项的真实 dispatch/current-revocation/custody 来源与固定 root policy，挑战不是准入成功证明。
- [x] 用户精确批准的独立 I0 archive writer/reader 身份初始化，`5be00e` 实际 RAM 回读、`724bef` 十条云审计记录核验完成；角色未附 OSS 权限、无 AccessKey。精确原件 policy 编译器和既有撤销状态归档类型已补齐。实际归档/资源 readback/后续精确 RAM 差额仍待实施，不能作为 I0_CLOSED；详见 `docs/acceptance/2026-10-05-stage1-i0-archive-identities-readback.md`。
- [x] 固定 JIT 注册/精确退役 transport 本地接线，以及 H1 Runner 容器/专用临时网络/私有 stdin 入口的实际边界检查；`29de75` 非法 JIT 明确拒绝并完成真实清理，`88fd47` 相关 35 项通过。不是云端注册或真实 producer，完整事实及失败修正见 `docs/acceptance/2026-10-06-stage1-h1-jit-runtime.md`。
- [ ] root 签名准入、当前撤销和 GitHub 实际 job 观测接线，JIT 唯一路由与结束后不可路由证明。
- [ ] 本次 attempt 的加密卷/源角色/目标数据库/worker/publisher 工序以及独立终态检查，最后接真实 workflow。

**固定版本接口核对：** v2.337.0 的 hook JSON 使用 `args.container`，并为 prepare/run/cleanup 均生成 `<runner-root>/_work/_temp/_runner_hook_responses/<GUID>.json`；部分在线示例使用的 `jobContainer`/null responseFile 不适用此版本。prepare 最少回写 `isAlpine:false`，state 仅为不可信关联信息；脚本结果取 hook 退出码，不使用 JSON exitCode。root 状态机必须自行绑定 attempt、最多执行一次固定入口；不接收 workflow 的 shell/script/env/mount 指令。核对依据为固定 tag 的 HookInput、HookResponse 和 ContainerHookManager；后续直接按该接口实施，不重复做版本调研。

**已实现的 root 接口：** `H1SnapshotControl(admission_ref, runner_root, operations)` 仅供受信 root 代码创建；无外部 CLI 配置入口。管理 socket `/run/stage1-snapshot/management/control.sock` 仅 UID/GID 992/988，job socket `/run/stage1-snapshot/job/request.sock` 仅 65533/65533；使用内核 SO_PEERCRED。每条请求严格为 command/admissionRef，EOF 后处理，最多一次制作。`H1FixedJobContainer` 固定镜像/四项只读挂载，并核对 job 实际 PID/mount/network namespace。真实准入、制作和清理通过 root 私有回调接入，不得把合成回调或客户端引用当作生产准入。实施及失败修正见对应 acceptance 记录。
