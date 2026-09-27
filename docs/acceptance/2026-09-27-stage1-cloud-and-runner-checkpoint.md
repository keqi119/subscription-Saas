# Stage 1 加密存储准备与 R2 父命令断点（2026-09-27）

本记录保留当天各次真实断点，以本节最新状态为准。R2 正常 dry-run → apply → verify → replay 执行链已通过并提交；异常恢复、真实数据库及最终候选验收仍未完成。没有执行业务迁移、部署、真实候选 CI 或关闭阶段 1。

## 最新状态：正常链通过，真实发布仍开放

提交 `aee01e39` 包含已实际验证的 R2 正常链及 H3 原件门禁。第八次正常用例自然结束，host / Node exit 0，1 pass / 0 fail / 0 skip；同一 ref 的四个阶段均完成，实际 launches=4、credentialReads=15、observerConnections=1。七个拒绝场景均保留 launches=2、credentialReads=9、observerConnections=1，没有新增启动或凭证读取。1194 份原件的完整集合、长度和 SHA-256 已由 root 独立核对，有限源码复核 ACCEPT。该测试使用真实 Node 子进程、协议帧和保管路径，但 PostgreSQL / CLI 边界为受控替身，不能计为线上迁移或真实 H3 验收。

提交时逐字节核对并只入库已测的冻结源码、冻结测试；未运行的 UNKNOWN/reconcile 与 replay-loss 测试单独保留为工作区改动。下一步仅运行这两个必要场景，不重复已通过的正常链或旧容量矩阵。R2.2 整体门禁、独立结果 verifier、严格来源读取复用和真实 PostgreSQL 两阶段入口仍开放。

提交 `620857ff` 修正了 PostgreSQL 17 快照导出对 DEFERRABLE 的错误前提，保留 REPEATABLE READ、只读事务、snapshot ID 和来源指纹检查；脱敏策略仅明确支持已核实的 Staging 与候选两个迁移 head。现有 snapshot-export 测试 20/20 通过。真实 SSH 只读检查确认 Staging 已完成 126 条迁移、无活动失败项，候选有 128 条；两个待应用迁移仍为 `20260925090000_stage1_operational_completion_terminal_shape` 与 `20260925091000_stage1_operational_completion_settlement_guard`。本轮没有执行导出或 DDL/DML。本地 migrate status 仍因缺少 `datasource.url` 返回 1，不能将只读远端检查写成本地命令通过。

提交 `775a489b` 仅增加 R3 三阶段消费请求及签名绑定的闭合校验，原 contracts 测试 76/76 通过、有限复核 ACCEPT；仓库合同校验实际 exit 0，189 个文件、74 份 Schema。prebuild 不依赖未来构建或当前 attempt 的 producer；v1 不变，v2 纯校验不授予执行权限，现有生产 session 继续拒绝消费请求。真实 scope / destination / allocation 原件读取、session 接线、H1 密钥释放和认证后远端恢复仍未实现。

官方 CLI 续期已成功用于新 RSA 恢复卷密文的 OSS 上传和完整 1 GiB 回读，当前没有等待续期的阻塞，详见[非商用密钥保管实测](2026-09-27-stage1-noncommercial-snapshot-key-custody.md)。仅证明同主机独立加密卷恢复及异地密文完整回读；异机解密恢复、真实 CI 独立 writer / audit-reader 身份验证仍未完成。商用 KMS 不在实施范围内。

阶段 1 后续先完成 R2 异常恢复、结果核验入口和必要用例，并接通合法快照消费及固定远端执行；再对冻结候选执行受保护构建 / H2，完成依赖这些可信输入的 R2 真实数据库验收与 R3 fresh / snapshot 双链；按发布链对齐两条迁移并恢复 API / Web；最后执行 R4 A/B 主线、签约支付回调、激活、到期收口和维护恢复的真实验收与签收。后文较早断点中的“仍等待登录”“H3-B 未接通”等描述仅为历史事实，不能作为当前状态。

## 07:00 UTC 后续：同 ref 历史交接与 H3 原件合同

