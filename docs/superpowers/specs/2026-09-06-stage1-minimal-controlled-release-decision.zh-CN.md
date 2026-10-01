# Stage 1 最小受控发布与主线并行收敛决策

日期：2026-09-06

状态：**待复审，未授权施工**。用户已同意路线调整；本文的信任与副本边界仍需批准。可先单独批准 P0/P1，不以 R1–R4 的详细设计为前置。

核查基线：`6e7d07cf`；最近完成代码为基础设施 Task 5 `1f0b0439`。原 Task 6 在途计划 `+207/-53` 已原样独立提交 `457c0011`，仅为保管，未获施工批准。

## 1. 唯一入口与交付目标

交付目标是现有 Staging 的 Stage 1 主线验收，不是完成 S1 云端自动化平台。

`P0 范围交接 → P1 受控开发准入 → [业务验证/定点修复 ∥ 最小发布入口] → 可信 CI 候选及双链验证 → Staging 验收签字`

P0 后立即并行开展副本和本机安全能力的**只读材料盘点**，不等 R2；盘点不授权登录来源数据库、导出、生成密钥或改变宿主配置。

本文是对[主 ADR](./2026-09-01-stage1-convergence-governance-adr.zh-CN.md)、[S1 规格](./2026-09-01-stage1-s1-trusted-release-foundation-and-test-isolation-design.zh-CN.md)和[安全附录](./2026-09-03-stage1-s1-execution-infrastructure-security-addendum.zh-CN.md)的前向路线修订。只新增一条限指定 Staging 的人工受控执行路径，不放宽旧 full-RC、qualification、v1/v2 证明的验证规则，不把人工结果包装成完整 S1。

两个旧实施计划首页必须保留醒目的前向冻结通知：基础设施 Task 6 及后续扩展、上游 Task 29R/30、全部 I 系列延期且不得自动续跑；恢复必须重新批准。已完成基础设施 Task 0–5 及上游已完成成果保留。Task 30 stash 不解冻、不覆盖。历史状态只作历史，不再构成施工入口。

[覆盖路线图](../plans/2026-09-06-stage1-mainline-minimal-release-implementation-plan.md)只管理依赖；[P0/P1 独立计划](../plans/2026-09-06-stage1-p0-p1-admission-implementation-plan.md)是当前唯一申请批准的执行单元。R1–R4、业务包和实际外部操作均须另有小计划/批准，不能从路线图直接开工。

## 2. 范围与成本

主线：A/B 进件、审核、最终方案与车辆预约、单次客户确认、签约归档、主动支付与核销、交付激活、周期账单/催收、无争议正常到期/取回/结算/订单完结。

不新增业务模型、枚举、应用权限码、功能开关；不改历史迁移；不扩展 RENT_TO_OWN、换车、续期、提前结束、争议或司法流程；不全面拆巨型模块。已存在的回归测试不因业务域延期而删除或静默跳过。[S0 权威](./2026-09-01-stage1-s0-authority-and-temporary-asset-governance-design.zh-CN.md)继续有效。

不购买云 KMS、新 VM、付费 Runner、额外数据库或常驻服务。不在生产/预发共用服务器构建或跑全量测试。复用现有 CI/registry、本机和 Staging；本地不足先串行或停止，不自动购买扩容。既有 OSS/网络/制品存储/供应商可能按量收费，须确认既有额度，不能承诺绝对零增量账单。

现有私有 bucket `subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai` 和锁定的 210 天 WORM 不变；不自动上传 dump、不调整保留期，不把 bucket 已存在当成副本和授权已存在。

## 3. 最小发布路径：现有 build proof + 一种人工 launch authorization

### 3.1 唯一候选身份

最终 Staging 候选**只消费现有受保护 CI 产生并 attested 的 `build-proof.v1`**。沿用 `.github/workflows/docker-images.yml` 的固定 checkout、三镜像构建与聚合，不创建第二套 bundle Schema，也不修改已发布 v1 字段。

身份权威保持 `identity.sourceSha / migrationCatalogDigest / repositoryContractDigest / images.api|web|runner`。镜像项包含 registry、name、platform、imageDigest、sourceRevision；按 registry 实际平台 digest 提升。Web 实际 API Base 另与已构建 Web 和环境请求比对，不冒充 v1 identity 字段。

人工 manifest 仅引用 `buildProofDigest`，补充 execution purpose、目标环境、attempt、operationId、批准和输入记录引用；不得再复制一套 source/三镜像/catalog 权威。显示摘要只能从已验证证明派生，不参与第二次身份定义。

消费前由可信入口实际执行 GitHub attestation 验证，限定仓库、受保护 workflow、`refs/heads/main`、准确 source SHA、OIDC issuer 和托管构建来源，再调用现有结构/绑定校验。现有 `verifyBuildProof()` 接收的 verified-attestation 对象不是密码学验证本身；不得由请求方提供“已验证”布尔值代替实际验签。

