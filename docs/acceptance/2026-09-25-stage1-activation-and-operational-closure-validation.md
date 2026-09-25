# Stage 1 B4/B6：激活恢复与受管正常结束验证

执行日期：2026-09-25。对应审计收口计划任务 8。最终五套 fresh 均绑定 source `0e9d966d68892e17f7d7a5096bf1a298406ed247`，合计195/195通过。该结论仅覆盖本任务本地业务与数据库兼容验收；阶段1最终候选、真实渠道和签字尚未完成。

## 生产变更及范围

- 激活已经提交而 job ACK 失败/租约已过期时，原 claimJobs 无条件排除 COMPLETED Journey，导致恢复停滞。B4 原独立提交 c2512636（集成 fdbb69a7）仅允许同 Journey/order、当前 AUTHORITATIVE_ACTIVATION 已完成且有时间、同已完成 step、当前数字 finalPlanRevision 匹配的 ACTIVATE_SUBSCRIPTION job 再领取；原 due/status/lease/锁/重试策略保持。激活服务完整重放不重复业务写入，worker 可完成 ACK。
- completeOperations 原事务未记录成功审计。43f114b6 在既有 Closure/Order/Contract 状态写入后同事务添加审计，包含操作者、三对象前后状态和幂等键。重复早返回不补写，业务写或审计失败全部回滚。
- CUSTOMER_SIGNED 清单原用 Prisma.JsonNull，违反已存在的 SQL NULL 检查；aedc4bf7 仅该分支改 DbNull。d6f90370 将清单重放双方归一为相同五个业务字段、包装对象根比较，保留完整 manifestHash 绑定及变更拒绝。
- createPricing 原同版本重放及后继账单复用把 evidenceIds 数组传给对象根序列化器而抛 TypeError；b4e80b6c 仅两处改为 `{ evidenceIds }` 比较，排序和原冲突规则保持。真实新账单改变应收事实后，测试必须重新 propose 再复用旧账单生成后继 chargeLine，不能回填 proposal 摘要。
- 两个新增前向迁移 `20260925090000_stage1_operational_completion_terminal_shape` 和 `20260925091000_stage1_operational_completion_settlement_guard` 兼容已有运营完成入口。终态仍要求 closedAt/finalDisposition 和实物控制等约束，结清时间或运营完成时间至少其一；延迟约束仍要求本案最新 FINAL 结算，仅允许 SETTLED，或本案当前 operationalCompletedAt 已记录时的 FINALIZED。读取提交时当前行，避免使用延迟队列中过时 NEW。旧迁移、余额和结清事实不改写。

## 覆盖事实与边界

B4 A/B 使用真实交付证据附件、到账核销、交付/登记门槛、LeaseActivationEngine、journey/worker 与数据库。联合核 18 类权威事实和唯一事件/审计；缺前置事实、BASE/Period 写后失败全回滚；真实 ACK 写后事务异常及真实已过期租约恢复均保持激活事实唯一。19 类不合资格领取负例先在回滚事务中验证。已归档合同/文件字节/供应商/激活前人工事实为明确合成边界。过期用例只证明业务已提交且实际租约已过期，不声称过期发生在提交之后。

B6 保留原 80 项复杂域测试，新增当前 completeOperations 正常清偿、完整重放、合法催收归口但保留欠款、缺两类终态时间拒绝、客户未确认/无财务归口拒绝、责任未定的真实 inspection 守卫、开放争议及平台接受后尚无新结算的拒绝、合同写入/审计写入后异常的真实事务回滚与重试。联合核 Order/Contract/Closure/Lease/Period/Vehicle/Bill/PaymentRecord/WriteOff/Audit。四类证据在签署前实际上传，receipt 绑定 checklist revision/hash/损伤项目及证据；真实 receipt 结束 Lease/Period，库存解除占用和可上架分别断言。定价首写/原版本重放/后继旧 bill 复用有真实链路。责任未定不能通过当前合法链生成 FINALIZED，PG 证明前置拒绝，complete 内隔离分支由 unit 证明。

