# Stage 1 财务审批重试与签署审计顺序修复验证

执行日期：2026-09-26。本轮财务审批重试及签署审计顺序修复已完成本地验证：同一干净源的 API9 607/607、Web2 115/115、完整 PostgreSQL expiry112/112 与 asset33/33，共145/145；类型、lint、差异与原件读回均通过。阶段1真实发布、浏览器、渠道与签字仍开放。

## 行为与范围

按[财务重试计划](../superpowers/plans/2026-09-26-stage1-financial-approval-retry-plan.md)及[签署审计顺序追加计划](../superpowers/plans/2026-09-26-stage1-return-manifest-audit-order-plan.md)实施。财务五个生产/四个测试文件，另加既有 closure service 与 esign unit，共十一文件；无 Schema、migration、HTTP DTO、上传 API、权限、依赖、manifest 或 launcher 变更。

- 后端 WAIVER / WRITE_OFF 经专用事务入口，在当前 closure/bill 权威、Accounting 锁和当前 ACTIVE/未删除操作人核验后，完整核对 receipt/outcome/approval/原 request receipt 与合法历史状态，复用服务器首次持久化时间，再执行原完整 payload 重放比较。损坏候选不回退成新写；当前权限、用户、正文、版本、证据或权威变化仍拒绝，审计仅首次写入。pricing / registration 保持原路径，不开放 caller 时间或 verified 标志。
- 前端上传前冻结 key/body/文件/当前用户与案、结算、账单绑定，同步 busy。已知 proof 后审批结果未知时重试原命令；已知 ACK 后严格读回失败只重读。上传未知且无 fileId 时不自动重传，需读回和新的用户意图。复用页面严格读回，隔离过期响应，保留合法 FINALIZED / SETTLED 路径；不承诺跨整页重载持久化 pending。
- 签署 task 原按 createdAt、随机 UUID 排名解释四业务阶段，合法同毫秒记录可能错排。追加修复按完整 before/after snapshot 解析唯一四步因果链，拒绝重复 ID、分叉、断链、自环、闭环及额外/缺失记录；保留原 actor/entity/module/action/source、文件、签署人、callback、receipt、revision、hash 和最终 task 完整投影检查。阶段时间仍逐一精确匹配 task 字段，非递减且允许合法相等。

## 反例和中间失败保留

| 记录 | 实际结果及界限 |
| --- | --- |
| 原生产 PG RED，source `28c9d10b`，expiry-red-1 | 102 执行、98 pass/4 fail，exit1；WAIVER/WRITE_OFF 请求与决定跨首写毫秒重试均 ConflictException。完整 payload 的服务器新时间导致冲突；同毫秒不必然冲突。原始 summary code 列表为空，SOURCE_CONFLICT 来自唯一消息的源码映射，不冒称 runtime code 原值。 |
| 后端 unit red-3 | 465 执行、183 pass/282 fail，为缺新入口与接线 RED，不作为原实现放过污染的证据。首次实现24个正例因 primitive 传入 object-root canonical 比较失败，修复为 `{value}` 包装；类型检查曾失败，显式 Date/有限时间窄化后通过。 |
| 前端 SETTLED 回归 | 两项 SETTLED 失败、相邻两项 FINALIZED 通过；原合法阶段误被排除后已修。最后聚焦35 pass/73 filtered，与最终完整 Web2 重叠，不累加。 |
| 首次候选 PG，source `d123cb4b`，expiry-fresh-1 | 112 执行、110 pass/2 fail，exit1。两类型 request 全事务 rollback 断言通过后，随后首次成功提交合法增加一条审计，错误 oracle 却要求 joint 全件不变。decision rollback 后续段当轮尚未执行。test-only +32/-1 改为精确增加该条审计，所有旧审计及其余联合事实不变；未删除审计检查。 |
| 第二次候选 PG，source `d333a5cd`，expiry-fresh-2 | 112 执行、111 pass/1 fail，exit1。两类型 request/decision rollback、四项跨时刻重试均通过；唯一 pending WAIVER 在 callback 自动 finalize 的签署 fixture 构建中 authority conflict，尚未进入财务操作。仅保留 validator false 的堆栈，无具体子谓词或行值，历史根因仍未确定。 |
| 签署 T1 red-3 | 6 执行、5 pass/1 fail。真实公开 validator：严格时间逆 UUID true、同毫秒顺 UUID true、同毫秒逆 UUID false。只运行完整 controlled facts 与真实 where/排序替身，事实按 producer 字段映射，未运行 producer。证明确定排序缺陷，不能还原上述 PG 历史行。 |
| 签署 T2 矩阵 RED | 52 执行、25 pass/27 fail：24个排列中的23个加独立逆序正例，共24个合法事实错误拒绝；闭环/自环2个错误放过，重复 ID 1个错误放过。均为 boolean 期望差异，非 fixture 构造错误。最终当前 task 投影仍相同的循环反例证明仅 final binding 不足；不冒称真实 PG 数据已损坏。最后测试又隔离仅末步 C→C 自环及严格时间断链，最终三文件60/60，lint/test格式/diff通过。 |

