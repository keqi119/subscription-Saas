# Stage 1 专用测试支付原路退款实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（沿用子 agent 分任务、主 agent 审查）；用户改变模式时可使用 superpowers:executing-plans。Steps use checkbox (`- [ ]`) syntax for tracking. 本轮仅批准既有五文件口径同步；不执行 RF1–RF5，不授予商户、配置、资金或财务操作权限。

**Goal:** 验证并按独立批准完成本轮专用测试支付的商户侧单次全额原路退款、结果确认和人工财务对账，不建设通用退款产品。

**Architecture:** 方案 A 是独立资金收尾：既有微信商户平台“退款管理”通过商户订单号或微信支付订单号定位原单并人工退款，Staging 只读提供原付款事实，既有财务渠道负责实际记账与独立核对。A 不适用只停止该路线，不阻断 Stage 1 实施、候选提升或主线验收签字；真实事故外溢仍触发主线安全停止。备选 API 集成不在任务树中。

**Tech Stack:** 现有 Markdown/JSON、Node 离线契约检查、已有商户后台与平台只读页面、已具备且逐项获准的私有财务档案。无新库、API、数据库对象、Runner 或云资源。

**Spec:** [专用测试支付原路退款方案](../specs/2026-09-07-stage1-controlled-test-refund-design.zh-CN.md)。原方案/计划及 RF0 文档提交属于历史，当前同步取代其“退款先通过才允许主线付款/签字”的前向依赖；不把文档或路线批准当成代码施工、真实操作或退款验证通过。

## Global Constraints

- 原核查基线 `f798f5bdacfa56b074a30d7357f30616fb8ebec7` 是历史本地文档基线，不是 main/RC/build proof。本轮只同步 Runbook、方案、本计划、主线索引及退款 reason，不重写历史证据；主 agent 独立审查并串行提交，执行者不暂存/提交，不触 stash。
- 方案 A：一次原支付单一次全额 CNY 原路退款，无优惠券、分账、多付款人、历史/未决退款；仅限已有正常审批免押、原付款分摊只有测试租金的退款样本，不降押金/改风控或新造夹具。这些限制不约束全部 A/B 主线样本或主线付款。平台业务数据全程只读；商户受理、渠道成功、财务核对是三个不同事实。
- 不调用 `refund-deposit`、不改 PaymentRecord/WriteOff/Bill/Closure/Journey、不写负付款，不用 SQL/恢复模拟退款。财务处置不具备时停止该退款路线，不用“人工差异表”抵账，不声称平台余额已冲回。
- RF0 原文档/登记修订已存在，本轮仅同步其最新边界；RF1–RF5 的每次商户访问、平台读取、退款、财务记账、样本暂停/恢复仍各自批准。R1 数据库人工授权或旧 infra approval 不等于商户/财务授权。
- 主线真实付款、回调和核销继续使用既有微信 API v3，并按候选/隔离/通知/金额等独立门槛取得付款许可，不等退款核验或财务收尾。退款只在实际原交易产生后另核验、独立批准；签署及通知不在本计划执行。不开发退款 API、不配置退款 notify URL、不改支付 callback，也不自动转入接口开发。
- `stage1.refund` 保持独立 `must-external-verify`，退款或财务缺证据不写通过/N/A，亦不作为 Stage 1 实施、候选提升或主线签字前置。`scripts/stage1-golden-path-production-preflight.mjs:155-164` 仍无条件要求退款额度并拒绝其超过付款额度；本轮不改脚本/测试、不运行总预检，按新范围使用前须另行限域批准实现对齐，不伪填额度或忽略实际 blocker。通知和其他安全门禁保持。
- B3 不重复重验。Task 30、旧 Task 6/29R/I、冻结 stash `b299ceeed80374d181998f8ef485629beba56b5f` 不动；已批准本地 B/R 工作可独立继续。本计划不新增测试 DB、迁移检查或 fresh 入口，也不将此前本地迁移状态当候选通过。
- 单次及累计金额均以整数分核对；批准值、财务档案位置和操作者必须来自实际审批，不在文档示例中填猜测值。公开提交只含掩码证据引用/摘要，不含秘密、原交易明细或普通客户数据。

## 1. 任务依赖、文件与停止点