本地构建仅用于开发，强制 `promotionEligible=false`；没有 CI 或真实 attestation 就停止最终候选提升，不启用本地替代。旧计划 Task 17B/I15B 的构建前私有快照依赖一并延期；现有构建 DAG 不新增该依赖。**构建不等待副本，提升必须等待合法 snapshot 链。**

### 3.2 固定信任根，不让请求选择 profile 或档案

选择“**repository contract/build proof 锚定非秘密 profile**”，不同时建设另一种可切换信任模式。

固定路径为 `release/contracts/manual-stage1-profile.v1.json`；包含 profile identity、owner、公钥及指纹、允许命令/目标策略、有效期、固定本地 journal/归档/独立备份位置。敏感值不入库，路径不得包含访问令牌。profile 不引用未来 build proof，避免循环。

首次实际建立顺序由 R1 小计划落实，外部执行前全部完成：

1. owner 单独批准本机签名身份及精确私密保管位置；只使用 Node Ed25519，不建立 KMS、broker 或在线服务。
2. 在已验证加密、owner-only 的本地保管位置生成私钥；导出非秘密公钥/指纹。私钥不进 Git、镜像、CI、环境变量、日志或聊天。
3. 建立 owner-only 撤销/消费台账和独立加密备份；记录精确位置、访问控制、初始序号、恢复读回及密钥遗失处理。备份公钥/私钥恢复校验在 owner 环境内完成，不输出私钥。
4. 将非秘密 profile 的精确身份、key fingerprint、目标白名单和固定档案位置经独立审查纳入上述仓库文件；新入口同时纳入 `RELEASE_GATE_ENTRY_POINTS` 与 repository-contract 文件清单。
5. 合并后由现有可信 CI 构建，build proof 锚定该 profile 和启动代码。操作者从 attested source 核对入口代码/契约，再独立读回 profile、ACL、台账和备份。
6. 轮换 key、变更目标/档案根/白名单均走新的审查、契约和 CI 构建。撤销可立即减少权限，但不能增加权限；消费前读取当前台账，缺失、回退或状态未知均拒绝。

CLI 只接受操作和非信任输入引用；**禁止参数或环境覆盖 profileFile、archiveRoot、trustRoot、公钥和台账根**。固定路径还须拒绝链接/重解析点和越界路径。请求文件、档案内的自声明、调用者提供的摘要不能建立信任。

此模型信任经审查的执行主机和在场 owner，不声称抵抗已控制宿主/签名身份的攻击者，也不把普通文件目录称为 WORM。宿主或台账疑似失陷，撤销该 profile 并停止，不能靠一次签名继续放行。

### 3.3 一种授权机制，互斥操作阶段

只建设一种 `manual launch authorization` 验签/消费机制。不同操作以互斥 stage、单一 capability 表达，不再造各自的批准平台：

| stage                          | 允许的能力                 | 必需绑定                                                                                  |
| ------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------- |
| target-observe                 | 精确目标只读观察           | profile、目标意图、用途、nonce/期限；不得含写凭证                                         |
| source-read/export             | 固定来源只读、一致性导出   | 独立来源/用途许可、来源指纹、导出范围和输入 ID；不依赖未来候选                            |
| restore/sanitize/scan          | 只针对隔离本地副本         | 父输入 digest；restore、sanitize DML、scan 只读仍是不同子操作/凭证/operationId            |
| candidate-use / runner-command | 已批准候选或注册数据库命令 | buildProofDigest、已核实数据库身份、输入授权、命令版本；写入另绑定 dry-run plan/pre-state |

数据准备阶段不能携带候选写凭证；candidate-use 不能携带来源凭证。Schema/字段与负向测试在 R1/R3 小计划中定义，但以上边界不可再合并成 snapshot-source 大权限。

在场 launcher 持有目标排他锁、session nonce 和消费 journal。批准经真实验签、当前撤销读回和一次性消费后执行；父会话结束后未消费批准失效。状态未知不能换 ID 重试，必须以相同幂等键核对/reconcile。单操作员的批准和执行不宣称双人分权。

连接前校验身份与能力；连接后核对实际 DB OID/标识、角色、Schema、TLS。DDL 与业务 DML 分开命令、凭证、operationId、记录；runtime 不为 Schema owner。复用注册 handler、锁/事务、确定性 plan/CAS 和后置条件，不开放任意 SQL/Shell，不为全量旧命令批量升版。

### 3.4 证据与出口

链路保持 `输入/批准 → 操作 → post-state observation → 执行记录 → 结果签字`；不自引用、不覆盖失败记录。旧 full-RC/qualification 不接受此路径的记录，也不能为其重新包装。