归档交付、成熟租期/BASE、初始应收和条款为输入 fixture；签署 provider、对象存储、图像字节是受控合成。没有真实渠道、服务器部署、线上数据库或浏览器验收。通用完成入口已有催收/法催归口能力保留，欠款样本不得改称资金结清。

## 验证结果

集成 fdbb69a7 上 12 文件 178/178 unit、owned10文件 ESLint、API tsc、Prisma validate、contracts 与 discovery 均 exit0。后续 0e9d966d 只改 checklist 单测 mock 的格式；8个 owned 测试文件格式全过。生产大文件原有格式差异保留，无无关全文件整理。当前 catalog 128 migrations，migration digest `65ebe3208fc618ae82ad24f66b793e9bddd7464526dd45b8a0d9893d24a0ff62`。

五套使用原 `run-database-suite.mjs --suite-id <下表suiteId> --chain fresh`，由已审核的B5捕获/preflight函数传入精确suite执行；未改launcher/生命周期/连接规则。每轮独立新目标、migrate deploy/status/diff、runtime权限读回、完整报告、custody/readback以及launcher退役均完成。以下每套 collected=selected=executed=passed，failed/skipped/filtered/cancelled/todo均0，exit0。

## 原失败与修复检查点（不得改判历史）

| checkpoint                 | source     | passed / executed | 事实                                                                                                 |
| -------------------------- | ---------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `b6-first-fresh`           | `7e406745` | 78 / 85           | 无效keyState及新fixture污染旧全局计数；不是业务RED                                                   |
| `b6-second-fresh`          | `613d3350` | 80 / 85           | CUSTOMER_SIGNED JsonNull违反SQL NULL约束；真实生产RED                                                |
| `b6-third-fresh`           | `aedc4bf7` | 80 / 85           | Lease期望TERMINATED而实际合法COMPLETED；fixture oracle错误                                           |
| `b6-fourth-fresh`          | `b4e7a0c6` | 80 / 86           | 清单重放TypeError真实RED；另5为交付文件lineage fixture错误                                           |
| `b6-fifth-fresh`           | `c976d863` | 81 / 86           | 4完成路径DriverAdapterError（原摘要截断，CHECK归因为静态推断）；旧Task9一次STACK_TRACE_ERROR原因未知 |
| `b4-first-golden-fresh`    | `7d3f48d4` | 1 / 3             | fixture缺media sourceSha256，并非业务RED                                                             |
| `b4-second-golden-fresh`   | `1c6c8d41` | 3 / 3             | 修复fixture后A/B真实激活全过                                                                         |
| `b6-sixth-fresh`           | `c5b8ef21` | 82 / 88           | 旧80全过；5完成/重试明确触发旧FINAL/SETTLED延迟约束；1负例漏version递增先被其他守卫拒绝              |
| `b4-first-recovery-fresh`  | `a2949ff5` | 27 / 29           | 两个真实ACK恢复失败，另27通过；真实生产RED                                                           |
| `b4-second-recovery-fresh` | `c2512636` | 29 / 29           | 限定领取修复后29全过                                                                                 |

以上各轮原报告、失败诊断摘要、receipt及独立读回摘要均保留，七项runtime特权/ownership均false，target由launcher退役。第六轮原Task9异常未复现，只能记录未复现，不能追认为超时/偶发。每次新source均以fresh目标完整执行，不复活旧库。

定价聚焦单测先出现过证据fixture过宽和Decimal structuredClone两个测试错误，原日志保留；修正fixture后最终RED为8/12、四个真实TypeError，GREEN为8文件81/81。B4曾误列两个单测文件名，首次只执行repo52项，不计作四文件；改正命令后四文件97项全过，最终集成12文件178项全过。