```text
本轮批准的既有文档/登记边界同步
  → RF0 限域同步及离线检查、主 agent 独立审查
独立退款路线后续另行批准
  → RF1 只读可行性核验（先批准访问；不产生资金）
  → RF2 无资金桌面演练及独立复核
  → RF3 只消费主线独立批准产生的真实原单，核验后再批准退款
  → RF4 人工单次提交与同单结果确认
  → RF5 实际财务凭证、日终对账、独立读回及限域签字
```

退款路线任一节点未通过，仅停止其后续节点，不阻断两条主线实施、候选提升或主线签字。RF1 失败不进入 API 开发；RF3 不触发付款，主线自身候选/通知等门槛不得豁免。RF4/5 失败保留外部事实，只做另获批准的只读跟进，不从 RF4 重头操作；实际资金/隔离事故仍执行主线安全停止。

| 精确路径                                                                 | 文件事件/唯一 owner          | 范围                                                                     |
| ------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------ |
| `docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md`        | RF0 Modify                   | 退款独立、非主线前置；保留主线支付/安全及未实施预检差异                  |
| `release/contracts/external-validation-applicability.v1.json`            | RF0 Modify                   | 仅 `stage1.refund.reason`；其他记录、状态、owner、reviewDate、suite 不变 |
| `docs/acceptance/2026-09-07-stage1-controlled-test-refund-validation.md` | RF1 Create；RF2–RF5 追加结果 | 统一脱敏索引，无私有原件；已存在则停止交主 agent 核对，不覆盖            |
| 方案与本计划                                                             | 本轮 Modify                  | 同步批准边界，不改历史执行结果                                           |
| `docs/acceptance/2026-09-06-stage1-mainline-execution-index.md`          | 本轮 Modify                  | 仅登记主线恢复与批准版本，不提前记录 B1/R2 通过                          |

无产品代码、API/Web、模型/枚举/迁移、RBAC、工作流、Runner、package script、测试 manifest 或 Schema 文件事件。RF0 会改变 repository contract digest，后续候选使用包含该修改的新 main/可信构建；本计划不执行构建或部署。

## Task RF0：同步既有文档/登记的当前边界

**Files:** 本轮只 Modify 上表五份文档/登记；JSON 仅改退款 reason。**Consumes:** 本轮明确批准、既有文档与实际工作树。**Produces:** 待主 agent 独立审查的精确 diff、离线检查及新 contract digest；不产生退款授权或预检实现变更。原 RF0 文档提交不覆盖或改判。

- [ ] **1. 读取批准与工作区。** `git status --short --branch`、`git log -1 --format=%H`；按五文件范围识别并行 B1/R2 修改，不覆盖或暂存它们，不触 stash。完整读取最新五文件，不改变 B3 原任务或历史证据。
- [ ] **2. 精确同步前向依赖。** Runbook 第 1–4、8、10–12 节和方案/本计划统一：主线真实支付/回调/核销保留，退款路线/财务收尾不作为 Stage 1 实施、候选提升或签字前置。免押/仅租金只限该退款样本；退款独立批准、原单关联、金额、唯一提交、UNKNOWN 只查询、实际财务凭证均保留。notify 只读适用性不等于配置退款 URL 或修改支付 callback；通知独立批准及其他安全门槛不变。独立退款 STOP 不扩大到主线，真实事故外溢仍停。主线索引仅登记批准版本与当前工作，不提前登记测试通过；明确总预检退款额度依赖未实施对齐，不伪称门禁已改。
- [ ] **3. 仅替换退款登记 reason。** 使用以下完整值，保留独立 `must-external-verify` 和现有其他字段；不能将退款项改为 N/A，也不新建自动化 suite：

```text
退款为独立人工资金收尾：经独立批准在微信商户平台退款管理按商户订单号或微信支付订单号关联原交易，单次全额原路退款并核验渠道终态、平台原付款只读事实、财务凭证及日终对账；不作为 Stage 1 实施、候选提升或主线验收签字前置。未执行或缺证据仍未通过，不改为 N/A；api.billing-automation.postgres 仅为关联，不证明真实退款或平台自动退款/余额冲回，不开发退款 API、不配置退款 notify URL、不修改支付 callback。
```

- [ ] **4. 运行现有精确离线检查。** 下列仅源码/契约检查，不运行产品/DB/外部预检；任一非零即停止，不改测试来绕过：