原件在固定私密归档 create-only 保存，规范化 SHA-256、独立读回、owner 签收；失败历史一并保留。至少一份独立于执行目录的加密备份，默认 180 天。外部执行前真实位置/权限/恢复读回必须落实，不能只约定以后归档。OSS 上传另行批准。

最终签字只证明指定 Staging 的 Stage 1 主线验收，引用唯一 build proof、双链原件、浏览器/供应商结果和失败历史；不授权生产发布、不声明 Task 30 或完整 S1 完成。只有操作批准、没有完成证据时不得签字。

## 4. 合法副本的具体本地安全边界

### 4.1 前置盘点与选定机制

P0 后立即登记：现有副本的受控索引、来源/digest、脱敏扫描、读取/解密/使用授权、有效期；同时盘点本机能力。缺失如实标记 INPUT_UNAVAILABLE。只查看批准可读的非秘密元数据，不遍历秘密目录，不自动登录数据库或下载 payload。已确认本机存在 WSL2，不等于加密、swap/备份隔离已验证。

本路线选定 **专用本地 WSL2 Ubuntu + 每输入一次性 LUKS2 文件容器**，不购买新机器。不得使用当前 Docker Desktop 普通 volume、Windows TEMP 或已有业务 WSL 目录存原始数据。专用发行版命名 `stage1-snapshot-local`；发行版/工具版本和安装包摘要由 R3 小计划固定。安装和宿主配置变化需独立批准；P0/P1 不执行安装。

原始输入只在一个受控会话内获取、脱敏、使用；不保留可恢复的原始快照备份。若业务需要跨会话恢复 payload，须另审持久加密/密钥保管边界，不能临时把原始密钥备份出去。优先使用已有合法脱敏副本，但未知是否敏感的 payload 仍进入相同隔离边界。

### 4.2 获取前的硬条件

- WSL2 全局 `.wslconfig` 配置 `[wsl2] swap=0`；实际 guest `swapon --show` 必须为空。改动/重启会影响其他 WSL/Docker，先批准停机窗口，不自动执行 `wsl --shutdown`。
- 专用发行版关闭 Windows 自动挂载与 interop；原始会话关闭 shell history、命令 tracing 和 core dump。
- Windows 宿主可能保存本次 key/内存的 pagefile、休眠文件和 crash dump 机制必须经 owner 批准禁用并验证；仅 guest swap=0 或长期 BitLocker 保护不够，后者不能证明一次性 key 已销毁。当前宿主状态未验证，无法排除 key 落盘则禁止读取原始数据；执行中发生或疑似发生时，销毁状态只能为未证实，不得签销毁成功。
- 明确排除活跃工作区、key、LUKS header、发行版 checkpoint/export、宿主备份中的非受控复制；无法证明排除则停止。
- 原始 dump、PGDATA、WAL、数据库临时文件、还原/脱敏产物、可能带数据的日志及临时凭证全部在 LUKS mount 内。临时 PostgreSQL 原生进程也在该边界内，不借 Docker Desktop 数据目录。
- 来源导出只允许连接固定来源端点，结束后撤除来源凭证与连通；restore/sanitize/scan 禁止外网。子进程 stdout/stderr、错误转储和遥测也属于数据出口，必须留在加密边界并先脱敏，不能进入公共 CI 日志。副本候选测试禁止触达真实支付/签约/通知；真实供应商仅在 A3 独立批准的新 Staging 样本验收。
- 最终 API/Web/Runner 和数据库镜像消费副本时，PGDATA/WAL/temp/log/导出文件仍须位于批准的 LUKS 边界，隔离网络和 mock provider 配置须真实核验。不得因“已脱敏”转入 Docker Desktop 普通卷。精确挂载/容器执行命令由 R3 小计划定义，无法实现此边界就停止该链。
- 私钥属于 §3.2 的长期签名保管；副本 key 属于下面的一次性加密保管，两者不得混用。来源只读凭证不持久化到普通主机目录。
- 容量按实际原始库、恢复空间、WAL/排序空间及镜像大小预检，不拿压缩 dump 大小代替总空间。现有单个快照 1 GiB、单 JSON 1 MiB 上限不自动增加。

上述能力检查失败仅阻断获取/使用真实副本与提升，不阻断已授权的 P1 fresh 及业务开发。

### 4.3 创建、崩溃与销毁协议

以下是 R3 必须实现和以**合成数据**验证的固定命令原语，不是本轮运行指令或用户已批准的磁盘目标。R3 小计划需把每个路径绑定到其实际 creation record 后才能执行；任何物理磁盘、其他 mapper、非本 operation 路径均拒绝。

