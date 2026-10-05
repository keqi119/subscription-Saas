# 阶段 1：H1 有限归档执行与访问回执

本轮接续 `cb278198`。已批准的 archive writer/reader 身份初始化此前已实际完成；本轮不重复初始化、不新增 RAM 权限或 AccessKey。实现既有独立归档路径，不新增业务功能。

## 实现边界

H1 固定 root 入口增加 `archive-write`、`archive-read`、`archive-seal-write`、`archive-seal-read`，请求仅含 operation 与 authorizationDigest。写入、读回分别执行独立子进程；父进程只观察固定会话文件的 inode，不读取凭据内容。

执行前验证受保护目录中的归档授权签名、负责人身份、实际安装包 source/runtime 摘要、精确对象原文、四份批准/应用/资源回读原件摘要，以及当前撤销状态。生成的 RAM 策略摘要必须匹配授权。每次传输时间检查同步重新读取当前撤销状态；本进程内拒绝序号回退或同序号不同正文。

写入仅使用既有 create-only OSS 传输；读回使用独立身份和既有六项原始响应采集。读回会话必须在前一次写入访问回执签发之后签发，绑定同一组对象及其已签名的写入终态。首次 bootstrap 使用既有人工信任锚和本地受保护原件，不依赖尚未生成的 OSS custody 或 GitHub dispatch。

父进程在实际子进程退出后移除原会话文件，验证缺席，并同时等待完整单调时钟 TTL 与墙钟到期；之后才能写入 terminal。失败保留 UNKNOWN 记录及已知 IO，不生成成功终态，不自动重试。另一独立签名操作重新核对实际 IO、terminal、会话缺席和签名身份，生成 `archive-access-proof.json`；原始 receipt 摘要与完整签名包装摘要分别返回。

访问回执仅证明授权内的 IO 和会话终态，尚不代表该回执自身已经独立保管，也不代表阶段 1 已完成。

## 独立保管补齐

接续 `a844d17b` 的实现新增 reader seal 内的既有 `custody-receipt.v1` 和 `authoritative-custody-observation.v1` 生成。先重验六项实际 OSS 响应及原文字节，再核对同对象的已签名 writer 终态、ETag、正文摘要和字节数。保留期限严格来自实际 Last-Modified 加 Locked WORM 天数，必须覆盖 writer 终态、快照有效期及下游保留要求；不足时拒绝。

每个 observation 使用既有独立签名域。`archive-custody.json` 是这些既有对象及签名的有序包，含授权摘要、writer 访问证明摘要和保管策略；reader 访问回执的 `observationDigest` 绑定**整个包**，防止只签 observation 数组时遗漏 writer 证明关联。`ioDigest` 仍独立绑定实际 IO。此前未生成真实访问回执，不涉及历史签名转换。

reader seal 先以 create-only 写出 `archive-custody.json`，再写出最后的 `archive-access-proof.json`；公开响应增加 `custodyDigest`，writer 对应值为 null。不会把此包自身标为已独立保管。

定向验证：`07caba` 缺少 builder 的失败后实现；`a46976` 先复现 writer 证明摘要未绑定的问题，修正全包摘要后 `1fa552` 通过。最终 `45c853` 的 21 项归档/入口/终态检查通过；只读审查确认此归档改动无剩余 Critical/Important。对应 Python 协议随完成记录入口合并验证，见下述完成记录实施文档。

## 固定输入和输出

固定加密根目录为 `/var/lib/stage1-volumes/main/snapshot-authority`。调用方不能传入路径、时钟、凭据或签名正文。

- `archive/<authorizationDigest 的 64 位 hex>/authorization.json`：`{authorization, signature}`，签名域 `evidence-archive-authorization.v1`。
- 同目录 `policy.json`：managementIdentity、revocationPolicyDigest、owner、readers、downstreamRetainUntil、snapshotExpiresAt、legalHoldUntil。
- 同目录 `changePlanDigest.json`、`externalChangeApprovalDigest.json`、`applyProofDigest.json`、`resourceReadbackDigest.json`：真实批准链原件，不能使用测试 fixture。
- 同目录 `originals/<contentDigest 的 64 位 hex>.json`：与授权内容摘要、字节数和 canonicalDigest 同时匹配的实际原始字节。
- 读回目录另含 `predecessor.json`：仅含前一次写入 authorizationDigest；必须能够从固定 spool 读取、重验其签名回执和 IO/terminal 原件。
- 根目录 `archive-revocation.json`：当前已签名 `{state, signature}`；使用既有 `i0-revocation-state.v1`。
- 根目录 `archive-writer-session.json` 或 `archive-reader-session.json`：分别为独立角色、最长 900 秒的临时会话；执行后由父进程删除。