```powershell
$ErrorActionPreference = 'Stop'
node --test packages/release-foundation/test/schema-registry.test.mjs packages/release-foundation/test/database-test-discovery.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'RF0_OFFLINE_TEST_FAILED' }
pnpm release:contracts:verify
if ($LASTEXITCODE -ne 0) { throw 'RF0_CONTRACT_FAILED' }
pnpm release:database-tests:discover
if ($LASTEXITCODE -ne 0) { throw 'RF0_DISCOVERY_FAILED' }
pnpm exec prettier --check docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md docs/superpowers/specs/2026-09-07-stage1-controlled-test-refund-design.zh-CN.md docs/superpowers/plans/2026-09-07-stage1-controlled-test-refund-implementation-plan.md docs/acceptance/2026-09-06-stage1-mainline-execution-index.md release/contracts/external-validation-applicability.v1.json
if ($LASTEXITCODE -ne 0) { throw 'RF0_FORMAT_FAILED' }
git diff --check -- docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md docs/superpowers/specs/2026-09-07-stage1-controlled-test-refund-design.zh-CN.md docs/superpowers/plans/2026-09-07-stage1-controlled-test-refund-implementation-plan.md docs/acceptance/2026-09-06-stage1-mainline-execution-index.md release/contracts/external-validation-applicability.v1.json
if ($LASTEXITCODE -ne 0) { throw 'RF0_DIFF_FAILED' }
```

预期：全部离线用例执行通过且无 skipped/todo/cancelled；契约编译通过、发现无未分类，记录真实计数和 digest，不把旧数值固定为通过条件。

- [ ] **5. 独立审查并精确提交。** 执行者停止在五文件 diff 与本地报告，不暂存/提交。主 agent 独立复核只有退款 reason 改动、其余登记状态/owner/suite 未变、没有通知或安全门槛豁免，并串行处理精确提交；以下仅供主 agent 审查通过后使用，不在本轮子任务执行：

```powershell
git add -- docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md docs/superpowers/specs/2026-09-07-stage1-controlled-test-refund-design.zh-CN.md docs/superpowers/plans/2026-09-07-stage1-controlled-test-refund-implementation-plan.md docs/acceptance/2026-09-06-stage1-mainline-execution-index.md release/contracts/external-validation-applicability.v1.json
if ($LASTEXITCODE -ne 0) { throw 'RF0_STAGE_FAILED' }
git diff --cached --name-only
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'RF0_STAGED_DIFF_FAILED' }
# 主 agent 确认 staged 列表恰为上述五文件、无并行 B1/R2 成果后才提交。
git commit -m "docs: separate refund cleanup from Stage 1 mainline gates"
if ($LASTEXITCODE -ne 0) { throw 'RF0_COMMIT_FAILED' }
git show --check --format=oneline HEAD
if ($LASTEXITCODE -ne 0) { throw 'RF0_COMMIT_CHECK_FAILED' }
```

RF0 不因文档提交成功而解锁任何真实操作。

## Task RF1：既有商户/财务路线只读可行性

**Files:** Create 唯一 validation 索引。**Consumes:** RF0 审查结果、每次只读访问许可。**Produces:** `可行/不适用/未知` 的逐项表、原始材料私有引用与读回；没有退款单。

- [ ] **1. 先申请访问许可。** 绑定确切已有商户、Staging 目标与只读角色、访问窗口、操作者/独立复核人、资料范围。尚无真实原支付单号时只核查路由、功能权限、账单字段和财务方法，不引用未来退款/微信支付 ID。
- [ ] **2. 由人登录商户后台只读核查。** 通过官方入口确认账号与商户身份，确认单笔原路退款、订单/退款详情和单笔凭证权限；不得点击提交退款、配置或批量操作。记录页面实际字段、通知行为和支持单号，不按旧截图自动点击。
- [ ] **3. 核查通知及资源隔离。** 读取现有配置并记录来源；A 只接受“退款实际无应用通知 + 独立批准查询模式”，不支持将商户全局 v2 XML 推入现有付款 callback。若有生产消费者、未知配置或须改租户设置即不适用，保留原状。支付/签署的精确 Staging callback 门槛另核验。
- [ ] **4. 财务负责人确认处置、来源与保管。** 按具体测试账单性质列出现有记账方法、凭证类型、账户/手续费核对、权限、责任人、独立复核人、档案与保留策略并读回。按方案 §4.1 核实已有 `billing:view`、`deposit_ledger:view` 和专用客户会话的字段；逐笔核销/到账必须有获准、精确限域并关联原单的现有来源，汇总或 bill items 不算明细。退款所需来源缺失只停止 A，不开放 SQL/API。核对该退款样本正常免押与仅租金分摊；含押金则 A 不适用，不扩大成主线免押门槛。不得以备注代替会计处理或让 agent 看普通客户整批明细；需平台余额/义务变更而无既有获批路径时 A 不适用。真实收退款仍须实际记账。
- [ ] **5. 建立脱敏索引并独立审查。** 每项列 `要求｜实际观察｜受控引用/摘要｜复核人掩码引用｜结论｜停止原因`。未来变更单/私有原件的位置须由本次真实核验返回，未提供时写“不可用”并停止，不造文件/receipt。RF1 的公开索引不得含真实账号、OpenID、交易明细或批准人的姓名。