原失败轮 report、receipt、launcher console、stdout/result/inputs/close 及独立读回/精确退役均保留，不覆盖或改判。内部 Vitest stdout/stderr 的完整字节未由 launcher 保管，仅保留摘要、大小、诊断和结构报告；不补造成功打印或历史 diff 值。

签署修复首次合并 source `1bcb64db` 的 `retry-final-3` API9 607/607、Web2 115/115 已通过，但 API types 报新 fixture revision 缺少三个 nullable attestation 字段，exit1；其后门禁未执行，不能称该轮全通过。test-only 按真实 producer 的 null 字段与实际 receipt outcome 投影补齐，不用双 cast 隐藏错误。旧失败日志/metadata 保留，最终结果另绑定后继干净源。


保留的三轮失败报告索引（全部已独立读回并精确退役）：

| prefix | report SHA256 | receipt ID / 文件 SHA256 |
| --- | --- | --- |
| financial-approval-retry-expiry-red-1 | `sha256:31f20ad0d1782d6bed6874762948937daf07accc1ccbbd0db7098efce1f9cf67` | `59d8536d-5373-4041-8656-38adff8e0925` / `f51dc335f65a43189ab4735d218cb40ce1dac503ab33344bdd19afa3b35ab6fe` |
| financial-approval-retry-expiry-fresh-1 | `sha256:0ce42034222303de898d4eb148e5bb7a324ddf126dc7c84e71c941945ebc7784` | `ca27c3f5-b349-410f-b9b9-e58987181cf9` / `2bfb7a3f265266432b72f525ca7a9c43096ba785ff72d7f0e1fa065ebbd77b45` |
| financial-approval-retry-expiry-fresh-2 | `sha256:60a0c043e245925122a7c0e121d918f96266716a1fc0e0af558c8fe06b5d4cc3` | `e04b1f52-ea95-4674-a66b-6ff859f1fa40` / `acc76905bcb75f58a7dbace248c46b5d355cbdb70ee59816741353bdfb3ee26d` |

## 最终离线与真实 PG

实际干净执行源 `f82d30e149ded76d958831dfb46f6332fad1e2dc`；本地 runtime `v24.14.0` / pnpm `11.4.0`。

| 离线门禁 | 实际结果 / UTC | 日志 SHA256 |
| --- | --- | --- |
| api9 | 607/607, exit0；`2026-09-26T14:19:27.6305599Z`–`2026-09-26T14:19:39.0218752Z` | `992137f2a172da8979617f9f5ad8a44c754cb55bcfcf98f731b637bd6998cb87` |
| web2 | 115/115, exit0；`2026-09-26T14:19:39.0339481Z`–`2026-09-26T14:19:45.0985113Z` | `5057c75601a9cf1307877c28ac21421455b6312d3193d6a4df837a4fa68f302d` |
| api-types | exit0；`2026-09-26T14:19:45.1019664Z`–`2026-09-26T14:21:12.2740557Z` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| web-types | exit0；`2026-09-26T14:21:12.2807811Z`–`2026-09-26T14:21:34.8471412Z` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| api-owned-lint | exit0；`2026-09-26T14:21:34.8508335Z`–`2026-09-26T14:21:42.6457259Z` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| web-owned-lint | exit0；`2026-09-26T14:21:42.6577753Z`–`2026-09-26T14:21:48.4292790Z` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| diff-check | exit0；`2026-09-26T14:21:48.4433930Z`–`2026-09-26T14:21:48.7158216Z` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

以上无测试过滤；API/Web类型、全部变更文件lint和diff均通过。十一文件起终摘要匹配，`retry-final-4.inputs.json` 与 `.verified-summary.json` 保管精确命令及独立复算；聚焦测试与该集合重叠，不累加。生产大文件已有整文件格式例外保留，未全文件重排。