授权的 `executor.runtimeDigest` 是实际安装 control bundle 的 manifest 摘要；`executor.sourceDigest` 是同一 manifest 中排除 `node_modules/` 后的文件清单 canonical 摘要。Python 父进程先逐文件校验实际安装字节。所有输入须位于已验证加密卷、root 所有且受限权限；签名密钥继续使用已批准 keqi119/H1 身份。

固定输出为 `/var/lib/subscription-saas/evidence-archive/<authorizationDigest hex>/`：保留 `archive.lock`，成功路径依次生成 `archive-io.json`、`archive-terminal.json`、`archive-access-proof.json`；失败生成 `archive-io-failure.json` 或 `archive-failure.json`，不会覆盖已有记录。使用现有 publisher 全局互斥锁。

## 已完成验证

- `ff4848`：新增读回前序绑定检查先因缺少实现失败；`158d9f` 三项授权、终态、前序检查通过。
- `502e41`：有效归档入口尚未路由，按预期失败；实现后 `7d59b5` 的 18 项相关 Node 检查通过，覆盖签名、摘要、撤销、期限、前序终态及现有 OSS transport/policy。
- `c3fa23`：Python 独立 seal 入口缺失，按预期失败；实现后 `0e210e` 在实际 H1 Python 3.6.8 运行 31 项相关测试通过。测试中的云响应为替身，不是生产证据。
- `0e210e` 实际宿主回读：无临时容器、attempt mapper；卷目录仅保留锁；main/recovery 关闭；源 reader 为 NOLOGIN、认证信息缺席、会话 0；源 PostgreSQL healthy，swap/core 已恢复。
- `1868ad` 首次定向 lint 发现四处测试 Node global 引用，改为 `globalThis.structuredClone` 后 `bfed07` 通过。没有运行全仓测试或重复数据库/加密卷生命周期测试。
- Sol high 只读审查发现 reader 签名仅验证摘要投影的问题。`1f3294` 先复现缺少原始响应仍可签发的失败，随后复用 transport 的响应投影及 XML 解析器，重新核验六份 response、12 份正文/记录原件的摘要和字节关系，再与 Head/Get、ACL、WORM、版本关闭和真实对象正文比对。`314f12` 最终 19 项相关检查通过，`e42a0b` 定向 lint 无诊断。
- `4a33a0` 合同目录检查发现新文件顺序不正确；调整排序后通过。没有改变既有 schema 或增加命令契约。
- `1f8dc0` 最终格式、diff 和合同检查通过：319 文件、93 schemas、13 commands、128 migrations，合同摘要 `sha256:d3dc739125b5866c0094ed7722493875c5116f6ef0a752f65a501a3e5230a48c`，迁移目录摘要仍为 `sha256:65ebe3208fc618ae82ad24f66b793e9bddd7464526dd45b8a0d9893d24a0ff62`。

本轮预检 Prisma validate 通过；Staging 128 项迁移中仍只有 `20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard` 待执行，专用隧道已关闭。本轮没有执行迁移。

## 实际安装回读

`ca2e0a` 安装 control `sha256:84dd458c7e515595c84acd25020e0b0e0a42eb41df17b00cdc8015abe8056b10`，2,427 文件、11,971,787 字节；逐文件摘要、root 只读权限、依赖加载和非法输入拒绝通过。

`75293a` 按旧配置摘要受控切换 adapter 为 `sha256:bfedc8cfde9e532818f2ab93a83ce3ea215b6143b4102698d25096245f30e877`。仅 Python attempt 入口改变，摘要为 `a608764788ee4f452138db79dfb8a9a7c9954d16d9560c0b746250e7738b338e`；其余 Python/entry 文件未改。实际安装 manifest 和所有文件匹配，private pipe 非法请求被拒绝；加密卷关闭、无运行 attempt，GitHub 请求数为 0。

`de4009` 确认 worker 仍为已安装的 `sha256:3cccfc7484628e3e8ae7564983ae52db17c539138bfa519728d35323a8c8ec8d`，403 文件、1,438,635 字节，没有重装。该调用中的旧 control 构建摘要已被上述最终安装摘要取代。

## 后续实际收口

1. 将这条归档路径的独立读回原件接入已有 authoritative custody 与 completion 消费入口，保持 bare receipt 与签名包装摘要区别。
2. 固定同候选 build/source-fresh，生成真实 dispatch/current-revocation 原件，准备具体对象的 RAM 差额供用户确认；已有身份初始化不再询问。
3. 执行首次真实 producer、GitHub 三个 job 的实际终态采集、终态后的 OSS 重新读回及 R3 声明；再完成同候选 R2/R3、两项迁移与 R4。

真实归档授权配置、凭据签发、OSS IO、签名访问回执尚未执行。不得把本轮单元验证或宿主安装回读标记为实际发布证据。
