# Stage 1 正常退车浏览器入口与定价证据成员修复验证

执行日期：2026-09-26。限定本地实现与受控测试；阶段1、R4 Staging签字和实际浏览器尚未完成。同一干净测试源 `a86ed40763e5a9ebb31f58ab7e3e740d7a72b23b` 的两套完整fresh共127/127通过，保管、独立读回和精确退役完成。后继 `f3b6d6fe` 仅格式化一个Web测试，所有生产及API测试字节不变，不改写实际门禁来源。

## 改动和行为

- `4568006b` 补正常退车检查工单入口：从 closureCase 取精确 returnAssetWorkOrderId，经现有受权 GET 读真实 version，再由操作者分别推进 PENDING_ACCEPTANCE、CLOSED。两个独立 MANUAL_OPERATION 命令保留自己的 UUID/稳定键；不伪造内部业务来源或 actor，不把工单关闭代替 delta/inspection。
- `f02af8de` 补正式正额 CUSTOMER 计价后的草案刷新。仅当当前 PROPOSED 的当前 FINAL 收费对应未取消账单尚未写入原 billInputSnapshot 时，投影增加原 PROPOSE 动作、UI显示“更新结算草案”。仍用现有服务创建后继 proposal，再通过原定价动作复用旧 bill/生成 successor line；不覆盖历史 hash、金额或客户响应，不提前发布。
- 两个生产组件的窄 controller 保留稳定请求、同步 busy、绑定代次和读序列，处理双击、超时、丢响应、case/revision切换、旧读回晚到、权限变化、dispose及业务成功后读回失败。真实页面使用严格 closure reader；读回未成功不能当作动作成功或恢复发布。丢响应后仅看到新 revision，不证明本次命令提交。
- `7583a8c9` 修复人工定价审批证据校验。真实上传和实物接收允许同一证据分别形成 CHECKLIST_PROOF、DAMAGE_PROOF 关联；原行数比较会误拒合法多关联，也可能用重复 A 抵消缺失 B。仅 PRICING_OVERRIDE 改为本案证据 ID 集合逐项覆盖；原合同/条款/delta/current revision、独立批准状态与完整快照、事务/锁/错误码保持。
- `acf75c4f`、`0004e070`、`a86ed407` 为真实 HTTP/服务组合与测试隔离：同套 fresh 真实 Nest guards/DTO/service/repository/audit/Prisma；只有登录身份为测试替身。三个 HTTP 样本全部断言后暂停其精确 ACTIVE 计费计划，记录测试隔离原因与version并读回；不可变事实保留。Node 原生 HTTP 客户端仍调用 loopback 随机端口，避免浏览器兼容 fetch 的 forbidden-port 策略在到达服务器前拒绝；未改产品 fetch 或安全配置。

总范围：7个生产文件、7个测试文件；无 Schema、migration、依赖、权限定义、seed、manifest、launcher、CI或部署变更。两个计划分别为原 `2026-09-26-stage1-return-browser-gap-plan.md` 及窄追加 `2026-09-26-stage1-pricing-evidence-membership-fix-plan.md`；原冻结计划hash未改。

## 测试覆盖边界

工单 HTTP 组合覆盖精确关联id/latest version、read/manage权限分离及拒绝时业务调用为0、伪actor剥离、两个独立人工来源、同命令重放零新增、改body冲突、并发version竞争、未来发生时间、无效目标/软删除权威、越级或成本分支拒绝、真实审计失败事务回滚与原命令重试。事件、审计及Closure/Order/Contract联合读回保持原语义。

正额定价段调用真实 controller/service/projection，验证新增bill后旧草案finalize仍拒绝、刷新后生成 successor proposal/line并复用原bill、历史proposal/line不变、原key重放、错证据/数量/条款/审批/有效账单替换拒绝、客户回应绑定最新revision/hash。该段是直接controller调用，不声称经过HTTP guards。人工审批成员单测经真实 requestApproval/createPricing；rows按真实where过滤，批准状态/快照正例是受控dependency double，不是实际Asset Accounting授权。

Web 单测包含实际异步controller及API helper、deferred读写、页面严格reader和SSR接线；没有运行真实浏览器。签署provider、存储字节、成熟合同/交付基线等继承已有明确fixture边界，不构成法大大、资金或真实业务样本证据。

## 离线门禁

