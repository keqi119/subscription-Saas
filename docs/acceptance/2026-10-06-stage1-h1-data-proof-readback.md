# H1 制作结果与实际观察绑定

本切片补齐固定 root attempt 的加密使用证明装配和签名，并更新 H1 安装。它仍不是一次真实快照制作或阶段 1 完成证明。没有新增业务功能、RAM 权限、商业 KMS 或执行业务迁移。

## 实现

- 固定加密入口在一次实际 `encryptSnapshotStream` 调用前后记录 UUID、时间、envelope 摘要和 `BEST_EFFORT_COMPLETED`；不声称运行时副本被物理擦除。
- root producer 独立读取宿主 swap/core 状态、Docker 开始/退出时间、退出码、OOM 状态及 stdout EOF；临时卷记录实际初始 keyslot、销毁时间、空 keyslot 与旧密钥拒绝。
- 新增 `snapshot-h1-data-proof.mjs` 只组装、验证这些观察，不拥有观察或签名权限。成功证明允许 `memoryLocked:false`，但必须实际观察到 `hostSwapDisabled:true`；原有 v2 memoryLocked 分支和 v1 历史契约保留。
- root attempt 在 Runner、控制通道、producer、GitHub 路由/令牌和临时卷全部清理成功后，保存完整 `data-result.json`。固定 `seal` 入口重新核验当前 dispatch，从受保护的固定目录读结果和密文；签名绑定 `{proof,dataResultDigest}`，以 `h1-snapshot-data-proof.v1` 分域。调用方不能选择路径、证明正文或密钥。
- 产物为 `DATA_PREPARED` 和 `snapshot-proof.json`。其 `publishable` 仅是加密使用证明的成功分支；最终发布仍需真实 publisher、独立 custody 和完整 producer 终态。

## H1 安装回读

| 对象                 | 当前实际值                                                                |
| -------------------- | ------------------------------------------------------------------------- |
| worker bundle        | `sha256:88ac6e79d17249612748a079c0a7d05046a0e3b12bddc26c09ecde5d9ebb333d` |
| worker 内容          | 402 文件、1,434,970 字节                                                  |
| control bundle       | `sha256:7daf7a52bf14482c7141bf21e906f08ebc183df81f2f5d70107fb9f3babe310c` |
| control 内容         | 2,336 文件、11,470,553 字节                                               |
| adapter installation | `sha256:7c0558dafe8bc74cc03d78d2d83daffe3f5a3d4c1efa76a090c7c983facb5373` |
| producer Python 文件 | `f5ef0859eabc3f7f0b459acc8e284ee17c109fd975c1651dce2329686b1d7828`        |

`68bd58`、`1e704d` 校验两个只读 bundle 全部文件及隔离加载/非法输入拒绝。`f7a7dc` 从已核验的旧配置更新 Python 和安装配置，并回读所有摘要；未调用 GitHub、未解锁主密钥卷。新 digest 目录不覆盖旧 bundle。

## 有限验证及实际失败

- H1 `394fca`：两项加密定向测试通过，包含实际 fixture 加密及新 proof builder 的成功/负向断言。此前 `463408` 因缺少 cryptoOperation 失败；`cb5983` 是探针未携带 environment-policy 依赖，修正探针后通过。fixture 观察不是生产原件。
- `28b4e0`：11 项 producer Python 和 3 项 v2 schema 定向测试通过；`f96e1e`：7 项 authority/worker 测试通过。新增 worker 字段交接断言由 `eede2c` 单项通过。H1 Python 3.6.8 `1c7145` 的 19 项相关测试通过。
- 首次 native 检查 `9cf20c` 被探针 finally 的缺字段断言遮住诊断。独立 `ade2d5` 确认 producer 仍固定旧 bundle 文件数/字节数，返回 `H1_PRODUCER_BUNDLE_INVALID`。依据实际新 manifest 对齐两项常量、修正探针诊断后，`3cbe52` 通过；不是忽略失败或放宽 bundle 摘要验证。
- `3cbe52` 实际新建 1 GiB LUKS 卷、目标 PostgreSQL、未启动 worker；两次宿主观察均为 swap 禁用、core 禁用、RLIMIT_CORE `[0,0]`。keyslots 从 `[0]` 到 `[]`，旧密钥拒绝，卷删除，swap/core 恢复。源角色未启用、未读业务数据、未启动数据 worker。
- 新 SSH `ca4049` 独立确认临时容器和 mapper 均无残留、attempt 目录只余锁文件、主/恢复卷关闭、Staging PostgreSQL healthy。
- 合同目录初次因新增文件排序失败；排序修正后 `02f16f` 通过：312 文件、92 schemas、13 commands、128 migrations。运行包不含该目录文件，排序不改变已安装 bundle。
- 生产 JS 与 scripts 测试的定向 ESLint 通过；两个 foundation 测试文件的根 ESLint 配置缺少 Node globals，另有三个既有未使用变量。补充实际 Node globals 做前后比较后无新增诊断；未为此扩改全仓 lint 配置。格式及 diff 检查按提交前结果记录。
- 一名 Sol medium 子 agent 只读审查 proof/signing 边界，未发现可确认的运行阻断或错误证明；没有重复测试。

## 收口仍未完成的工作

1. 接入既有 publisher 和独立 reader，将固定 DATA_PREPARED 结果接至真实对象读写及三个 jobs 的完成证据。
2. 完成同候选 build/source-fresh 后，准备实际 dispatch authorization 与 current-revocation 原件、独立 custody 和精确两对象 RAM 差额。新增对象权限仍须用户确认，已批准的身份初始化无需重复确认。
3. 配置真实 H1 authority/producer inputs，执行首次真实 admission/JIT/producer；随后完成同候选 R2/R3、两项迁移和 R4 验收。

dispatch authorization 不含 producer run ID，可先于 workflow 生成；实际 run/job 出现后再绑定 producer crypto authorization，无需新增握手平台。当前 job 名称契约与最终 payload 的 OSS 字段限制须在接线时对齐，不伪造观察值。

本轮预检 `94e3f8` Prisma validate 通过。`ac68f3`/`d34b78` 实际 Staging 128 项迁移中仍仅 `20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard` 待执行，专用隧道已关闭。迁移目录摘要保持 `sha256:65ebe3208fc618ae82ad24f66b793e9bddd7464526dd45b8a0d9893d24a0ff62`。
