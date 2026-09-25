# Stage 1 B5 Payment And Billing Validation Record

实际执行日期：2026-09-25；文件沿用原 B5 计划指定的 2026-09-06 名称。

Status: PASS（限定本地主动支付资金权威与合成账单维护正向/重放验证）。F3 限定修复完成；阶段 1、真实渠道与 Staging 验收仍开放。

依据：[本轮审计收口计划任务 2、7](../superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md)及[原 B5 精确生命周期](../superpowers/plans/2026-09-06-stage1-b5-payment-and-billing-validation-plan.md)。原 B5 tests-only 文档保留历史；生产修复由已批准的任务 2 与 F3 限域说明单独授权。

## Execution identity

- 最终两套 fresh 的共同源码 SHA：`46e8f95aa7ffbc045f7c6a672956f242325ff004`；分支 `feat/stage1-audit-closure-20260925`。启动时均为干净 checkout；源文件、manifest、discovery 在两次运行及 Task4 回读期间保持相同。之后才写本记录。
- source prerequisites：所需八个源码路径齐全；命名 ambient DB 变量、退役固定 target/secrets 路径、预存 run 目录均为 0。主控只检查变量名与路径；临时凭证由受控 launcher 管理，未读取既有凭证或访问远端环境。
- discovery 实际输出：`{"candidateCount":95,"manifestedCount":39,"exceptedCount":56,"unclassifiedCount":0}`，新 payment-authority 文件纳入既有 billing suite。
- manifest：`sha256:f4892d83e4943fe8acaf729bf4fd87cc41fb143f6b6abc55e8b8e80929f74116`；discovery：`sha256:4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a`。原始当前 discovery contract 与独立摘要见各 `*.inputs.json`，没有以两份报告互相相等代替当前输入校验。
- Task4 在 2026-09-25T05:40:59.3008519Z → 2026-09-25T05:41:01.8978470Z 重新读取两份 receipt 和内容寻址报告，核对原 stdout JSON、文件字节摘要及 canonical 摘要，再与当前 source/manifest/discovery/suite/chain 比较。`replacementReason=null`，复用本轮 Task3 pair，没有为写报告重新启动数据库。`b5-current-pair-reuse.json` SHA-256：`28bcb378933efa16dc9630e39f0b00988413c9f375273e212aee4edd6f11c195`。
- 报告所在工作树：`D:/Projects/auto-subscription-platform/.worktrees/stage1-audit-closure-20260925`；辅助原件目录：`.superpowers/sdd/2026-09-22-stage1-audit-driven-closure-plan/`。正式内容寻址报告和 receipt 位于该工作树 `.release-local/evidence/`。

## Command results

以下时间为 UTC；fresh 起止覆盖原 Invoke-B5FreshSuite 调用及 readback，exit 为被调用 suite 的实际退出码。每轮均 `chain=fresh`，所有 skip/todo/filter/cancel 为 0。

| 调用                 | Source SHA                                 | 开始 → 结束                                                 | 通过/执行；exit |
| -------------------- | ------------------------------------------ | ----------------------------------------------------------- | --------------- |
| f3-pg-red            | `6271941999b2f2dfb5ce22e9a499c86a99674815` | 2026-09-25T05:21:36.737963Z → 2026-09-25T05:22:51.3141749Z  | 12/16；1        |
| f3-pg-green          | `86b1de50314370146be2ae734d15414993df258e` | 2026-09-25T05:27:57.7266323Z → 2026-09-25T05:29:19.1328962Z | 16/16；0        |
| b5-final-billing     | `46e8f95aa7ffbc045f7c6a672956f242325ff004` | 2026-09-25T05:34:50.5288928Z → 2026-09-25T05:36:40.6327776Z | 17/17；0        |
| b5-final-maintenance | `46e8f95aa7ffbc045f7c6a672956f242325ff004` | 2026-09-25T05:37:52.1183971Z → 2026-09-25T05:39:27.6068811Z | 15/15；0        |

最终 billing suite 为 8 项支付 authority + 原 8 项 billing + 新 1 项正向重放，共 17 项。`api.database.release` 为既有维护事实 15 项。二者各自拥有独立 run、cluster/database 生命周期，不能解释为同一个数据库运行。

当前静态/单元原件及真实起止：