候选 `99ff3c0d` 已提交同 ref 原迁移历史重开和 H3-B 缺件停止增量。实际 RED 为 Node/host 1、0 pass / 1 fail；修正后唯一对应 GREEN 为 Node/host 0、1 pass / 0 fail、537,301.359 ms。用例先完成真实 Node 子进程的 dry/apply，再调用同一 ref；第二次调用前后 launches=2、credentialReads=9、父 observer DB 连接=1，原 baseline 和两个原请求均保留。PostgreSQL/Docker 仍为受控替身，不是实际数据库验收。独立复核两源码及复制清单一致，并逐件核对 1,710 份保留原件长度/hash 无差异，有限 ACCEPT；未重复旧容量或中断矩阵。

当前 H3-B 即使存在仍安全拒绝，尚未实现正向放行。下一片必须在任何新命令前拒绝额外已消费迁移历史，保留并重开 UNKNOWN 已有 result，再完成 H3-B 原生权限、原 writer 退出及 provision 撤权/退出来源核对。verify/replay/reconcile、独立结果 verifier 和真实 PG 两阶段仍开放，不能将上述单例计为完整 R2.2 通过。

合同补充已在 `cc098de3` 经有限复核后并入既有 R2 plan §2.1/§2.5.1：H3-A 私有 v2 显式记录批准角色名与创建后 OID；六种固定 SQL 原件与既有 RawRef 闭合，包含实际连接身份、完整权限清单、跨库 provision 会话及真实 grant/revoke 前后顺序。H1 获批 profile 不变，不新增公共接口、自动权限服务或测试文件。下一片只在既有 launcher/test 内实施。

保留原件位于当前候选 `runner-second-stage/` scratch 的 `history-missing-h3b-{red,green}.log`、`first-gate-{frozen,results,originals-hashes}.json` 和 `first-gate-review.md`。GitHub 只读复核确认远端 main 仍为 `f8ed9440`，受保护环境仅允许 main，审查人为 keqi119；没有 push、合并、触发 CI 或修改环境。当前不需要用户补充操作。

## 06:19 UTC 后续：首阶段父流程与中断保管

本轮 10 文件修正提交为 `c7cfed2b05c4c86b19f19357ca4733ce7ba54b66`，独立有限审查 ACCEPT。隔离整合候选从业务/H1 分支 `c2cd59d6` 建立，先以 `9521f6d3` 合入已提交发布基线，再整合此修正；逐文件核对 10 个冻结摘要相同。API/Web 与 H1 两份获批公件相对原分支无差异，repository contract 的 181 项恰为两分支并集。R2 plan 保留两侧新增约束及 READY 澄清，旧输入缺口明确标为历史。新目录通过离线 frozen-lockfile 安装（忽略安装脚本）；Prisma validate exit 0，migration status exit 1，具体为未提供 datasource.url。预检禁用 dotenv 且清空该子进程 DATABASE_URL，没有连接数据库，也未把此失败报作迁移通过。

受控真实 Node 管道的完整 dry-run → apply 用例实际 Node/host exit 0，1 pass / 0 fail。两个 child 均自然 exit 0；dry-run 执行 2 个工具，apply 执行 11 个工具。apply 完整 stdout 为 1,143,875 bytes，两次独立工具输出各 402,009 bytes，最大帧 537,765 bytes；归档、独立重开、共享 assessor 和 session 收尾通过。此处使用 PostgreSQL double 和受控工具输出，不是线上迁移、真实 reference DB 或最终镜像验收。

本增量限定 MS2 完整 stdout 及经协议/身份绑定的 prefix raw 为 2 MiB；单帧、单工具、普通 raw、stdin、stderr 和 MS1 的原限额保留。另修复实际结果时间采样倒序、多个归档写入与目录一致性检查互相干扰，以及工具终态缺失时错误声明整体关闭的问题。时间缺陷的 RETURNED/THREW 两个直接用例均有真实 RED → GREEN。

首个中断用例实际 exit 1：UNKNOWN 和真实进程退出已保存，但第二次调用新增一个零凭证 child，启动数 3 不等于预期 2。该失败和原件保留；当时第二次调用的完整计量未保管，不倒推其实际工具/凭证计数。随后在可信 session 打开后、原观察/attempt/child 启动前补仅用于拒绝的已消费迁移历史检查；共享 sign/consume 最终历史裁决保持。只重跑原中断用例，实际 Node/host exit 0、1 pass / 0 fail、274,178.663 ms：原 apply 被 SIGKILL 后保持 INTERRUPTED_UNKNOWN，result/finishedAt 为 null，真实 parent CLOSED 保留，缺失的工具终态未伪造；第二次调用前后 launches 均为 2、credentialReads 均为 9。