可核对原件索引（source、run/operation、报告摘要、receipt、独立digest、时间/目标）：下述本地证据目录的 `task8-evidence-summary.json`；历史原件以表中checkpoint为文件前缀，没有被最终通过覆盖。

## 同源完整五套与保管读回

| suiteId                                              | passed | started / closed UTC                                            |
| ---------------------------------------------------- | ------ | --------------------------------------------------------------- |
| `api.subscription-journey-golden-path.postgres`      | 3      | `2026-09-25T09:21:09.1780823Z` / `2026-09-25T09:22:24.5093146Z` |
| `api.subscription-journey-failure-recovery.postgres` | 29     | `2026-09-25T09:23:08.6217379Z` / `2026-09-25T09:24:28.4376729Z` |
| `api.subscription-expiry-return.postgres`            | 90     | `2026-09-25T09:25:41.7952060Z` / `2026-09-25T09:33:14.7623062Z` |
| `api.subscription-closure-schema.postgres`           | 14     | `2026-09-25T09:33:49.4876274Z` / `2026-09-25T09:35:11.2040002Z` |
| `api.subscription-closure-repository.postgres`       | 59     | `2026-09-25T09:36:44.9323792Z` / `2026-09-25T09:38:20.6470607Z` |

| suite（去除api.前缀）                            | runId / operationId                                                             | report SHA-256 / receiptId                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `subscription-journey-golden-path.postgres`      | `201f8f01-b82a-43a0-88f5-19f050fdef86` / `1fe71ddf-9a3e-4dae-83d9-8876e7c91cb5` | `sha256:32d14b5c3a3abb11de413d10ece86495cb65fdb4af9340c73dbd2eaaf7f2d9ba` / `ea1a7d02-c5a3-40ec-8347-37a462748005` |
| `subscription-journey-failure-recovery.postgres` | `a7d97ff9-7c16-4f96-b8a0-1cd0d0f352a3` / `8b03062f-f375-4d65-a48a-8a6b7a53e037` | `sha256:1bb6bc3ed062d18b4bfb1c082809660860410d322ef5f0bd0b8d9d3ba3255a2a` / `677308ac-38ca-4014-b341-8c38a548c47b` |
| `subscription-expiry-return.postgres`            | `a617b1e4-a4aa-4603-8395-9338d2fcc10d` / `21426c3a-8724-4132-8277-035b258476ee` | `sha256:0726c3f318c467fd6ac93a0138d3b8a10da9f92fcfa9f7d8760f5e27801e8f6d` / `74826302-f4f1-4917-bf45-d9e0650f6e9c` |
| `subscription-closure-schema.postgres`           | `d2dd5ebd-c5c1-419b-b69b-b5d3fe70de2c` / `e2b558a8-8f4e-45ff-9421-9141af132995` | `sha256:e682d0354d08cd0359eff7796fc123bc0aafc6affe611b5e90cceb4ba94d051a` / `e33205f5-bb96-46b5-9c8a-e111e3fc127e` |
| `subscription-closure-repository.postgres`       | `ebc65d75-b017-479e-9cbf-02f01bcdbbbd` / `881e237a-b312-4679-b4c8-4d5520796281` | `sha256:802a36f1798606b871a393dfa64c1b0790dcbede65cb339227258aedab320a10` / `3bc937e3-dda2-439c-a973-3e4b10672995` |