| 完整数据库 suite | counts / UTC | run / operation |
| --- | --- | --- |
| `api.subscription-expiry-return.postgres` | 112/112，exit0；`2026-09-26T14:22:16.8573725Z`–`2026-09-26T14:31:24.2668109Z` | `559f93de-04ad-42f6-ba16-8cc90cf3e72d` / `e53f9b96-66a0-4714-bd0f-1ec7b7555987` |
| `api.asset-operations.postgres` | 33/33，exit0；`2026-09-26T14:32:11.5774603Z`–`2026-09-26T14:33:28.2426482Z` | `51d5984d-c93c-450b-a8c9-e7470ad0094d` / `0c3e6c66-9260-448b-85f7-de48cac4fb59` |

| suite | report SHA256 / bytes | receipt ID / 文件 SHA256 |
| --- | --- | --- |
| `api.subscription-expiry-return.postgres` | `sha256:93c1685f839c23757090d838eada70b7c913fd5b601d795c278408765ee44cdd` / 974 | `41fad286-78aa-4cf9-815d-62f394ccee0e` / `8fc8aa633e646d85fe458ac6ae44c372a59b3df35257340e04a03a2e4634ed82` |
| `api.asset-operations.postgres` | `sha256:b792313db987c21d0b6a11acdb1bc993a11a31418b9e3c5c0777ebff14c2c4cb` / 960 | `6b9e666e-8811-4437-9cd7-299bc2699592` / `61c0c093fa47f8e5d1e3143817d7838230629285c8ee600898980778299968ef` |

`financial-approval-retry-expiry-fresh-3` 目标 `s1ci_0c5305206a4327587ed078cc` / OID `16386`，fingerprint `sha256:ffbb445e44a6ed3b63da119b27ccecdcb78ce73e76619584b6c1798564ee8218`，sanitized log `sha256:35f217069523dfe71ef55cd905c198078a574b6775de8c8be63f32b37ca39762`。

`financial-approval-retry-asset-fresh-1` 目标 `s1ci_c346d82c7a601df35fd57df3` / OID `16386`，fingerprint `sha256:caaafd99d3db93e1952369f7594eea5f355019e04e174a2f0ec839942666090e`，sanitized log `sha256:a6134202e96bfac2e58056ba87cb8708f55d2acbe3492ba237d582551954051d`。

两套使用原未改 B5 capture/launcher 串行 fresh，新 run/target 独立，128 条现有迁移 deploy/status/diff；无新迁移。collected=selected=executed=passed，其他计数全部0。主控用原 Read-B5FreshResult 重新打开持久 report/receipt，核 raw/canonical/stored/receipt 摘要、七项权限/ownership均false及精确run/容器不存在；详见 `pg-final-3.verified.json`。该本地保管不提升为真实私有保管证明。

| 最终文件 | SHA256 |
| --- | --- |
| `apps/api/src/subscription-closure/subscription-return-governance.service.ts` | `333f6a4c698a4e81fec10b1bb8bc2fb4595fad5e10aa433785c40c1f79ee7acd` |
| `apps/api/src/asset-accounting/asset-accounting.service.ts` | `8f11e90b6bcd92931a1339a2bfcf5411f30ce8d0bc2861483976a6c8171b213b` |
| `apps/api/src/asset-accounting/asset-accounting.repository.ts` | `c16bee9c1a7e608405637ccd6d5558c25a64a12f41c25cba6325fa9c87d5cea9` |
| `apps/api/test/subscription-closure-financial.spec.ts` | `dedc1031b2f53469b634a7972e63aa75ef094e07cfeda13670ea6384977c5237` |
| `apps/api/test/asset-accounting.repository.spec.ts` | `8aae92043a84635983621fa8bbb6ef08fe10e005d13eb2394ced6a4a4650a83d` |
| `apps/api/test/subscription-expiry-return.integration.spec.ts` | `ce61598fcb7a518039f6abd346cfd1718788b30182041dd428d445e519b3d28d` |
| `apps/api/src/subscription-closure/subscription-closure.service.ts` | `aa2235e53dbe67e949df12e767f75e191b4807f6fa0567d50adce9a0663180c6` |
| `apps/api/test/return-manifest-esign.service.spec.ts` | `7af3dbe152cf57d71234194e1cd481cc6137de4dd2ce491e3137b45eb1cf65f3` |
| `apps/web/src/components/subscription-closure/return-settlement-stage.tsx` | `1c17a2e064965044de7258c8f192e089f7a05ee710d7e4411e8607b590ddf7c6` |
| `apps/web/src/app/orders/[id]/page.tsx` | `6636ac817735ef45fe1aa2bda6930c079304814d4971f5f0adc7e9595407a6c4` |
| `apps/web/test/subscription-return-browser-actions.spec.tsx` | `af13f4477e353d2c89e6e7b8748ce22898b03166b9ebed019ce674aa0c379a41` |