索引只记录历史和事实，不是操作授权系统；RF1 可行也不授予付款或退款权限，RF1 不可行不阻断主线独立付款。格式检查只针对该文件，提交该索引独立结果前须主 agent 核对脱敏与引用。

## Task RF2：无资金桌面演练与反例审查

**Files:** Modify validation 索引追加演练表。**Consumes:** RF1 可行结论及方案规则。**Produces:** 合成演练结果，明确 `非供应商实测`；不新增程序/测试套件/Schema。

- [ ] **1. 用合成纸面样本演练完整顺序。** 原支付 P=100 分、同商户、无优惠/分账/已退/在途退款；付款有其独立批准，退款单次/累计额度覆盖 100 分。按“主线独立付款及实际原单→独立退款路线核验→退款批准→单次提交→结果确认→财务记账→日终复核”填写合成记录，不将退款核验放在主线付款之前，不提前填未来单号。
- [ ] **2. 逐项执行下表反例。** 两人分别判断后比对，预期不一致则停止修订方案，不自行改产品。全部材料标合成，不签发实际批准，不访问商户。

| 用例              | 合成输入或变化                                                                     | 必须结果                                          |
| ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| 正向              | 正常免押、只有测试租金；P=100、R=100，原单一致；最终 SUCCESS 且原路，凭证/日终齐全 | 仅人工规则演练通过，不代表真实退款                |
| 错商户/原单       | mchid 或 transaction_id 与批准不同                                                 | 提交前拒绝                                        |
| 超额              | R=101；或单次/剩余累计上限=99                                                      | 提交前拒绝                                        |
| 历史退款          | S=1 或 U=1；或 U 不可确定                                                          | A 不适用，拒绝                                    |
| 金额歧义          | 页面单位未知、优惠券/分账、元无法精确转分                                          | 拒绝，不自行算净额                                |
| 保证金混入        | 原付款含押金，或需要临时修改风控/押金才能免押                                      | A 不适用，不伪造免押或仅退租金冒充全额收尾        |
| 并发              | 第二操作者未确认停手或版本已变化                                                   | 拒绝，不同时批准两笔                              |
| 重复点击/交接     | 已提交一次后另一人要求再点                                                         | 禁止提交；只查询原单                              |
| 响应丢失          | 页面超时，未得到退款 ID                                                            | UNKNOWN；原交易查询，不以空列表证明未提交         |
| 只受理/已扣款     | PROCESSING，资金账单已有支出                                                       | 不认 SUCCESS，不认已退给客户                      |
| 结果冲突          | 同退款号的原单或金额变化                                                           | STOP，保留两份记录                                |
| 重复通知/回单     | 同退款号第二次出现                                                                 | 不重复记账；A 出现通知视为路由异常并 STOP         |
| 非原路/终态异常   | 去向不是原路，或 CLOSED/ABNORMAL                                                   | 未通过；不更换收款人/新退款单                     |
| 缺会计凭证        | SUCCESS 和截图齐全，但无实际记账凭证                                               | 退款事实保留、财务未通过                          |
| 账单未出          | 渠道 SUCCESS，但当日日终资料尚未生成                                               | 待对账，不伪造摘要或关闭                          |
| 全局通知          | 后台退款会通知生产应用/未知地址                                                    | 停止退款路线，不改全局配置；已外溢则主线事故 STOP |
| 通知未批/候选缺证 | 退款路径可行但总门槛未通过                                                         | 不付款、不豁免                                    |

