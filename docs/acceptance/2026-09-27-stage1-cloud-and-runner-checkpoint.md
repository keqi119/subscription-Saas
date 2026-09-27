# Stage 1 加密存储准备与 R2 父命令断点（2026-09-27）

本记录保留当天各次真实断点。后续已完成服务器 Ed25519 密钥生成及独立加密备份卷恢复；R2 父命令链仍未通过定向正例。没有执行业务迁移、部署、真实 CI、签发发布命令或关闭阶段 1。

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
