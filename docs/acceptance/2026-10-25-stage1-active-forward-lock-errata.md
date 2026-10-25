# Stage 1 活跃转发锁与历史事故校验勘误

候选 `453da778dcfefd3727813179382490903644ef26` 的 sourceFresh RC `40193967194`（job `121171660175`）在 H1_CREATE / SIGN 失败，原生 causeCode 为 `MANUAL_R3_INCIDENT_UNVERIFIED`。`SIGN_HISTORY` 于 2026-10-25 12:51:24.530 UTC 开始，8,811 毫秒后失败。当前请求及 attempt allocation 已写入；`authorization_persisted` 和 `socket_connected` 均未完成。因此本次没有签发可用的当前授权，没有进入当前目标创建的 socket/数据库执行，也没有 sourceFresh CLOSED。不能把正常关闭的当前 session 误作成功。

## 首因与证据边界

这是确定的代码条件冲突，不是已证实的环境抖动。固定源码在每个活跃 R3 session 开始时，于 `journal/locks` 创建两个转发槽锁：`a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json`（55440）和 `13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json`（55441）。这两个名字也正是历史 `728eafd7-f137-4d7f-a0ad-73b2a687e59b` created-target 事故策略中的已退役转发锁名。

`verifyR3History` 在签名前收集 `journal/locks` 的当前全量 retained locks，再逐组验证九个已消费的历史 session。`728e` 的 created-target assessor 要求上述两个**文件名在全量 retained locks 中完全不存在**，没有区分已退役的历史锁与本次活跃 session 合法持有的同名转发锁。因此签名前旧有 39 把 target/reservation 锁加当前两把转发锁的情境必然触发该条件，内部失败被统一折叠为 `MANUAL_R3_INCIDENT_UNVERIFIED`。固定源码位置为 `packages/release-foundation/src/manual-stage1-session.mjs` 的会话锁创建、历史锁收集与旧组遍历，以及 `packages/release-foundation/src/manual-r3-incident.mjs` 的 728e retained-lock 判定。

后续一次 protected 只读探针在失败清理**之后**运行。它核对了 139 个 archive/journal 对象、九个历史消费组和事故原件；九组原生事故读取器均 PASS，forward assessor 与历史 source/catalog binding 也均 PASS。探针当时只见 39 把旧 target/reservation 锁，当前转发锁为空；它证明清理后原件可读，并未复现签名前持有当前两把锁的上下文。早先脱离活跃 session 的图评估与 preflight 同样遗漏了这一条件。探针原始 `probe.stdout.json` SHA-256 为 `5e6fb3db70cc7d1899018c6c25e7661a7b3fae033e0b9a1409573123ff3702fa`；失败诊断与 `startup-detail-048/049.json` 保存在本任务的 `candidate-453da778-rc-PREPARED_STOP/failure-40193967194-readonly-ACTUAL`，探针保存在其 `incident-40193967194-protected-readonly-PREPARED_STOP` 子目录。

## 下一轮准入

修复保留历史 `728e` assessor 的严格判定，只在活跃会话的历史调用处逐字核对本会话持有的两把锁，再从历史视图排除它们；完整 capture 仍保留并重检这两把锁。继续拒绝旧锁回现、额外候选消费及不匹配的 39 把 target/reservation 锁。下一轮必须在**当前两把转发锁真实存在的签名前情境**覆盖历史调用边界，并用全量历史图检查原生事故校验；清理后零转发锁的子图测试不能替代此门槛。还应保留旧事故原件、当前失败 RC 的 once 记录与独立清理回读。

既有 `manual-stage1-session.test.mjs` 历史重用用例在未启用 Node experimental module mocks 时会静默 skip，原 mock 夹具还缺少 `isCreatedR3IncidentDisposition` 导出；下一轮回归须启用 module mocks、修正夹具并确认这些用例实际执行，不能把跳过计为通过。

修复段的本地回归已先失败后通过：五个会话用例实际执行，覆盖持锁历史视图，以及捕获期间锁被替换或缺失时停止。随后一次只读全图预检读取 archive 74 项、journal 65 项，按摘要去重为 137 项；九组原生事故 reader、来源绑定及事故评估均通过，39 把历史目标锁保留。独立回读确认结果相同、卷及 mapper 已关闭、互斥已释放。全图预检原件 SHA-256 为 `3b309fcbcd775a3660f3d22bded9fc42f5d0612e5535c49f159fd7e1dbbd9a5e`。它补齐子图遗漏，但仍是事后只读验证，不能记作新候选 R3 成功。

已完成的源码、构建、public/保管和 snapshot 前段原件按其原有绑定冻结；可复用的基础配置继续复用，旧候选签名不能转给修改后的源码。本次失败不转化为 sourceFresh、snapshot 或四段 R3 CLOSED。后续 snapshot-data 仍等待真实 sourceFresh CLOSED 及相应 source-gate custody，不应据本勘误启动。新 RC 仍需独立满足候选、窗口、签名和真实执行准入。本勘误记录首因和回归门槛，不声称远端执行或 Stage 1 收口已完成。