相关真实日志为发布工作树 runner-command scratch 中的 `capacity-parent-full-after-archive-fix.log`、`capacity-parent-apply-loss.log`、`capacity-parent-apply-loss-after-stop.log`。最新中断运行源冻结于 `stage1-stop-frozen-source-hashes.json`；正例在其后的 STOP-only 修正之前运行，没有为了该拒绝门重复正例。第二次调用的原件和实际前后计数另存 `apply-loss-reinvocation-*`，没有覆盖失败目录。

剩余工作为同 ref 的 H3-B 原件门禁和 verify/replay/reconcile 父端分发、独立结果 verifier 与真实 PG 两阶段入口、最终候选受保护 CI/H2、真实迁移对齐、R3 同候选双链及 R4 真实验收。当前入口仍拒绝已有已消费迁移历史再次进入首阶段，不能据此声称恢复或第二阶段已实现；本轮没有重跑旧业务测试。

## 04:26 UTC 后续：精确批准与实际主机 loader

用户明确批准 profile digest `sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541`；收到确认后记录时间为 `04:08:59.000Z`。批准原件摘要为 `sha256:2558d9ba079dd5456780a45e2b94ddac501419d9fbfa325d7f7db4f3169bece1`。服务器 CreateNew 写入加密 archive 并独立重开，然后生成 binding、保存 profile 副本，再写实时 `04:14:07.359Z` 的 GENESIS 至 journal/archive/backup 及固定 sequence 0 槽。GENESIS 摘要 `sha256:d822434b9c8696b68bb653418a513f43f0bbeb0f2a6ad6c1b22e8f07d65bbbcd`；没有使用先前本地 payload 中未落地的草拟 GENESIS。

实际初始化 exit 0；本机随后使用生产 encoder/Schema 验证返回 canonical 字节、digest 和批准/binding 逐项等式，exit 0。公开 profile、binding 与两项 manifest 引用已提交到原工作树 `d198b813a27a0d21c711ed841ed0c9e2adcafebc`，完整 repository contract 178 项读回一致，digest `sha256:c10ff7672bdbfa7d587e5063843365766c9a530fd7601bca35e32c5681f68391`。这次配置预检仍为 schema validate 0 / migration status 1（dotenv 禁用、无 datasource.url、未连接 DB）。

为运行真实 H1 loader，仅转移该提交的 H1 源码、所需 contracts 及现有六个纯 JS 依赖，672 个文件全部逐字节读回匹配；包 438,604 bytes，SHA256 `2a80da06f9fbaf43110826d1fcfbce1a00797182aecfb0735034b0babdfa2375`。不是完整发布 checkout、镜像构建或 CI。服务器 `/opt/stage1-h1-loader-d198b813` 中的原始 `loadFixedManualProfile` 于 `04:22:56.075Z` 实际 exit 0：批准、真实主机/principal、五根权限以及 profile/binding/GENESIS 的 10 项独立读回匹配；无私钥读取、无 DB 连接，会话凭据根为空。事后独立 SSH 确认两映射/挂载关闭、underlay 空、临时 core 设置已移除，两个原 swap 已恢复。

初始 1 GiB OSS 密文仍完整保留。另将本次新增公开状态及实际校验证据作为 `approved-public-state.tar.gz` 存到同一 `h1-recovery/v1/20260927-4a424369-01d6-4ba5-825a-d86fb30140ad/` 前缀的新对象，未覆盖密文。该补充包 4,750 bytes，SHA256 `77a44e6f98c64b629ca368d6d028fd9437cfafc0e888627f0f5d431fdde2ae5c`；上传及独立 Head/ACL/Get 均 exit 0，private/AES256，完整下载摘要一致。它不包含私钥、解锁材料或凭据；仍未验证异机解密恢复。

独立只读审查确认本轮 H1 身份/批准、加密五根、GENESIS、同主机独立卷恢复及生产 loader 均有实际依据，无新增阻断 Important。最终候选同源重验、异机恢复及整体 H1/H2/H3 发布验收仍开放，不将源码子集检查或 OSS 可下载等同于完整发布通过。原件为 cloud scratch 的 `h1-explicit-owner-approval-receipt.json`、`h1-initialize-state-result.json`、`h1-initialization-independent-validation.json`、`h1-public-configuration-validation.json`、`h1-loader-source-readback.json`、`h1-verify-loader-result.json`、`h1-public-state-backup-{manifest,upload,readback}.json` 与 `h1-actual-configuration-review.md`。