最终 `a86ed407` 上完整API七文件225/225、API tsc、14个改动文件ESLint及diff检查通过。Web三文件87/87、Web tsc在 `7583a8c9` 通过；该源到最终源仅两API测试文件的HTTP transport改变，Web及所有生产输入逐字节未变，未为新提交号重复运行无变化Web。更早 `f02af8de` 的Web87/API197也是原源历史，不与最终225累加。

聚焦人工定价最终28/28、lint0。14文件独立格式核验中7个通过；6个既有大文件在原基线和当前均false，保留原格式例外。另一个Web view-model测试由基线true变为false，在两套PG完成后经独立复审，以 `f3b6d6fe` 单独修正两处折行并通过Prettier；无断言、值或逻辑变化，不因此重复无变化业务测试或改写原源。该测试原SHA为 `bb51d03ecbf2cae1ef6679c40ef6852a680575aa31394535e759f1cd54747e28`，格式后为 `a1434e54af7187d688b865a7efac4f6c36efd5af61a017c127f15e0024d35c19`。没有全文件整理6个既有例外文件或更改lint策略。一次14文件lint命令因PowerShell/pnpm数组被当作单路径而exit2；改为直接Node执行相同ESLint、明确14个argv后exit0，原日志保留。既有Next pages目录提示保留。

原件根目录：`D:/Projects/auto-subscription-platform/.worktrees/stage1-return-browser-fixes-20260926/node_modules/.cache/sdd/stage1-return-browser-gap/`。`transport-final.inputhash.json`绑定最终14文件SHA；`transport-final.api7.*`、`transport-final.api-types.*`、`transport-final.owned14-lint-fixed.*`保存最终命令结果。Web原件为`counterexample-final.web3.*`及`counterexample-final.web-types.*`。

## 失败历史（不改判）