| 原件前缀           | 开始 → 结束（UTC）                                          | exit | 日志 SHA-256                                                              |
| ------------------ | ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| b5-task3-contracts | 2026-09-25T05:30:51.8825042Z → 2026-09-25T05:31:35.1695018Z | 0    | `sha256:ddc50bdf7bdbfead751598f0276c57af6f327ff3693ddd98049234e2b6d70dc6` |
| b5-task3-discovery | 2026-09-25T05:30:51.9135749Z → 2026-09-25T05:31:10.5495954Z | 0    | `sha256:3ff77b586bbd0046ffdca12e9bb1535446aa10679c84c343e4acda716e8ebe81` |
| b5-task3-format    | 2026-09-25T05:30:52.0020583Z → 2026-09-25T05:31:00.4929645Z | 0    | `sha256:f20510a9da4717c51c4cffee6d0dd88d6c9a723d0a83711d01216f5b48961283` |
| b5-final-unit      | 2026-09-25T05:40:02.3228936Z → 2026-09-25T05:40:25.6638165Z | 0    | `sha256:fb3e7d44ee524782f5be4543c4f66568b3632b521bfaf6744867a304b57bc4f0` |
| b5-final-typecheck | 2026-09-25T05:40:02.4999592Z → 2026-09-25T05:42:26.8945644Z | 0    | `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| b5-final-lint      | 2026-09-25T05:40:02.5003368Z → 2026-09-25T05:40:18.2350642Z | 0    | `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

- Task3 contracts/discovery/format 在 `86b1de50` 加新 billing 测试的工作区执行；该测试内容随后原样提交为 `46e8f95a`。最终 unit/typecheck/lint 在该干净提交执行；4 个 unit 文件全部通过，64/64，无跳过、过滤或未处理错误。命令、时间、source 与摘要见同前缀 `*.close.json` 和 `b5-capture-source-check.ps1` 脚本。
- contracts：126 migrations、174 contract files、68 schemas、13 commands；迁移目录 digest `sha256:95354883403ca767eb5f8df2a6339b21517cfd59844eb30673b165d5d28dd990`，repository contract digest `sha256:5dd5e255b6f6aeb149bb912ab4cf528021b096802d16d2a7b991ae1558edf50e`。
- 前置 shared build、Prisma generate、原三文件 unit 基线 36/36 均 exit 0，生成未改变源码；随后 Prisma validate exit 0。对应 `f3-b5-*.log`、`f3-prisma-validate.log` 为准备证据，未单独捕获其完整起止，不补造时间；最终门禁以上表为准。
- Node v24.14.0、pnpm 11.4.0、Prisma 7.8.0；新 PG、billing 测试及 manifest 格式检查通过。既有 portal-payment 单元文件的 Prettier 基线不通过，本轮按 F3 限域说明保留既有格式并通过 ESLint/diff 检查，没有整文件格式改写。

## Fresh lifecycle disposition

原 B5 preflight/function/reuse 三个 PowerShell fence 按原样去掉 Markdown 缩进执行，保留摘要：`9d166aada3aedfcfd7294d6fe6642d0aa7c1d1a869ad25b77131af48ce8fe4ce`、`89abdbb35911e2bcdaccd537d4a4c0decf352a65919a6cd21fbef8cd86b06b8c`、`313c647a30dfd3b6fdacdca85d205fccd11d201b8d762abea6b8097e242003f6`。辅助脚本只捕获输出、时间和 exit，不新增数据库 runner、target、secret 或 cleanup。

四轮均产出完整计数报告，原 launcher 在 custody/readback 后完成数据库、cluster、secrets 和 run 目录退役；精确 run 目录均不存在。RED 分类为 BLOCKED_COUNTEREXAMPLE、exit 1；其余 PASS、exit 0。没有无完整报告的 incident，没有手工补清理或复用退役目标。

每份报告的 superuser/createdb/createrole/bypassrls/canCreateSchema/schemaOwner/objectOwner 均为 false。受控 launcher 到达 suite 前已在新目标执行 migrate deploy/status/schema diff；本轮未更改 schema 或迁移，未连接 ambient 数据库。suite 报告未单独输出实际 PostgreSQL 镜像版本、迁移 stdout 或 schema digest，本记录不补造这些字段。

### f3-pg-red