R2 上一个小批的固定最多 8 项 `allSettled` 复核已独立接受，无新增 Critical/Important；有效 RED 1、同一用例 GREEN 0。新单次计时保持全部检查计数，输入循环 9.695 → 8.653 秒，但总窗口 15.727 → 15.678 秒，未证明整体过期问题已解决。诊断仍为编码凭据前固定停止 exit 1，0 凭据/DB/工具，不是全链正例。当前唯一代码写入者进入已明确的 MS2 总流 2 MiB 四路径修正，仅做相关容量/边界验证；该改动尚未验收，未重跑旧业务套件。

## 03:40 UTC 后续：真实密钥与有限耗时修复

实际密钥操作 exit 0：`03:39:03.374Z` 在主卷生成 Ed25519，主文件为 `/var/lib/stage1-volumes/main/key/signing-ed25519.pk8.pem`，备份为独立 recovery 卷的 `backup/bootstrap/signing-ed25519.pk8.pem`。两份均 CreateNew、uid 0 / 0600、fsync 并独立重开验证；私钥未离开服务器或输出到日志。负责人为 `keqi119`，执行 principal 为 POSIX uid 0。

公钥 SPKI DER 指纹为 `sha256:7146f2e00f4a8e70183a64f3e8c7ebfa8e66926f60d18442e3d5ac4a09e408ef`。主卷关闭后，仅重开独立备份卷，在另一个 Node 进程读取备份，验证原挑战签名并签署不同的恢复挑战，`03:39:04.902Z` 完成。主控随后仅用公钥独立验证两份签名、同一指纹及不同挑战，exit 0。原件为 `h1-key-recovery-result.json` 和 `h1-key-public-signature-verification.json`；原初始化/密钥生成脚本不得重跑。

操作后两个卷均卸载、映射关闭、底层目录为空，swap 恢复，临时 coredump 设置移除。此为**同主机独立加密卷恢复**；两卷仍共享物理盘，尚未验证异机恢复，Windows DPAPI 当前用户依赖仍在。GENESIS、具体 profile/批准/owner binding/sidecar 和真实 loader 尚未完成，H1 继续开放。下文“空卷、尚无签名密钥”是此前断点，已由本节推进，不作为当前状态。

R2 只做了一次停止在首个真实 dry credential 发送边界前的计时诊断：实际 exit 1 / `MANUAL_DIAGNOSTIC_BOUNDARY`，0 credential 写入、0 DB 连接、0 工具，未进入 apply；不是成功正例。本次 receipt 签发至边界 15.727 秒，三次 admitted recheck 中 232 个 held inputs 和 4 个 checkout pins 的循环累计 9.695 秒，约占窗口六成。git、catalog 和 custody 实测均非主项；此前 47.136 秒超时原件仍保留，不能被这次未过期诊断抹去。

当前最小修复仅针对这些彼此独立 item recheck 的固定最多 8 项批次：每项内部检查顺序不变，所有已启动项 settled 后才能返回或拒绝；仍保留最新撤销/session/receipt 检查及 30 秒期限。实现和定向验证由唯一代码写入者进行，尚未声明通过。此次开发预检中 schema validate exit 0，migration status 因未提供 `datasource.url` exit 1，未连接数据库、未改业务逻辑。