- [ ] **3. 主 agent 复核及单独记录。** 必须记录执行了 17 行、每行实测的人工判断、偏差与审查者；不得写成 17 个自动化测试通过。无偏差才进入 RF3，否则只做文档修订再审。

## Task RF3：消费既有原付款事实并精确批准退款

**Files:** Modify validation 索引，私有操作记录在已有变更单中。**Consumes:** RF1/RF2、主线独立批准产生的真实原付款及既有候选/隔离证据。**Produces:** 原单核验和独立退款批准；本任务不发起付款、不提供付款命令，也不作为主线付款前置。

- [ ] **1. 检查候选与独立门槛。** 只消费最新 main 可信 build proof、匹配 contract digest、最终镜像及合法副本/双链/readiness 证据，不能以本地 build 替代。通知没有独立批准且总预检仍阻断时就停。B3 结果由原线程提供；缺任何需要的业务门槛不自行重跑。
- [ ] **2. 退款前读回路线资格。** 再核对 RF1 商户/权限/资金/通知/财务方法；该退款原单具备正常免押批准、仅测试租金分摊且金额/性质符合 A，不合格只停止退款路线。退款之前批准精确样本紧急停止边界，以及退款后 ACTIVE 租约/权益/月租计划的既有暂停/正常处置安排，不虚写订单结束。此资格记录不等于退款批准，更不是主线付款前置。
- [ ] **3. 读取主线独立付款结果。** 原付款应由其既有流程按唯一 build proof、实际账单/客户/金额/商户/窗口独立批准完成；无原单就等待，不由本计划创建付款。按 RF1 获批来源取得平台付款/核销事实；在商户退款管理以商户订单号或微信支付订单号读取原单，关联实际 `transaction_id/out_trade_no` 与 Portal `paymentOrderNo`。不把 bill items 当核销明细，不假定 Portal 返回微信交易号，也不预填未来 ID。
- [ ] **4. 原支付完成后重新核验。** 使用 RF1 已核验的既有权限和精确数据来源，比对平台到账/逐笔核销与商户原单的真实支付金额、CNY、同商户/付款方、无优惠/分账；若已批准来源不能提供实际关联即停止，不以金额/时间猜配，也不补查询 API。读取该原单全部退款记录，确保成功/在途/未知均为零。冻结其他退款操作者对精确原单的并发处理，证明独占责任窗口；不冻结普通客户交易。
- [ ] **5. 申请独立退款批准。** 绑定实际原单、平台分摊清单、一个操作记录 ID、R=P、单次/累计上限、执行人/第二人、窗口和查询/财务跟进安排；财务方法与原单性质一致。批准不引用未来微信退款号，实际生成后追加。如果迟到批准、撤回批准或输入变化，重新核验并批准，不继续 RF4。

## Task RF4：人工一次提交、同单查询及 UNKNOWN

**Files:** Modify validation 索引；私有原始记录追加而非覆盖。**Consumes:** RF3 独立退款批准与持续有效的权限。**Produces:** 提交/受理、渠道结果各自记录，不自动生成平台退款记录。

- [ ] **1. 双人提交前比对。** 查最新原单/全部退款列表，再核对批准和排他责任。把人工记录置为占用待单次提交；如果 UI 能指定单号，按批准的实际页面能力冻结该值；不能指定时不假定服务端幂等，只记录本地操作 ID。
- [ ] **2. 由唯一人单次提交。** 只在官方商户单笔详情对已批准原单输入 R=P 和原路方式并确认一次；不提供脚本、批量命令或绕开操作密码的方法。记录实际响应、生成的商户/微信退款号与时间；任何超时立即 UNKNOWN，禁止补点。
- [ ] **3. 独立结果查询。** 复核人使用自己的获准会话查看同一退款单及原单绑定，核对金额、最终状态、成功时间、原路去向；不能仅复核执行人截屏。未生成 ID 则查询原交易退款列表；无法定位单笔即停并人工升级。不能自行调用未实现的 provider API。
- [ ] **4. 处理延迟及重复。** PROCESSING/UNKNOWN 仅查询，不新增申请；观察重复则追加来源并关联同单，不重复记账。超过已批准时间窗停止本轮写操作，申请后续只读跟进权限；真实供应商可能跨日完成，不能在窗口结束时改判成功。
- [ ] **5. 退出或交 RF5。** 渠道 SUCCESS 且原路、金额一致才交 RF5；未成功/未知只停止该退款路线新写。路由外溢、错误原单/金额、重复资金动作等实际事故按既有预批准主线安全停止处理，恢复另批；不得把普通待对账升级成主线阻断。实际退款不能靠恢复 Staging 撤销。