| suite（去除api.前缀）                            | database / OID / targetFingerprint                                                                                    | report bytes / receipt file SHA-256                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `subscription-journey-golden-path.postgres`      | `s1ci_91a0076ab64642a63a56ba7b` / `16386` / `sha256:034243ea06a3918cb554bf1be8362620e0ff467e77a99629c8ccc7fedab52169` | 972 / `2576d7de9e9a1f6f6462082d1004eea495ee6f5ce03819b81f11c713c0d611ca` |
| `subscription-journey-failure-recovery.postgres` | `s1ci_6ac626877cdd09590072b56e` / `16386` / `sha256:456afb7de13cfac491972a387317b963155c78a59d01130a0b00fbcd8abf8aa4` | 981 / `3ffa0d6eb69b2757f08ffd6d829cdb2898c2852feb4fc056b196c4420c383cda` |
| `subscription-expiry-return.postgres`            | `s1ci_5fa8d5aff59ae40bba0ae835` / `16386` / `sha256:8f560955fc88516cbf41c16fe7eef48b4cf982e775a17bb2c611284acd915904` | 970 / `12c487746a7f81946ebc97de93d350e9a328a8b8a46d64a91e290d4d84f2ad36` |
| `subscription-closure-schema.postgres`           | `s1ci_f372e7dc7f142df5ed6bfcb5` / `16386` / `sha256:8c40437e5f2b095cc0f13c145a50d53e7a85e8b93d2994bcccc3e9e547977cd8` | 971 / `7f875004fa2354ae913dee81879ca99f5bc740c5c1bef5951cfbb4c83ec705be` |
| `subscription-closure-repository.postgres`       | `s1ci_220deab527f4e712ca244587` / `16386` / `sha256:913ce5029dfce9ca31d13e2ec5d2647a605a01eb9507a0d6b2b78cafd21e2306` | 975 / `a06788bf791605cd4c2a360489849449911a24c67a893815d80ce4937cf48735` |

每份报告文件原始bytes的SHA-256等于receipt.contentDigest、独立readbackDigest及stdout JSON重新canonical化后的摘要；stdout原始JSON键顺序不同，**不声称stdout原始bytes/hash与canonical文件相同**。每轮完整report/receipt都被独立重开核对；七项runtime属性superuser/createdb/createrole/bypassrls/canCreateSchema/schemaOwner/objectOwner均false，五个精确run目录均不存在，旧retired fixed路径未复活。

- manifestDigest：`sha256:f4892d83e4943fe8acaf729bf4fd87cc41fb143f6b6abc55e8b8e80929f74116`。
- discoveryDigest：`sha256:4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a`；95候选、39登记、56例外、0未分类。
- repositoryContractDigest：`sha256:3778c7b48e731073b722d3edd3f5b6fe393d1015ae19a4fc81367439a00678e8`；174文件、68 Schema、13命令。
- 新两条迁移在每个独立fresh目标上应用，并由schema14项/repository59项回归验证；没有在服务器应用迁移或连接ambient数据库。

本机Node24.14.0/pnpm11.4.0/Prisma7.8.0，仅本地辅助证据；不冒称最终Node22 Runner镜像。现有Schema模型未变，因此没有更新生成客户端。

本地完整原件：`D:/Projects/auto-subscription-platform/.worktrees/stage1-audit-closure-20260925/.superpowers/sdd/2026-09-22-stage1-audit-driven-closure-plan/`，最终前缀 `task8-final-golden-fresh`、`task8-final-recovery-fresh`、`task8-final-expiry-fresh`、`task8-final-schema-fresh`、`task8-final-repository-fresh`；源码门禁日志为 `task8-integrated-*`，完整report/receipt在同树 `.release-local/evidence/`。B4早期四轮在独立 `stage1-b4-activation-20260925` worktree的同名证据目录，历史文件保留。

## 审查与后续

生产、夹具、五套完整数据库原件及本文已独立复审，结论为任务8本地范围限定ACCEPT；主控独立读回亦通过。本轮关闭B4/B6当前服务证据与F6修复，不扩大为阶段1整体通过。任务8之外，R2.1共享MS2工具schedule与适配器组合仍在实施；R2.2/3、H1/H2/独立expected-schema、R2.4双场景、最终fresh/snapshot双链、Staging恢复/浏览器/真实渠道/维护/恢复演练及人工签字继续开放。用户指出本系统服务器Docker均已停止；未来确需线上调试时先识别并恢复本系统环境、健康检查，再执行获准操作。本轮未恢复线上、部署、推送或调用供应商。