容量前向裁决现已明确写入 [R1](../superpowers/plans/2026-09-06-stage1-r1-manual-trust-and-authorization-plan.md#2026-09-27-ms2-原始总输出的有限前向修正) 和 [R2](../superpowers/plans/2026-09-06-stage1-r2-runner-migrate-verify-plan.md#2026-09-27-ms2-真实规模运输修正)：只允许 MS2 完整 stdout／经绑定验证的 stdout-prefix raw 为 2 MiB，其余角色及 MS1 保持原 1 MiB。该生产容量改动与实际完整运输验证尚未开始。

## 云账号和实际存储

### 04:05 UTC 后续：OSS 独立密文副本已回读

在 recovery 卷关闭、mountpoint 为空的状态下，按已知 LUKS2 UUID `867c622b-e066-4a9a-88eb-766a4f27528c` 校验源身份，经 SSH 二进制流导出 1,073,741,824 bytes 到 Windows 当前用户私密目录。源文件前后身份/尺寸/时间戳不变，完整 SHA256 为 `f3e9d46ff6a761362aba65f0ef3d1f174e676de428182bdea5d85ee158007ea1`；本机独立读回相同。导出未解锁卷、读取私钥或搬运解锁材料。

复用既有 `stage1-keqi119` 官方 OAuth，以 `forbid-overwrite=true`、private、AES256 上传至指定桶 `subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai` 的新对象 `h1-recovery/v1/20260927-4a424369-01d6-4ba5-825a-d86fb30140ad/recovery.luks`，实际 exit 0。首次本地进程启动因未规范化的可执行文件路径失败，未发出 OSS 请求；该失败原件保留，随后以已解析绝对路径接续，没有覆盖或重试已有对象。

六项独立云端读回均 exit 0：对象长度准确、SSE AES256；对象和桶 ACL 均 private、owner `1457643390906675`；WORM 状态 Locked、210 日，桶默认 AES256，versioning 响应无 Status 元素。随后从 OSS 另行下载到新的私密文件，实际 exit 0，完整长度与 SHA256 均与服务器导出一致。没有修改桶策略、锁、H2 角色或现有对象。

这证明异地密文对象已保管且可完整取回，**尚不是异机解密/签名恢复**。已完成的密钥恢复仍是上述同主机独立加密卷验证，Windows DPAPI 当前用户恢复依赖仍在。两份本机密文副本保留在 `C:/Users/keqi_119/AppData/Local/Stage1CiphertextBackups/20260927-4a424369-01d6-4ba5-825a-d86fb30140ad`；不把该副本当已批准 profile/发布凭据。

上述运维原件在同一 cloud scratch 的 `h1-ciphertext-export-result.json`、`h1-ciphertext-upload-result.json`（首次启动失败）、`h1-ciphertext-upload-resume-result.json`、六个 `h1-ciphertext-{api}.json`、`h1-ciphertext-download-result.json`。本次 [H1 profile 具体草案](./2026-09-27-stage1-h1-profile-approval-proposal.md)已通过 Schema 和 canonical digest 校验；仍待精确 owner 确认，未生成批准原件/sidecar/GENESIS。

第二次官方 CLI OAuth 正常完成，但 `stage1-ecs-keqi119` 的实际 STS 仍为 OSS 账号 `1457643390906675`，不等于服务器所属账号 `1335332669126231`。用户明确无法登录后者／由其他账号代管，因此停止重发登录要求，使用已获授权的 SSH 配置主机级加密。云盘底层加密仍 UNKNOWN；本次不冒称已取得 ECS 管理权限。

`139.196.227.195` 已安装发行版 `cryptsetup 2.3.7`。两个新建容器各为 1,073,741,824 bytes，实际分配各 1,073,745,920 bytes；没有格式化已有磁盘、删除旧数据或改动系统分区。

| 用途   | 密文文件                                   | LUKS UUID                              | 卷内私密目录                                                    |
| ------ | ------------------------------------------ | -------------------------------------- | --------------------------------------------------------------- |
| 主卷   | `/var/lib/stage1-ciphertext/main.luks`     | `97c61d0d-fa2c-42bb-9ba7-66f8724bc29b` | `/var/lib/stage1-volumes/main/{key,journal,archive,credential}` |
| 备份卷 | `/var/lib/stage1-ciphertext/recovery.luks` | `867c622b-e066-4a9a-88eb-766a4f27528c` | `/var/lib/stage1-volumes/recovery/backup`                       |

实际 header 为 LUKS2 / AES-XTS 512-bit / Argon2id 128 MiB、单线程。各卷使用独立随机解锁材料；Windows 当前用户 DPAPI 保护文件位于 `C:/Users/keqi_119/AppData/Local/Stage1VaultKeys`，目录及两个实际文件均核对当前 SID 所有权与唯一访问规则。秘密只经已核 SSH 主机的标准输入传入，未置于 argv、环境、脚本、仓库或日志；受保护文件不得删除或被新生成的材料覆盖。

主机在秘密操作前停用实际两个 swap 文件，读回合并后的 coredump 配置 `Storage=none / ProcessSizeMax=0`，秘密 worker 使用 core limit 0；操作后 worker 退出、卷卸载、映射关闭，再恢复原 swap 和临时 core 设置。两个卷均实际重新解锁、以 `nosuid,nodev,noexec` 挂载并读回五根 uid 0 / 0700，最后关闭。独立事后读回确认：没有残留 mapper，底层 mountpoint 为空，临时 core drop-in 已移除，原 swap 已恢复，密文文件 uid 0 / 0600。最后观察根盘空闲 9,909,067,776 bytes；没有把相较前次探测的空闲变化归因于本次清理。

首次操作退出 1：主卷已成功格式化，但该版本不支持 `luksDump --dump-json-metadata`。保留主卷、解锁材料及原始失败；读回精确 UUID 后使用新接续脚本，只为无文件系统的已知主卷建立 ext4，并新建备份卷，未重做主卷加密或更换密钥。接续退出 0；实际重开、挂载、关闭和事后读回均有原件。

**H1 尚未完成。** 当前五根为空，尚无 Ed25519 签名密钥、GENESIS、签名密钥备份恢复、profile/批准/sidecar。此次只验证卷能重新解锁，不是同公钥恢复演练。两卷仍在同一物理盘，不能据此声称主机丢失可恢复；后续按已批准范围安排私有密文副本及恢复读回，并明确 Windows DPAPI 恢复依赖。卷默认关闭，不自动解锁；任何后续秘密操作须重新实施同一内存/转储保护。现有容量不代表 R3 数据快照容量已满足。

运维原件位于发布工作树 `.superpowers/sdd/2026-09-25-stage1-trusted-build-input-preparation-plan/cloud-setup-20260927/`：`ecs-oauth-completed-account-mismatch.json`、`host-luks-prerequisite-probe.json`、`h1-empty-volumes-setup-result.json`、`h1-volume-failure-readback.json`、`h1-empty-volumes-resume-result.json`、`h1-empty-volumes-final-readback.json`。原 setup 和 resume 脚本分别保留，不再次运行初始化脚本。

## R2 真实失败及下一步

发布工作树基线为 `9e6829c01463384da0ca9ddc9e52a5ca1f126fcc`。三个父命令实现/测试文件为冻结未提交 WIP；独立只读审查没有发现有充分依据的新增 Critical/Important，但 verdict 为 **No / 不可视为可发布**，因为真实正例仍失败且容量合同未解决。

最新唯一正例 actual Node/host exit 1，1 test / 0 pass / 1 fail，`MANUAL_TIME_INVALID`。dry-run handoff 原件从 `03:14:28.543Z` 到 `03:14:58.543Z` 有效，实际拒绝事件为 `03:15:15.679Z`：凭据前已过期，0 DB 连接、0 工具，未进入 apply。移除两次冗余全图校验后仍失败；保留 AUTHORIZE 及 CREDENTIAL 两个真实发送边界的最新 session/消费/撤销检查。停止盲目重跑完整链，先定位 guard/档案读回的耗时；不延长 30 秒或回填时钟。此前曾执行 dry 2 / apply 11 个工具但共享验收失败的原件也保留，不能拼接成一次成功。

实际本地 Prisma 7.8 `from-empty → to-schema` 离线 SQL 为 402,009 bytes，SHA256 `7a066863c903c3e48d5d2d23903ba3e269db2067e79db9c671d5daa996ce01da`。两份完整 base64 为 1,072,024 bytes，仅 SQL 即比旧完整 stdout 1 MiB 上限多 23,448 bytes。此前 462,831 bytes 是 schema 源文件，不能用于该推算。离线文件不是独立 reference DB 或 admitted expected 原件；实际 datasource introspection 字节尚未取得。

独立容量审查建议仅对 MS2 完整 stdout／经绑定验证的 prefix raw 明确有限 2 MiB 例外，JSON、单帧、单工具 raw、stdin、stderr、普通 raw 及 MS1 保持原限制。尚未修改规范或生产限额，须先形成精确前向变更，再用真实规模离线负载验证完整运输/独立重开；不省略第二轮工具或原件，不泛化放大所有输入。

三文件语法、格式、diff 检查通过；默认 mjs lint globals 配置及已有一处无用赋值诊断保留，未冒称全仓 lint 通过。新增负向矩阵、完整 R2、H3-B、R3 双链与 R4 真实验收均未完成，未重复旧业务测试。详细日志、冻结 SHA256、审查与尺寸原件在 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/runner-command/`。