RF4 UNKNOWN 没有“自动重跑此 task”的入口；新的程序版本、执行人或浏览器会话也不能重置已提交记录。

## Task RF5：成功后的财务对账与限域结论

**Files:** Modify validation 索引；既有私有财务档案保存真实凭证。**Consumes:** RF4 成功事实、既有财务操作批准、实际账单。**Produces:** 人工财务闭环及其证据，不是平台自动退款通过。

- [ ] **1. 只读保留平台原付款事实。** 获取本次原单 PaymentRecord/核销/账单的前后观察；保持历史到账与核销不被退款伪造撤销。不调用人工保证金退款或改库，不声称平台净额自动归零。
- [ ] **2. 财务人员实际处理。** 在独立财务批准下按 RF1 的既有方法完成本笔退款凭证；核对商户/原单/退款号、分金额、费用及日期。没有适用方法或需另改业务义务时，不用差异表代替，保留财务未通过并停止该退款路线新操作；不单因财务收尾未完成阻断主线，实际资金安全事故仍按既有门槛处理。
- [ ] **3. 日终资料生成后核对。** 以实际退款查询成功与原路证据、交易账单/资金账单的目标行和财务凭证逐笔核对。元/分换算精确、手续费与跨日清算分列。仅有商户扣款记录时仍未证明用户退款成功；资料未出保持待对账，后续只读获取另按窗口批准。
- [ ] **4. 独立保管读回。** 财务复核人从既有私有保管位置重新读取原件并核对摘要、来源、引用、权限与保留策略；所有失败/UNKNOWN 历史保留，实际财务凭证不能只用公开 Git 文档替代。不建立新的 cloud/Runner custody 或声称已有新 proof Schema。
- [ ] **5. 形成限定结论。** 每原单分别记录“渠道退款成功/未成功”“财务核对完成/未完成”。仅两者全部满足才记“商户人工退款及人工核对通过”；未执行/缺件不补写通过或 N/A，也不阻断 Stage 1 实施、候选提升或主线签字。平台自动退款/状态同步/保证金能力仍未验证；B6、合同、剩余押金义务和主线支付事实按其自身证据判定，提交索引前主 agent 复核。

RF1–RF5 的每次索引提交只暂存 `docs/acceptance/2026-09-07-stage1-controlled-test-refund-validation.md`，先运行该文件 Prettier、`git diff --check`、暂存后 `git diff --cached --check` 并核对唯一文件，再提交；不把受控原件、运行时日志或其他线程成果混入。实际商户/财务事件按真实发生时间追加，不以 Git 提交时间替代渠道时间。

## 2. 覆盖与复审清单

| 用户要求/设计约束                          | 计划落点                                          |
| ------------------------------------------ | ------------------------------------------------- |
| 先评估商户侧最小路径，不默认新退款系统     | 方案 §2/3/9；RF1 不适用即停                       |
| 权威分离、原单/金额/申请/成功              | 方案 §4–6；RF3–RF5                                |
| 重复、UNKNOWN、查询恢复、成功后账务        | RF2 反例、RF4 同单查询、RF5 实际凭证              |
| 退款独立非主线前置、逐操作批准、无未来身份 | Global Constraints、RF1/RF3/RF5；不预填未来退款号 |
| 完整影响、模型/迁移/权限显式边界           | 方案 §7/9、计划 §1；A 全部为 0，B 无施工额度      |
| 通知/候选/隔离独立阻断，B3/Task30 保持     | Global Constraints、RF0/RF3/RF5                   |

本轮仅做五文件文档/登记同步与上述精确离线检查，执行者交本地报告后停，由主 agent 独立审查并串行提交。**不运行产品测试、数据库、商户/总预检或真实退款，不触 stash、不填写 RF1–RF5 已完成，不提前声称并行业务/发布工作通过。** RF0 文档同步不等于总预检实现已改，后续 RF1 访问及所有资金/配置操作仍待独立批准。
