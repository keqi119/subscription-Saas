# 阶段 1：H1 快照完成记录与外部终态

本轮在 `a844d17b` 上补齐已有快照协议的最终读回和完成记录入口。没有新增业务功能、商业 KMS、schema 或 RAM 授权；阶段 1 尚未完成。

## 固定执行顺序

1. `snapshot-final-readback` 只接受 releaseAttemptId 和 snapshotRunId。H1 从加密卷读取固定配置及已有签名原件，调用实际 GitHub API，确认同 source/run/attempt 的 admission、snapshot-data、snapshot-custody 三个作业成功结束。
2. 使用 9 月 29 日已批准并配置的独立 `subscription-saas-stage1-snapshot-consumer` 读取五个快照对象，核验已有 H1 签名，同时保存供 R3 使用的实际 OSS 存储响应原件。这是工作流终态之后的新读取，不使用 hosted job 的 provisional artifact 充当最终证据。
3. Python 父进程验证实际子进程退出和输出文件摘要，删除原临时凭据 inode，确认缺席并等待单调时钟 TTL 与墙钟到期。失败保留 UNKNOWN，不产生成功终态、不自动重试。
4. `seal-completion` 只从固定文件读取前述事实，重新核对进程/会话终态和已有数据、发布、销毁、publisher-use 签名，生成既有 `snapshot-private-custody.v1` 和 `snapshot-producer-completion.v1`。裸 proof/receipt 摘要与签名包装的归档摘要分开计算。
5. completion 经既有独立 archive writer/reader 链保管后，`seal-producer-terminal` 接收该 archive reader 的授权摘要，重验访问证明、保管签名、原始读回正文及本地 completion 一致性，再生成既有 `producer-terminal-observation.v1`。生产者不轮询自己的完成状态。

完成记录只证明其实际证据链。最终阶段 1 收口仍需要真实 producer、同候选 R2/R3、两项迁移和 R4 验收。

## 输入和输出

固定受保护根目录：`/var/lib/stage1-volumes/main/snapshot-authority`。

- `snapshot-final-inputs.json`：仅含 selection 和 accessPolicyDigest。selection 是实际 GitHub 的 repository、runId、runAttempt、sourceSha 及三个 job ID；数据 job 必须匹配已有签名结果。
- `snapshot-access-policy-readback.json`：真实权限回读原件，其 canonical 摘要必须匹配 accessPolicyDigest。准备方须实际读取 RAM 并核对既有批准配置；本只读 OSS 入口不声称实时查询 RAM。两次 seal 都重新打开并核对原件、配置摘要及相同 GitHub selection，拒绝原件缺失或替换。不能填入 fixture 或把策略配置摘要当作实际回读。
- `snapshot-final-reader-session.json`：上述既有 consumer 角色、最长 900 秒的独立 STS 会话；会话签发时间不得早于 publisher 销毁回执。运行准备时将会话权限限定本次五个对象，不扩大角色权限。

固定输出位于 `/var/lib/subscription-saas/snapshot-output/<releaseAttemptId>/`：`snapshot-final-readback.json`、`snapshot-final-reader-terminal.json`、`snapshot-private-custody.json`、`snapshot-producer-completion.json`，最后是 `producer-terminal-observation.json`。均只创建一次；保留 `snapshot-final-readback.lock` 和失败记录。最终 custody 的 terminalAt 表示独立读取 GitHub 终态的观察时间，不冒充 GitHub 的原始完成时间。物理保留期继续以 OSS Last-Modified 与 WORM 为准。

每次 seal 还使用固定 spool 中的加密 `snapshot.enc`，重验六项 OSS 原始响应、11 份正文/记录原件以及实际 ciphertext 摘要，复用同一 XML/响应解析器；结果必须与 finalSnapshotReadback 的 bucket、WORM、对象、读取身份一致。不同实际请求各自的 Request ID 独立保留。密文须保存至外部终态 seal 完成；不为验签恢复明文，不发起重复 OSS 请求。

## 验证及当前限制

`045e08` 首先复现 completion 入口缺失，接线后 `0781a7` 四项入口检查通过。`5ef378` 发现实际 Python GitHub 读回的微秒时间戳与过严毫秒检查不兼容；修正为有限 UTC 精度后 `ac9499` 三项签名/终态检查通过，包括会话未到期、进程未退出、记录替换和读取顺序错误的拒绝。

`45c853` 最终 21 项归档、签名和入口检查通过。`12d977` 在实际 H1 Python 3.6.8 运行 36 项相关检查通过，并回读确认：无临时容器/attempt mapper，main/recovery 关闭，源 reader 为 NOLOGIN、password NULL、会话 0，PostgreSQL healthy，swap/core 保护恢复。云响应及完成记录用例使用 fixture，不是实际发布证据。

只读审查指出 seal 时原始 RAM/OSS 证据未再次绑定的两项 Important；`a42eab` 先复现策略原件被替换仍可接受。修正后 `ff0b0c`/`0227cf` 的 12 项相关检查及定向 lint 通过，含完整签名 completion 组装、跨 job/修改签名主体拒绝、六响应安全重放、缺失或额外原件、篡改 HEAD、错误密文和时间顺序拒绝。没有重跑不受影响的数据库、临时卷或完整加密生命周期。

本轮预检 `e72f84` Prisma validate 通过；`995a84` Staging 128 项迁移仍仅 `20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard` 待执行，专用隧道关闭。未改变业务代码或执行迁移。

已批准 archive 身份初始化此前已实际完成，本轮没有重复创建；archive 角色仍无新增 OSS 权限/AccessKey。实际对象授权、当前候选与批准链原件、首次真实 producer 尚待后续执行。后续新增 RAM 对象权限仍按用户要求提交精确差额确认。

## 实际安装

`8fbfee` 安装 control `sha256:d3a4618777566a13f2470e84537d40361634fa538119381900f20ba0624d6b15`，2,429 文件、12,027,702 字节。逐文件摘要、root 只读权限、实际依赖加载及非法输入拒绝验证通过。

`890114` 受控切换 adapter 为 `sha256:1c3dce843ce734565fa79ab8ee4fce906855101b7e00c0684661df98e048d54e`。Python attempt 摘要为 `a82d6c4d5d1bf790193207ce5430eb3fce8edfd3a5fe12a46307666c80b7cf2c`，其余固定控制文件未变；安装 manifest/文件摘要及私有入口拒绝检查通过，卷关闭、无 attempt 资源、GitHub 请求 0。worker `sha256:3cccfc7484628e3e8ae7564983ae52db17c539138bfa519728d35323a8c8ec8d` 未变化，没有重复安装。

最终只读复核确认上述两处绑定无剩余 Critical/Important。`7a405c` 合同检查通过：320 文件、93 schemas、13 commands、128 migrations，repositoryContractDigest 为 `sha256:a632a49a9a87cf70a244a5e1961a3f938ea19b2f00221557578b708bb137a81a`；迁移目录摘要不变。格式及 diff 检查通过。未生成真实 producer、完成记录或归档成功证明。