契约核验保持176文件、68Schema、13个command contract、128迁移；repository digest `9630a34b556da831b260396b8aa28e2176cb1e113a174962ff09a94382d4dbb3`，migration digest `65ebe3208fc618ae82ad24f66b793e9bddd7464526dd45b8a0d9893d24a0ff62`。manifest `f4892d83e4943fe8acaf729bf4fd87cc41fb143f6b6abc55e8b8e80929f74116`，discovery `4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a`，95候选/39登记/56例外/0未分类。

## 覆盖及局限

PG 使用真实 governance、Accounting service/repository、Audit、Prisma/PostgreSQL，覆盖实际锁等待下同体并发单写/异体冲突、历史请求/决定 ACK、第三有效操作人、权限/自批/正文/版本/禁用删除用户等拒绝、Finance 实际改余额、Accounting 实际过期及重新结算漂移、Audit 写后受控异常的全事务 rollback 与后续成功首次提交。没有直接插入 APPROVED/EXPIRED 或重写 append-only 行；same-authority EXPIRED 历史 ACK 结构正例仅 repository controlled rows。

UI 是实际 controller/页面 helper、真实 API wrapper 配低层 transport mock 和 SSR 验证，不是 DOM、真实 StrictMode 或浏览器。PG 的 storage/provider IO 和 RequestUser 权限上下文为受控 fixture，不是 HTTP 登录、外部签署、支付或真实资金。未知上传可能已留孤立 proof；本轮不清理历史线上数据。

本地 Node24.14.0 / pnpm11.4.0 / Prisma7.8.0 仅为开发证据，不是最终 Node22 API/Web/Runner 镜像或独立真实 H2 私有保管。仅证明确切 run/容器及目标路径已退役，不声称全部卷擦除或密码学销毁。

## 后续依赖与阶段 1 状态

本地修复、完整相关测试与数据库验证已完成；整体 Stage 1 尚未收口。后续按依赖推进：

1. 补齐 H1 实际 release owner/host 与受控路径、H2 私有存储 writer/独立 reader、expected-schema 两次独立来源输入；已有异步询问未获回复，不伪造身份或目标。
2. 在这些输入上完成 R2 collector/source/parent 链及两种实际场景；现有 H3 reader109项只限定到 RESOURCE_INPUT_REQUIRED，不等于 R2 整体完成。
3. 固定同一候选的 Node22 API/Web/Runner 最终镜像，完成 fresh/snapshot 全39登记目录中实际适用37 suites 的两条全链及受控宿主、合法副本/保护前置；此前六批只覆盖30，不能称全量。
4. 恢复本系统指定服务器 Docker 并检查健康后，再做真实 Admin/Portal A/B 新单、成熟正常结束、电子签/主动支付及5类通知、两次非空维护、恢复演练和人工签字。真实资金与通知遵守已定具体操作单边界。

Registration 的行数防御缺口继续低优先级排队：现有有界 producer 审计未发现相同 case/item/evidence 重复链，且签署后置有 Set.every，不能写成已证明可利用漏洞。本轮无线上 Docker 恢复、部署、push/PR/CI、provider 或真实资金动作。

原件根：`D:/Projects/auto-subscription-platform/.worktrees/stage1-financial-retry-20260926/node_modules/.cache/sdd/financial-retry-20260926/`；实施 unit RED/GREEN 位于相邻 `stage1-financial-retry-code-20260926` 的同名 cache。持久 report/receipt 位于 PG worktree `.release-local/evidence/`。代码各切片、最终离线、两套PG原件及本文均已获独立终审限定 ACCEPT。审查者重开持久 report/receipt 并复算摘要、size、counts/source、七项权限与主控精确退役记录，同时核验十一文件摘要；未重跑测试，也未将本地结果扩大为真实浏览器、线上、最终 Node22 或阶段1签字。整合状态在主线执行索引前向登记。