| 生命周期     | 选定原语及限定                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分配         | `/var/lib/stage1-snapshots/<inputId>.luks` 为唯一新文件；inputId 只能为受控生成的 32 位小写 hex。固定容量通过预检后，用 `fallocate --length` 创建；不覆盖已有文件                  |
| key          | `openssl rand -out` 在已验证 tmpfs 的 `/dev/shm/stage1-keys/<inputId>.key` 生成 64 字节随机 key，目录 0700/文件 0600；禁止 key/header 备份                                         |
| 加密         | `cryptsetup luksFormat --type luks2 --key-file` 仅操作记录中的新文件；`cryptsetup open --key-file` 建立 `s1snap_<inputId>`；核对 backing device 后才允许在该 mapper 上 `mkfs.ext4` |
| 使用         | mount 至 `/srv/stage1-snapshot/<inputId>`，使用 nodev/nosuid；所有敏感路径与 TMPDIR 指向该 mount；一个能力一个进程                                                                 |
| 正常结束     | 停止该临时 PostgreSQL、确认无消费者和打开文件，`sync`、卸载精确 mount、`cryptsetup close` 精确 mapper；不得强制忽略占用                                                            |
| keyslot 失效 | 独立批准精确 inputId 的销毁后，`cryptsetup luksErase` 仅处理已卸载的该 LUKS 文件；核验 keyslot 消失，再移除 tmpfs key 并核对 mapper/key 不存在                                     |
| 文件回收     | 失效和非敏感证据读回后才允许回收精确容器文件，不递归删除 workspace、发行版或宽泛目录                                                                                               |

正常结束保留销毁记录及脱敏的非秘密证据，不保留原始 payload/header/key。close 清理 mapping 中的 key，luksErase 清理 keyslots，而非擦写整个数据区；不声称 SSD 物理擦除。若发生未经控制的 header/key/内存/备份复制，不能宣告密码学销毁成功。

崩溃、断电或 key/session 丢失时，该输入标记 INTERRUPTED_UNKNOWN，不继续发布、不复用部分产物、不为恢复而另存 key。owner 先核验进程、mount、mapper、遗留 keyslot 和处置记录；确认原输入不可用并完成处置后，另行批准新的来源导出。本流程不修改来源，但来源可自然变化；重新获取是新输入，必须重新绑定指纹/时点、重新扫描和验证，不设计原始副本恢复服务。

依据：[Microsoft WSL 配置](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)、[cryptsetup close](https://man7.org/linux/man-pages/man8/cryptsetup-close.8.html)、[cryptsetup luksErase](https://man7.org/linux/man-pages/man8/cryptsetup-luksErase.8.html)。本机实际合规状态不能由文档依据代替。

## 5. 双链与验收门槛

候选使用同一真实 CI build proof；fresh/snapshot 各有独立数据库、manifest、operationId 和结果。副本恢复、ownership normalization、前向迁移与扫描必须先验证；source-read/export、restore/sanitize/scan、candidate-use 有各自批准/记录，不能跨阶段借凭证。

固定 PG17 测试镜像；实际 Staging 大版本、扩展、迁移头/ownership 另作真实读回。不同版本时加目标版本兼容演练或停止提升，不隐式升级 Staging。合成历史库仅为 synthetic-upgrade，不替代真实来源链。

P1 只做开发基线。最终候选才要求全量适用 DB 清单双链、实际最终镜像、完整等式 `collected = selected = executed = passed + failed` 且 failed/skipped/todo/filtered/cancelled 全为 0。资源可以串行调度，竞态仍用 barrier/真实并发和独立库，不能用单 worker 掩盖隔离缺陷。

API liveness 不代替 DB readiness；核对数据库身份、角色、TLS、session nonce/application_name。Web 用真实客户端捕获公共 API 请求并与 Web 内嵌 Base、manifest 三方比对。模拟 provider 不证明真实签约/到账。

验收包括 A 自助/B 辅助新订单、完整事实的成熟正常到期样本、Admin/Portal、实际电子签/主动支付，以及两次有意义的账单维护。两次维护既要 blockedCount=0，也要有正向应处理对象、正确 due/enqueued 和无重复/遗漏。Closure settledAt 不能反向证明支付；解除本订单占用不代表车辆可无条件上架。

## 6. 审批粒度与停止条件

P0/P1 可独立批准，只进行范围交接和无客户数据的本地测试；真实签发、源库读取、宿主安全配置、DDL/DML、部署、供应商调用、上传仍各自批准。R1/R2 与 B1/B3/B5 在 P1 之后分别提交小计划，不一次编写 R1–R4 全套实现。

全局评审集中核对：单一入口、单一候选身份、固定信任根、分阶段权限、无循环依赖、测试证据和外部出口。只有明确安全/数据/主线/可执行性问题形成阻断；结构偏好不扩成新平台。新费用、业务语义、权限、目标或信任边界变化必须单独批准。