| 原件前缀                               | 实际结果                                | 原因与后续                                                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db-capture/r4-browser-expiry-fresh-1` | `f02af8de`完整94项，91通过3失败，exit1  | 两个旧Task7全局调度断言受3个新HTTP样本的到期计划污染；另一个人工定价被证据归属guard提前拒绝。后者多关联根因由源码/独立审查和后续row-backed RED确认，首轮摘要未打印完整links；原报告已保管、独立读回并退役。 |
| `pricing-membership.red`               | 28项18通过10失败                        | 3个合法多关联路径误拒/错分类，2个重复A掩盖missing/foreign B的错误放行；其余5个审批状态反例在准备request时先被成员guard挡住，不能说原状态守卫曾失效。                                                        |
| `counterexample-final.api7`            | `7583a8c9`完整225项181通过44失败，exit1 | 44个HTTP请求全部`fetch failed`/`bad port`，未到业务接口；实际分配端口未记录，不报具体端口值。其余6文件通过。后继原生HTTP修复后完整225通过。                                                                 |

Task1最早动态引入AntD有一次冷加载超时，随后静态import；实际异步行为RED保留。Task3首次API类型检查报Task2并行fixture三处可空索引，修复后最终类型检查通过。这些不冒称业务RED。所有重叠聚焦计数不相加。

## 完整数据库证据

两套均在同一干净source `a86ed407`、原未修改B5 capture/launcher下串行完整执行，无filter/skip/only。每套独立fresh目标，由launcher完成迁移deploy/status/diff和权限读回；以下 collected=selected=executed=passed，failed/skipped/filtered/cancelled/todo全部0，exit0。主控随后又用原 `Read-B5FreshResult` 重开首轮失败和两轮成功的全部报告/receipt，核原始文件SHA与stdout/stored canonical、receipt.contentDigest/readbackDigest完全一致；stdout原始键序不同，不声称原始stdout字节等于canonical文件。

| suiteId                                   | passed | started / closed UTC                                            | runId / operationId                                                             |
| ----------------------------------------- | -----: | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `api.subscription-expiry-return.postgres` |     94 | `2026-09-26T10:55:45.4482559Z` / `2026-09-26T11:04:35.4772250Z` | `306377e7-e38b-432d-a2b5-f00c9644fe5b` / `27e2256a-8080-4022-8ffa-d2e9b79b45c6` |
| `api.asset-operations.postgres`           |     33 | `2026-09-26T11:05:50.5906559Z` / `2026-09-26T11:07:11.9433717Z` | `ad5ad373-b1f0-4860-bb58-4c5975727f76` / `39467cd4-e652-48fb-943f-9efb00c38a49` |

| suite  | report SHA256 / bytes                                                    | receiptId / receipt文件SHA256                                                                               |
| ------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| expiry | `b50e6236905b9ceda81ea262d7b39f42cc81c292f0fc3c8e1dcaa837cf0bdda8` / 970 | `ed9c1972-cdd5-4fa9-972d-8555cfb1b157` / `e2dd307459eeaed7ac3da222b59fb21f8fd12cd4881443e5e9bd9693d88b7fc1` |
| asset  | `03a6ecf92a65b88091bea198b8ded2b7f051cce97374ac334419e9f2b7f7efe8` / 960 | `f4f5ab29-ba51-4e4a-bd67-91da88707808` / `25d6472bc06a00e50bc65ea68ad63eaa4a76e44fb209ab56610d715296430ef7` |

| suite  | database / OID                            | targetFingerprint                                                         |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------- |
| expiry | `s1ci_aed59719c6fbea06accbfdd2` / `16386` | `sha256:cf23e4f10ff5a8c0d3d7225fd912b092042856deeb9ac54e737fb4a5510f7666` |
| asset  | `s1ci_14ce7a1dec1288a8e7f665bd` / `16386` | `sha256:2e6c0936908a830821e2965f09c942071b039afcffdcc491d74c1be649022fda` |

三轮全部七项runtime特权/ownership为false，精确run目录不存在，旧fixed target/secrets路径未复活。保管原件在同worktree `.release-local/evidence/`，三个捕获前缀在上述cache的 `db-capture/`；`r4-pg-evidence-summary.json`保存三轮独立读回索引，`r4-final-offline-summary.json`保存离线实际source/时间/exit/摘要。首轮失败报告digest `sha256:b16ac2fc94bc48d63d437d7933f50a26393b472d9ba63d5ce04e370bc98ed951`不变。

当前契约核验176文件、68Schema、13个命令契约（commandContractCount）、128迁移；repositoryContractDigest `sha256:9630a34b556da831b260396b8aa28e2176cb1e113a174962ff09a94382d4dbb3`，migrationDigest `sha256:65ebe3208fc618ae82ad24f66b793e9bddd7464526dd45b8a0d9893d24a0ff62`。manifestDigest `sha256:f4892d83e4943fe8acaf729bf4fd87cc41fb143f6b6abc55e8b8e80929f74116`；discoveryDigest `sha256:4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a`，95候选/39登记/56例外/0未分类。本轮无新增迁移文件或线上服务器DDL；本地fresh目标执行现有迁移。

## 未关闭项与后续

- 真浏览器尚未执行；线上本系统Docker仍按用户说明停止，本轮仅本机临时测试容器。线上联调须先识别并恢复获准环境/健康，然后按R4执行真实A/B及成熟样本、渠道、两次非空维护和恢复演练。
- 本机Node24.14.0、pnpm11.4.0、Prisma7.8.0仅辅助环境，不是最终Node22三镜像。H1/H2/独立expected-schema、R2.2完整父子链、R2.3/4、最终fresh/snapshot双链和阶段1签字继续开放。
- 新审计发现financial WAIVER/WRITE_OFF的两来源行数相加存在代码级成员校验缺口：重复A可能抵消缺/foreign B。request/decision重用resolver，disposition只独立核所选财务证明，未重验整份成员集合。未运行该真实入口RED/PG，不称已发生财务损害；独立下一切片须保留真实两人审批及ID并集覆盖，当前pricing修复不关闭它。
- 下一切片静态调查另发现，governance调用真实AssetAccounting request/decision时未提供其要求的context.idempotencyKey，合法真实审批可能先被拒绝。应先经真实依赖反例确认并最小接线，不能以mock审批成功掩盖；请求/决定每次生成时间与同键重试语义另列，不在本报告声称真实审批链通过。
- REGISTRATION分支额外限定checklistItem，未确认同item同evidence多关联的生产可达路径；电子签后置Set核验已有缺项保护。登记防御性检查，不称已确认端到端绕过。

全部R4代码切片、格式后继、三轮PG完整原件和本文已经独立终审，结论为限定本地范围 ACCEPT。审查实际重开报告/receipt并复算摘要、核权限及退役，不把该结论扩大为真实浏览器、财务审批后续单元或阶段1完成。