- runId：`8403ebda-38ab-435c-b066-ddef7a21dd55`；operationId：`b0bca425-f89c-46e9-b701-79cfa19cb6af`。
- database：`s1ci_6b6adfc9ea40c434f36793cf`；OID：`16386`；target fingerprint：`sha256:a757121ce744a177e94c071c681fff21432b387eb8c9c73afa8fdef48ac00b28`。
- report：`.release-local/evidence/evidence/f92611266368eecd1653e79f1530a9b7bf91c61ee2070260146dba99c4d07dca.json`，962 bytes；content/readback/independent/canonical 均为 `sha256:f92611266368eecd1653e79f1530a9b7bf91c61ee2070260146dba99c4d07dca`。
- receipt：`.release-local/evidence/receipts/1e13bec1-51da-4e7f-9307-bdd8f937c162.json`；文件 SHA-256：`f52ba52f07ee405769d4862eba7306e7f006f1a97983bb87ec274157a930c7d1`。
- sanitizedLogDigest：`sha256:b5f6ce79f7aac745844c06d1615fd3a1a6e98595ae6a16cda9b9dd78767f7728`；本轮调用原件为辅助目录的 `f3-pg-red.{result.json,stdout.json,close.json,wrapper.log,inputs.json}`。

### f3-pg-green

- runId：`0924da92-ebf3-4b42-8874-a73acdf81325`；operationId：`2625ee75-c3ec-4721-89e9-3dc1f5dbb423`。
- database：`s1ci_17e78aee4442b2d6b9a5e0f0`；OID：`16386`；target fingerprint：`sha256:5c4537b644239e2359fbf6a5e7632afc75df445ca4df0e752e4dd32882f52de4`。
- report：`.release-local/evidence/evidence/38f9618637066324d0054ce8fa6122f90c5dd4248345db9a57a8d41f68b5476c.json`，962 bytes；content/readback/independent/canonical 均为 `sha256:38f9618637066324d0054ce8fa6122f90c5dd4248345db9a57a8d41f68b5476c`。
- receipt：`.release-local/evidence/receipts/14aad594-1b74-4037-976f-e2b686fefe9f.json`；文件 SHA-256：`9a56f12a953ebdb46bfd7549681f61c04e873be981a353cbc2730da06bb9ead2`。
- sanitizedLogDigest：`sha256:bb5f017ff338be0085fd88977e4238e5d5591edd93ec3b855ee71315ccca9e75`；本轮调用原件为辅助目录的 `f3-pg-green.{result.json,stdout.json,close.json,wrapper.log,inputs.json}`。

### b5-final-billing

- runId：`1e83e699-b3d6-4931-8871-4dae6c0d01cf`；operationId：`9c512e44-1ac2-46e7-8d66-81808707948e`。
- database：`s1ci_a86421839e6d952863c4d11a`；OID：`16386`；target fingerprint：`sha256:97b0b43b80fac850e07dde5b60ef67f28ce779f31bb2311997d81fe99716861c`。
- report：`.release-local/evidence/evidence/599724133c2ba69c1ca653833f930a9b58d2483541f792f5c55d443d5a0c19d3.json`，962 bytes；content/readback/independent/canonical 均为 `sha256:599724133c2ba69c1ca653833f930a9b58d2483541f792f5c55d443d5a0c19d3`。
- receipt：`.release-local/evidence/receipts/fe631fa2-3ff5-491b-adbd-ff327db5cdd3.json`；文件 SHA-256：`d62a55f8578ddcaddea9d42c4f0af1c6f70947a900e7a1af449ef962ded3fcff`。
- sanitizedLogDigest：`sha256:d3a65d99b431dabc03ca61f036f4fb52e0e9edb944ccd53d9ccb4b247d121441`；本轮调用原件为辅助目录的 `b5-final-billing.{result.json,stdout.json,close.json,wrapper.log,inputs.json}`。

### b5-final-maintenance

- runId：`0b4fec1f-3a39-43c0-b370-97848effbc63`；operationId：`d6a3c932-5c6a-4c75-b41b-a15f401b7354`。
- database：`s1ci_1055e94197253a2908727f43`；OID：`16386`；target fingerprint：`sha256:60a3ab89f42faf8bf1f4e42a181ef74320e983a5fe81395f2808c06987f31413`。
- report：`.release-local/evidence/evidence/7aa1b36c0fd443b3cf62422c86cfce567fffcfcf1888d93975f2e8e707b75818.json`，951 bytes；content/readback/independent/canonical 均为 `sha256:7aa1b36c0fd443b3cf62422c86cfce567fffcfcf1888d93975f2e8e707b75818`。
- receipt：`.release-local/evidence/receipts/f54c7b1e-f34f-4ff8-93ab-fc3ae871f5f7.json`；文件 SHA-256：`238e545213812ef322f62f074a176c0afcb2e9f25b838b22fc43d9fec4eda87b`。
- sanitizedLogDigest：`sha256:9447897a20c3f75ed618221a1d9568c0c093dad92b831af562c9118ded29bb3e`；本轮调用原件为辅助目录的 `b5-final-maintenance.{result.json,stdout.json,close.json,wrapper.log,inputs.json}`。

