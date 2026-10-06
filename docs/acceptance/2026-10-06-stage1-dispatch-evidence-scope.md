# H1 dispatch 证据范围核对

当前阶段 1 未收口。本记录纠正后续范围，不撤销已批准的 H1 三 job 方案或独立 RAM 身份初始化，不修改批准草案的原字节，不放宽旧 full-RC/qualification 验证器。

## 范围结论

旧 `2026-09-03-stage1-s1-execution-infrastructure-implementation-plan.md` 首页明确冻结 Task6 及全部 I 系列；9 月 6 日最小发布决策禁止自动恢复整套平台。10 月 5 日获批的 H1 选择 A 保留三 job、签名/当前撤销检查、精确路由和独立保管，但没有批准恢复完整 I0。

实际 `verifyDispatchAuthorization()` 只对两份 body 调用 `readExact`：本次 `rc-dispatch-authorization.v1` 和由 fresh nonce-bound response 指向的 `i0-revocation-state.v1`。每份仍须原字节、主体签名、custody receipt 和签名 observation；后者绑定实际对象/ACL/WORM/独立读取及保留期。它还要求实时签名撤销响应和持久单调 checkpoint。它不读取整套 I0 bootstrap/API/云审计原件，不判断 `I0_CLOSED`。

因此后续只补这两个原件的精确存取和现有核验接口。历史管理批准及 API/ActionTrail 记录继续保存在原私密档案中；不为它们扩展归档 proofType/schema，不伪装成已验证的 dispatch/custody 材料。身份初始化的 DPAPI 记录仍只是保管中的管理记录，不是 OSS custody。

## 本次实现

- `dispatch-evidence-scope.mjs` 只接受两种已注册 schema 各一份、每份不超过 1 MiB 的 canonical 原字节，核对相同 revocation policy，复制输入并生成两条精确内容地址。它没有签发权限。
- 实际 RAM `ValidatePolicy` 拒绝了对象路径中的 `sha256:<64hex>`；本次精确对象键统一为 `control-evidence/v1/<proofType>/sha256-<64hex>`，而 `canonicalDigest`/`contentDigest` 字段仍为 `sha256:<64hex>`。旧冒号键在授权及归档验证处拒绝，不改变 account、action、condition 或对象数量。
- `buildDispatchEvidenceRamPolicy` 只生成有限 RAM 草案。writer 仅两条精确对象的 Put；reader 仅这两条对象的 Get/GetObjectAcl 和固定 bucket 的六项必要属性读取。没有对象通配、写读混合、删除或 KMS；超过 2048 字节拒绝。旧 `evidence-archive-authorization.v1` 及其编译器保持不变，本接口不冒充该授权或其链条。
- `dispatch-evidence-oss-storage.mjs` 是 root 私有接口，无 workflow/CLI 参数入口。它只接受上述两个原件和固定 writer 或 reader 角色的至多 900 秒 STS，不负责取得凭据或授权；父控制面仍须先完成实际管理批准、IAM/STS 身份核验和固定安装核对。
- writer 发送禁止覆盖、private ACL、AES256 请求，关闭 SDK 重试；同一个实例中每条对象只尝试一次。冲突与结果未知区分，未知结果不能换对象/重新上传来改写历史。重启后也必须由父控制面对原操作 reconcile。
- reader 逐项实际读取 bucket owner/ACL、Locked 210 日 WORM、Disabled versioning、AES256、公共策略状态/BPA、对象 ACL、Head 和有界 Get stream。它对照被冻结的大小、原字节、摘要、ETag/Last-Modified，检查会话时效。返回事实及请求 ID，不签 receipt/observation，不推断 writer 已终止、批准有效或整体准入成功。

读取所需 RAM action 对齐 [阿里云 OSS 官方授权映射](https://www.alibabacloud.com/help/en/oss/user-guide/authorization-syntax-and-elements)：Head 使用 GetObject，GetObjectACL 另需 GetObjectAcl；六项 bucket 读取分别授权，不能靠旧 ACL/WORM 权限声称已经独立核验。

## 验证与实际边界

本轮开始工作树干净。`6983d2` 只读 Staging 为 PostgreSQL 17.10，128 条迁移，以下两条仍待执行；`69efe4` Prisma validate 通过。没有修改业务代码或应用迁移。

- `20260925090000_stage1_operational_completion_terminal_shape`
- `20260925091000_stage1_operational_completion_settlement_guard`

`9a85c4` 先确认 transport 缺失，`9c0fe4` 新增 transport 定向 5/5 通过；scope 编译器定向 3/3 通过。它们使用本地真实 canonical/schema 校验和流处理，云端 SDK 边界为测试替身；不能据此宣称真实上传、独立 STS、签名 custody 或 snapshot 已完成。后续限定复查如有发现，在本文件前向记录，不重复旧业务或长测试。

最终 `7f255a` 在本机 Node 24.14.0 对新增两个文件合并验证为 8/8、无跳过、exit 0；不是 H1 Node 22 或真实 OSS 验收。限定独立静态审查未见可证实的重要问题，并核对了实际 ali-oss 6.23.0 的响应字段与关闭重试行为。`30ad14` 曾发现测试文件缺少显式 URL import，补齐后 `adedcb` 限定 ESLint exit 0；`a77962` 格式检查通过。合同验证为 302 文件、92 schemas、13 commands、128 migrations，仓库摘要 `sha256:dcfaa4d6cef9c91529420882231fdaf3b36089e064250253ead445c27090a70f`，迁移摘要保持 `sha256:65ebe3208fc618ae82ad24f66b793e9bddd7464526dd45b8a0d9893d24a0ff62`。初次组合命令中 rg 的路径错误保留，不将其退出码冒充合同检查成功；最后独立运行合同检查确认退出结果。

本次没有应用新 RAM policy、创建 AccessKey、上传 OSS、解锁 H1 卷、注册 Runner、导出源数据、触发旧明文 workflow 或改变 Staging。两套已批角色仍无 OSS 授权。

## 收口的依赖顺序

1. 补固定 root controller 的实际 callback 和三个 jobs；运行包、workflow 与 root policy 的字节确定前，不生成虚假 dispatch。保留已完成的 signer/JWT/GitHub 读取/route journal/worker，不重建它们。
2. 将必要代码整合为同一最终候选并取得真实受保护 CI build proof。最小路线明确构建不等快照；当前 dispatch schema 需要真实 build/bundle/source/attempt，因此不能用 H1 主机批准替代这些值。
3. 冻结本次真实 dispatch 与撤销 state 原件，生成两条完整对象键及具体 RAM 差额交用户确认。不得先给目录通配或用管理身份冒充独立 reader。完成真实 conditional write、writer 终态、独立读回、签名 custody 和受保护当前撤销来源后，才初始化真实 checkpoint 并进入既有准入/JIT。
4. 执行真实快照 producer，然后完成同候选 R2/R3、两条获准 Staging 迁移和 R4 真实验收。只保留现有阶段 1 门槛，不增加业务功能、商用 KMS、整套 I0 或不必要测试。