## Authority observations

- 真实 PaymentOrderService → FinanceService → Prisma/Audit 事务验证；仅 provider 为合成边界。1000 分合法支付最终绑定唯一 CONFIRMED PaymentRecord（1000 分）、唯一 write-off（1000 分）和 PAID bill（paid=1000、remaining=0），并有三条对应支付审计。
- 金额 400 分回调被拒绝，callbackLog 保留 verified=true、handled=false、支付单关联与错误原因；不产生收款/核销或账单变化，PaymentOrder 状态、errorSnapshot、updatedAt 均不因错误回调更新。
- 错误先到、合法先到、错误持有旧 PENDING 读取时合法结算先提交，三种次序均保持合法到账权威。并发合法重复产生两条已验证已处理 callback，仅一笔收款/核销。合法 CLOSED 补回调仍可结算；未验证或非成功事件不进入资金变更。
- 新 PG 未注入 JourneySignal，只证明资金权威。原 focused unit 覆盖结算信号，以及剩余金额不为零保持 WAITING_CUSTOMER、清零后才完成，不把 PG 资金通过扩称为 Journey 全路径验证。
- 正向维护用例通过真实到期 schedule、两次 enqueueDueSchedules 扫描观察 dueBefore+1 正数；enqueuedCount 为每次符合条件的尝试数，稳定 sourceKey 的数据库 job 唯一性才是幂等权威。既有暂停、唯一性、固定月租与禁止代扣断言保留。
- 独立维护事实 suite 验证 sequence 1 再 2、并发 run lock、第三次无新事实、精确来源绑定、回滚及 append-only 约束。其业务 reconcile/enqueue 使用 billingDouble，release/image 为合成常量；真实数据库验证的是维护事实层，不能解释为真实维护业务运行、当前镜像事实或两个实际自然月。

## Counterexamples and disposition

1. unit checkpoint `7e9554d5` 实际 36/38：错误先到把支付单置为 FAILED，正确先到后错误金额被当作幂等成功。日志 `f3-unit-red.log` 保留。
2. PG checkpoint `62719419` 实际 12/16：partial 不改状态断言失败；错误先到阻挡后续正确结算；正确先到导致错误金额 promise 成功；旧 PENDING 读取继续后破坏 PAID 终态。对应脱敏失败提示及位置保留在 `f3-pg-red.wrapper.log`，没有伪造退役数据库的完整行快照。
3. 生产独立提交 `86b1de50` 将金额检查移至 PAID 幂等短路之前，删除错误分支的整笔 PaymentOrder update。仅利用原 handleCallback catch 留诊断，Finance 的状态规则/权威锁不变；随后 16/16 PG，再于最终源通过 17/17。
4. 中间实现曾误把五行检查插入 refreshProviderPayment，unit 为 49/64 且 1 个 unhandled error，tsc 三处错误；`f3-unit-green.log`/`f3-final-typecheck.log` 名称虽含 green/final，内容实际失败，均保留。该错误实现未被用于 PG 运行，修正后才运行生产修复的 PG GREEN；不作为业务 RED 或最终通过。另有新测试准备期语法/缺 payload 的静态失败，亦不是业务反例。

## Limitations

- 本地 Node24 合成 fresh 不是最终 Node22 镜像、合法 snapshot、Staging、微信验签/连通性、浏览器或人工签字。
- 未恢复服务器 Docker，未触达供应商、签约、真实付款、部署或 push；需要线上联调时遵从用户要求先恢复本系统对应的 Docker 服务。
- 不证明 B6 正常结束、豁免/减记、司法、放车或订单完成；不启用或验证自动扣款。
- 不修复历史上已被旧逻辑写成 FAILED 的数据，也不扩宽 Finance 对 FAILED 的拒绝规则。
- F3/B5 限域代码、数据库证据及最终文字记录均已独立复核 ACCEPT。其余阶段 1 任务保持开放。
