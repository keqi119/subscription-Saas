# Stage 1 R4 指定 Staging 签字 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在同一可信候选通过最终双链后，恢复本系统既有 Staging，以真实 A/B 新单、成熟正常到期样本、两次有效维护及恢复演练形成可独立复核的主线签字证据。

**Architecture:** 本计划消费现有 Runbook、外部适用登记、受控发布契约和真实业务服务；不新增验收后门或第二套身份权威。先定位并恢复用户已说明停止的本系统 Docker 环境，再按操作单提升固定三镜像候选，最后通过 Admin/Portal、渠道原件及独立读回核验业务事实。环境恢复、候选提升、真实供应商操作与验收签字是分别有门槛的工作。

**Tech Stack:** Docker Compose、既有 BT/Nginx、PostgreSQL 17、Prisma、NestJS API、Next.js Admin/Portal、可信 Runner、法大大生产通道、微信支付 API v3/JSAPI、微信公众号模板通知。

**Spec:** [获批审计收口计划任务 13](2026-09-22-stage1-audit-driven-closure-plan.md)、[主线最小受控发布决策](../specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md)、[主线实施路线图](2026-09-06-stage1-mainline-minimal-release-implementation-plan.md)。执行时同时读取 [Staging 验收 Runbook](../../runbooks/stage1-golden-path-production-acceptance.zh-CN.md)、[三阶段退车 Runbook](../../runbooks/stage1-return-three-stage-rollout.zh-CN.md)及 `release/contracts/external-validation-applicability.v1.json`。

## Global Constraints

- 本次获准产物仅为本计划；不提交、不连接服务器/数据库、不运行 Docker、不读取秘密、不调用供应商、不改运行配置。本次没有实际 R4 验收结果，所有下列执行项保持未勾选。
- 用户已说明本系统服务器 Docker 当前停止。所有线上联调前必须先完成任务 2 的对应环境恢复与核验；不把其他系统替换成本系统，不删除卷，不默认启动整个宿主的全部服务。
- 当前产品为 `SUBSCRIPTION`；保留历史能力，不开放 `RENT_TO_OWN` 新业务，不变更 Schema、历史 migration、RBAC、Journey 状态机或支付/退款接口。
- 金额均为整数分。真实签署、付款、通知只用逐操作批准的专用测试客户、签署人、payer 和非运营车辆；生产业务数据库、普通客户及运营车辆不在范围内。
- 始终保持 `AUTO_DEBIT_ENABLED=false`、`PAYMENT_MANDATE_PROVIDER=disabled`、`PAYMENT_MANDATE_MOCK_ENABLED=false`；收款模式为 `ACTIVE_PAYMENT_ONLY`，退役代扣 `PENDING/PROCESSING` 数必须为 0。
- 候选操作批准只绑定一个已验真的 `buildProofDigest`；完整 source、API/Web/Runner platform digest、migration catalog 和 repository contract identity 从该 `build-proof.v1` 派生。更换任何候选字节后，旧候选的测试、批准与签字不可移用。
- 实际 Staging 写入、备份/恢复、部署、必要 DDL/DML、设置变更和供应商操作须具有相应精确操作批准；本计划不能替代这些操作单。执行人、独立复核人、回滚负责人按 Runbook 分离。
- 退款是独立人工资金收尾，不是主线实施、候选提升或签字前置；未执行仍未通过，不记 `N/A`。不开发退款 API、不配置退款 notify、不修改支付 callback，不推导平台余额自动冲回。
- 原执行索引只追加前向记录；历史证据、失败/中断、冻结 Task 6/29R/30 与 I 系列不改判、不重启。不将 R4 主线签字称为生产发布、完整 S1 或 Task30 完成。

## Review Focus

1. 停机对象或卷归属不明、宿主有其他系统：停止恢复动作，保留原数据与其他服务；任务 2 用错误归属操作单桌面反例核验。
2. 三镜像/source/API base 混用或 callback 有双消费者：不进入真实实名、签署、付款或通知；任务 1、3 用跨候选和双消费者反例核验。
3. B 线复用 A 线、重复商业确认或只凭签署/付款页面成功：不计主线通过；任务 4 用独立对象关联及权威原件核验。
4. 只改到期日、只有 `settledAt` 或两次空维护：不计成熟结束和维护通过；任务 5、6 逐对象核验真实服务来源与结果。
5. DB 恢复后把外部签署/付款视为撤销，或遇 `UNKNOWN` 换新幂等身份重试：停止副作用并调查原交易；任务 7 用恢复后的渠道事实对账和桌面反例核验。

## 文件归属、来源与交付边界

当前只新增本文件。未来获批执行才创建 `docs/acceptance/2026-09-22-stage1-r4-staging-signoff-validation.md`，并在 `docs/acceptance/2026-09-06-stage1-mainline-execution-index.md` 追加 R4 前向引用。前者记录非秘密事实与原件引用，不另建身份/适用性注册表；供应商 payload、PII、凭据、签署链接和资金原件留在批准的受控存储，公开报告仅放脱敏关联、digest、保管与独立读回引用。

文档隔离基线为 CLEAN `4bd977d277349122fee12da5528b40e1da12ec26`。业务与 Runbook 另读取 ORIGINAL `18c65fe3` 的现有内容：F5 已在 `c99a2ce9` 修复，Runbook 前向对齐在 `1140a705`，任务 1–8 的本地关闭记录在原索引。CLEAN 尚未包含全部原分支事实；最终集成必须保留两边精确提交，不能以 CLEAN 整树覆盖原索引、F5 或 Runbook。本文件不重复安排已完成修复，也不把本地测试当作最终候选或外部验收。

下表中的 `scripts/release/launch-manual-stage1.mjs`、`release/contracts/manual-stage1-profile.v2.json` 是 R2 计划定义的后继入口/H1 输入，本 DOC-ONLY 基线尚不存在；R3 计划也由独立任务交付。本计划只引用其已定义职责与路径，不声称已能执行。最终候选须消费对应 owner 完成并获批的原件，R4 不创建这些文件或自行补 profile。

| 权威来源                                                                                                                                                                                                                        | 本计划消费的内容                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.staging.images.example.yml`                                                                                                                                                                                     | 既有镜像部署结构、服务、卷、端口、健康检查及 worker 默认值；示例不是当前服务器事实                                                      |
| `docs/staging-deployment-runbook.md`、`docs/image-registry-deployment.md`、`nginx/staging-subauto.example.conf`                                                                                                                 | 历史定位、BT/Nginx 代理及预构建镜像机制；不继承旧全局启动/seed 权限                                                                     |
| `docs/backup-restore.md`、`scripts/backup-postgres.example.sh`、`scripts/restore-postgres.example.sh`                                                                                                                           | dump/restore 技术来源；示例含目标环境变量和破坏性 restore，不能直接执行                                                                 |
| `package.json`、`scripts/stage1-golden-path-production-preflight.mjs`                                                                                                                                                           | 总预检准确 alias、实际 blocker 与健康检查边界；最终候选必须含 F5 修复                                                                   |
| `docs/superpowers/plans/2026-09-06-stage1-r2-runner-migrate-verify-plan.md`、`release/contracts/manual-stage1-profile.v2.json`                                                                                                  | R2 唯一手工入口为 `scripts/release/launch-manual-stage1.mjs` 的 `--operation-ref`，只消费固定档案记录；其 H3 目标授权不自动覆盖 Staging |
| `scripts/fadada-production-test-signer-realname.mjs`、`scripts/fadada-production-upload-signurl-smoke.mjs`                                                                                                                      | 两个仅预检模式；`prepare/run/signurl-only` 是另行批准的真实外部动作                                                                     |
| `apps/api/src/main.ts`、各 controller、`apps/web/src/lib/api.ts`、`apps/web/src/lib/portal-api.ts`                                                                                                                              | API 全局 `/api` 前缀、浏览器实际 API base 和已有接口；下文 API 路径均含该前缀                                                           |
| `apps/api/src/subscription-journey/subscription-journey.controller.ts`、`apps/web/src/components/subscription-journey/application-journey-actions.tsx`、`apps/web/src/components/order-workspace/subscription-journey-card.tsx` | 两类人工决定、version/manifest 绑定及可用动作                                                                                           |
| `apps/api/src/subscription-change/subscription-expiry.service.ts`、`apps/api/src/subscription-change/subscription-change-job.service.ts`                                                                                        | `RENEWAL_EXPIRY_PROCESS` → `expireSegment()` 的真实到期入口；不是手改日期接口                                                           |
| `apps/api/src/subscription-closure/subscription-closure.controller.ts`、`apps/api/src/subscription-closure/subscription-closure.service.ts`、`apps/api/src/subscription-closure/subscription-return-governance.service.ts`      | 实物接收、检查、定价/结算、库存释放和 `completeOperations()` 权威事实                                                                   |
| `apps/api/src/billing-automation/billing-automation.worker.ts`、`apps/api/src/billing-automation/billing-maintenance-evidence.service.ts`、`apps/api/src/billing-automation/billing-maintenance-evidence.types.ts`              | 两轮真实维护、来源绑定和数据库时间；首两轮事实不可任选替换                                                                              |
| `apps/release-runner/src/commands/stage1-billing-maintenance-evidence.mjs`、`release/contracts/command-contracts/stage1.billing-maintenance.evidence.v1.json`、`scripts/billing-maintenance-cycle-evidence-core.mjs`            | 既有只读维护证据 collector/契约；命令存在不证明最终 Runner runtime 已接通                                                               |

不预先修改以上生产/部署文件。若精确环境需要改变 Compose/config，先在操作单列当前路径、现值摘要、最小 diff、目标与独立 readback，取得该变更批准；若发现产品或 Runner 接口缺口，停止对应步骤并交回所属 B/R 任务，不在 R4 临时补 SQL、API、权限、fixture 或后门。

## 任务 1：冻结最终候选与非秘密输入清单

**Files:** 读取原执行索引、审计任务 11–13、R2 计划与将经评审的 `docs/superpowers/plans/2026-09-22-stage1-r3-final-image-dual-chain-plan.md`；未来结果写入上述 R4 validation 报告。

**Interfaces:** 消费最终可信 `build-proof.v1`、R2.4 normal/apply-interrupted 的独立原件与 R3 同候选完整双链/readiness；产出唯一候选引用、缺项清单和可供批准的操作单。

- [ ] 核验最终 source 已包含原分支业务修复、F5 和本次 R1/R2 精确提交，记录可信构建原件与独立验真结果。不要以 `4bd977d2`、`18c65fe3` 或任何本地 HEAD 自动充当最终候选。
- [ ] 读回 R2.4 两场景各自 H3-A/H3-B 及最终 Runner 实测；读回 R3 完整适用 fresh/snapshot/readiness 的同候选结果。每套 `collected=selected=executed=passed>0`，fail/skip/filter/cancel/todo 均为 0；历史五套 fresh、离线 double 或其他 source 不能补齐。
- [ ] 对照下表收集已有材料的非秘密引用。尚未提供就记录 `INPUT_UNAVAILABLE`、责任人和所阻断步骤；不搜索 `.env`、秘密存储、服务器或个人文件，不猜 host、客户/订单 ID、金额、时间或备份。

| 必需输入             | 只记录的非秘密事实                                                                                        | 缺失时阻断         |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------ |
| 当前服务器及停止状态 | 已批准 host/资产引用、系统所有者、Docker daemon 或仅容器停止的确认、其他共存系统边界                      | 环境恢复           |
| 既有 Compose 项目    | 实际项目名、工作目录、Compose/config 文件路径与摘要、容器/卷/网络完整 ID 及 labels、当前镜像 digest       | 任何启动/重建      |
| Staging 专属资源     | DB 名/OID/system identifier、PG/TLS/角色身份；实际 job/outbox 消费者、上传卷或对象存储 bucket/prefix 身份 | 候选提升与业务写入 |
| 三类 callback/notify | 实名、签署、支付各自精确 HTTPS 路由与唯一消费者、return 目标、供应商侧现状读回、独立复核引用              | 真实外部调用       |
| 账户与职责           | Admin/Portal/现场执行的授权角色，执行人/独立复核人/回滚负责人、财务核对人和批准引用                       | 对应 UI/外部动作   |
| 专用资产             | A/B 各自新申请资格、客户与签署人受控关联、payer 授权、非运营实物车辆、激活套餐/合同模板版本               | A/B 建单与渠道操作 |
| 成熟样本             | 既有合法来源、完整服务链、真实合同期间和到期窗口、已清账单/收款/实物返还安排                              | 正常到期签字       |
| 五模板与收件人       | 每模板 ID 的受控引用/字段版本、精确测试 OpenID 授权、场景与预计次数                                       | 通知 smoke/启用    |
| 操作窗口与额度       | 时区/起止时间、逐操作批准、单次和累计付款上限（整数分）、应付对象、紧急停止目标                           | 开窗和付款         |
| 备份与恢复           | 备份范围/时间、加密归档 digest、ACL/保管/可恢复性、精确演练目标及停写范围、RPO/RTO 上限                   | 恢复演练与提升     |
| 两轮维护             | 各轮预计 due 对象、自然到达时点、真实业务来源、只读查询/collector 权限、结果读回来源                      | 启用维护 evidence  |

- [ ] 将权限逐项拆为环境定位/恢复、备份/演练、固定候选部署、必要 migration/config、实名/签署/上传/链接、五模板查询/smoke/通知开启、真实 JSAPI 付款、紧急停止；各自绑定对象、窗口、执行/复核人与 `buildProofDigest`。某项已获精确批准则直接消费，不重复索要同一权限。
- [ ] 桌面核验跨候选反例：任一镜像来自另一 build proof 或双链缺一套时，操作单结论必须为 `STOP`。保存复核结论，不伪造一场已执行的失败测试。

**出口：** 候选可独立验真；全部执行所需输入已实填在受控操作单，否则只交付缺项清单。计划批准不等于这些事实已存在。

## 任务 2：定位并恢复用户已停止的本系统 Staging

**Files:** 读取部署/镜像/备份 Runbook、Compose 示例和代理示例；未来只在批准的实际部署路径实施已审查 diff，结果写 R4 报告。

**Interfaces:** 消费任务 1 的 host/project/resource 操作单；产出原环境数据仍完整、写入保持关闭、既有服务可核验的恢复记录。此任务先于任何线上联调。

- [ ] 在环境定位批准下，读取既有运维资产记录，再核实际 Docker/Compose labels、容器状态、挂载和已存在数据卷。历史文档中的域名/IP、`subauto-staging`、`/opt/subscription-saas` 只能定位，不能自动当本次目标；若 daemon 停止且重新开启会自动启动其他系统，先取得覆盖实际影响的恢复方案，不执行全局启动。
- [ ] 对每个实际服务核对 project、容器 ID、镜像 digest、mount source/target 和卷归属。无法证明本系统原数据卷存在时 `STOP`，不得让 Compose 自动创建空卷冒充恢复。记录暂停前/恢复前数据与服务基线。
- [ ] 复核关闭状态：Journey enrollment/worker 关闭、allowlist 为空；实际账单、订阅任务和通知等有副作用消费者均按精确停写操作单保持关闭。Compose 示例的 `BILLING_AUTOMATION_WORKER_ENABLED` 默认 `true`，不能原样启动 API 后才补关；若需改变配置，先审查批准该最小 diff。
- [ ] 按已绑定的现有项目恢复 PostgreSQL 服务，保留原挂载；确认现有 `pg_isready` health，再用获批只读身份核真实 DB/PG17/TLS/角色与数据来源。`pg_isready` 仅证明可连接，不能证明 migration 或目标身份正确。
- [ ] 在旧镜像与旧 Schema 兼容且写入已抑制的条件下恢复本系统 API/Web；若不能保证，保持 API/Web 停止，转任务 3 按批准的 migration/固定候选顺序恢复，不强行启动旧程序。BT/Nginx 已占 80/443 时沿用既有代理，不停其他系统代理、不启第二套 Caddy。
- [ ] 核 API `/api/health`、Web 根页面及 Admin/Portal 登录页面可达，读回代理实际 upstream 和浏览器实际 API 请求目标。示例 API/Web 映射为 `127.0.0.1:3101/3100`，必须比对实际配置，不能猜端口。API health 是 liveness，不是 DB readiness；Web health 的 `<500` 也不是业务通过。
- [ ] 桌面核验错误项目/缺卷/其他系统容器反例，确认命令不会扩大到目标外。独立复核人签认恢复后的精确服务、数据身份和关闭的消费者；未签认不进入线上联调。

未来命令只能由执行者在批准操作单中展开下列**来源与子命令**，绑定实际参数后再审查；本计划不提供含猜测 host/path 的可复制远程命令。

| 操作            | 仓库命令来源                                                                                          | 执行限制                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 定位/状态       | 部署 Runbook 的 `docker compose` 项目/文件选择方式，`ps`；Docker inspect 的精确 ID/labels/mounts 读回 | 不输出环境变量或完整秘密配置；不用全机容器列表批量启停                                                                                        |
| 恢复 DB/API/Web | 已存在 Compose 的 `start`，或经 diff 评审的 `up -d` 指定服务                                          | 必须显式实际 project、Compose/env 文件与目标服务；需要重建则另审挂载与配置，禁止全局 `up`                                                     |
| 候选拉取/提升   | 镜像部署 Runbook 的 `pull` 与 `up -d` 指定服务                                                        | 仅任务 3 固定 API/Web/Runner digest；不在服务器 build，不用浮动 tag；Runner 为 `release-operations` profile 下的一次性操作，不是常驻 Web 服务 |
| 数据备份/恢复   | `pg_dump --format=custom` / `pg_restore` 机制来自备份 Runbook 与 example scripts                      | 只执行经过目标绑定、秘密保护和破坏性审查的具体操作单；不直接运行依赖 ambient `DATABASE_URL` 的示例                                            |

禁止 `down -v`、卷删除/prune、`prisma migrate reset`、`db push`、旧全局 seed/`seed:scenario`、从 API 镜像执行 Prisma 或对未知目标 `pg_restore --clean`。示例中的这些旧步骤不是本任务授权。

**出口：** 当前本系统环境真实恢复或在明确安全停止点等待候选恢复；只有最终 API/Web/DB 健康与身份核验完成，才能进入任务 4 的联调。

## 任务 3：备份演练、提升候选与打开受控窗口

**Files:** 消费任务 1/2 原件、备份 Runbook、当前验收 Runbook、外部适用登记；未来结果写 R4 报告。

**Interfaces:** 消费 R3 同候选双链 PASS 和精确操作单；产出备份恢复证明、三镜像实际读回、资源/消费者隔离与允许进入业务窗口的结论。

- [ ] 在任何候选 migration/数据写入前，完成批准范围的停写和 DB/上传文件/对象版本一致性备份。记录源 DB 身份、catalog、候选关系、开始/结束时间、归档 digest/ACL、保留期和独立读取结果；备份 metadata 不是数据备份。
- [ ] 在批准的精确演练目标执行恢复，验证目标身份、Schema、应用读取、对象/附件可读和关键业务关联，计实际 RPO/RTO。没有现成合法演练目标时列缺项；不自行建新环境、不覆盖生产/其他系统、不借 R3 合法副本授权恢复 Staging。演练目标与待上线目标不同则分别记录身份，禁止混用报告。
- [ ] 在任务 1 的同候选双链和部署操作批准下，拉取固定 API/Web/Runner platform digest。先核目标确实受可信 launcher/profile/operation 准入覆盖，才执行 `db.migrate.deploy@1`、`db.schema.verify@1` 的必要阶段，独立只读核 migration/catalog/Schema；API 镜像不带 Prisma，不从 API 容器补跑。若部署无需 DDL，依据实际 clean 结果记录，不制造空迁移成功。
- [ ] 核 Staging 迁移入口的可用性：R2 正式 CLI 是 `node` 执行 `scripts/release/launch-manual-stage1.mjs`，唯一选择参数 `--operation-ref` 消费固定档案中的非秘密 UUID；其固定 profile/H3 目标不是可由调用方替换的 Staging host。当前 R2 通过只证明该限定目标，不能改 profile、传 raw URL 或借 `pnpm prisma:migrate:deploy/status` 的旧 `.release-inputs` 路线绕过。没有已批准且适配此 Staging 的可信入口/目标登记时，登记具体接口缺口并停止 migration/提升，由 R owner 提交限域方案；本计划不虚构一条能执行的 Staging 命令。
- [ ] 启动本系统候选 API/Web，保持业务开关关闭。独立核运行容器 digest/source/build proof、API/Web 配置摘要、Web 构建内 API base 与浏览器实际请求、数据库 OID/system identifier/TLS/角色、job/outbox/存储身份和健康。仅检查 env 或镜像 tag 不够。
- [ ] 逐项读回三类目标及消费者：`POST /api/esign/callback/fadada/verify`（实名）、`POST /api/esign/callback/fadada`（签署）、`POST /api/payments/callback/wechat_pay`（支付）。同时核已批准 return URL；路由来源分别为 `apps/api/src/esign/esign.controller.ts` 和 `apps/api/src/payment/payment.controller.ts`。不得据代码路径猜公网地址；实际代理/供应商配置及交易关联须证明唯一 Staging 消费者。
- [ ] 若生产租户只允许全局 callback 且不能安全按本次专用交易分流，结论 `STOP`；不改写全局回调、不停普通客户消费者。桌面双消费者反例必须无法进入后续开关步骤。
- [ ] 在独立通知批准下，完成任务 6 的五模板映射/smoke 与通知启用门槛；实名、签署、付款批准不继承为通知批准。核紧急停止的 enrollment、worker、consumer 精确目标与可执行权限已在窗口内有效。
- [ ] 按 Runbook 已批准顺序设置精确 allowlist、Journey enabled、Journey worker enabled，重启批准的本系统服务并读 heartbeat。A/B 新申请尚未生成时，只能使用明确批准的专用 customer allowlist；生成后记录精确 application 关联，不能借通配解决先后依赖。
- [ ] 在候选环境运行 `pnpm stage1:golden-path:preflight`、`pnpm fadada:test-signer:preflight`、`pnpm fadada:upload-signurl:preflight` 并保存真实输出。总预检的 GET health 需要本窗口读取授权；两个法大大预检不调用 provider transport，要求文本 `preflight=passed` 且无 `blockers=`，exit 0 本身不够。最终候选应含 F5；无退款额度不阻断主线，其他 blocker 不豁免。

**出口：** 候选、备份/演练、资源、消费者、开关和实际预检全部可核；任一未知则不进行真实副作用操作。

## 任务 4：真实浏览器执行 A/B 两个新订单

**Files:** 读取 `apps/web/src/app/portal/catalog/[id]/page.tsx`、`apps/web/src/app/portal/applications/[id]/page.tsx`、`apps/web/src/app/applications/page.tsx`、`apps/web/src/app/applications/[id]/page.tsx`、`apps/web/src/app/orders/[id]/page.tsx` 及下表对应组件/controller；未来证据写 R4 报告。

**Interfaces:** 消费批准资产、同候选服务与开启的限定窗口；产出两条互不复用 Application/Journey/Order/Contract 的完整业务证据链。

- [ ] 按 A 后 B 顺序执行，分别建立脱敏关联表：source、application/customer/vehicle/plan、finalPlanRevision/hash、reservation、Journey/step、quote/order/contract、签署 task/归档摘要、bill/payment/write-off、handover/workOrder/manifest、Lease/BillingSchedule 和每步审计。只在对象真实生成后填写 ID。
- [ ] 使用真实授权角色浏览器逐步操作下表，保存当前候选的页面、时间、脱敏请求/响应关联、等待状态与可用动作；旧截图、mock provider、测试 fixture 和仅 curl 成功不能代替。

| 顺序与页面                                                                                 | 实际动作/已有接口                                                                                                                                                                   | 必须核验的事实                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A：`/portal/login` → `/portal/catalog` → `/portal/catalog/[id]`                            | 专用客户完成既有资料后，`POST /api/portal/self-service-applications/precheck`、`POST /api/portal/self-service-applications`；跳 `/portal/applications/[id]`                         | 新 `SELF_SERVICE` Application；意向套餐不是最终签署方案，尚无正式订单                                                                             |
| B：`/applications`                                                                         | “新建进件” → `POST /api/applications`，再“提交” → `POST /api/applications/:id/submit`                                                                                               | 新 `SALES_ASSISTED` Application，不能复用 A；客户是已批准 Portal 可访问的本人                                                                     |
| 两线：`/applications/[id]`                                                                 | 按现有资料、信用/押金、套餐和车辆审核页完成审核；“提交最终方案并软锁车辆”调用 `POST /api/subscription-journeys/:id/final-plan-decision`                                             | `version`、具体 `finalPeriodMonths/finalSubscriptionPlanId/finalVehicleId`；每 Journey 仅一次 `FINAL_PLAN_DECISION`，审批前等待不能被手工建单绕过 |
| 两线：`/portal/applications/[id]`                                                          | 客户核对当前方案，“确认最终方案” → `POST /api/portal/applications/:id/final-plan/confirm`                                                                                           | 当前 `finalPlanRevision` 对应商业快照仅确认一次；确认后权威 reservation/quote/Order/Contract 自动产生，无第三次车辆分配人工决定                   |
| 两线：`/portal/contracts/[id]`                                                             | 必要实名走 `POST /api/portal/esign-onboarding/real-name`；“去签署” → `POST /api/portal/contracts/:id/signing/start`，转真实供应商 `signUrl`                                         | 实名/签署逐操作批准、真实客户签署与平台盖章、callback/必要查询及归档一致；`/portal/contracts/[id]/sign` 的 mock 路线不算                          |
| 两线：合同页 → `/portal/payment-orders/[id]`                                               | `GET /api/portal/payment/payable-bills?orderId=...`；`POST /api/portal/payment-orders` 后 `POST /api/portal/payment-orders/:id/pay`，真实微信浏览器 JSAPI                           | 合同归档后先 `INITIAL_BILLING`，生成正常押金/租金账单才付款；精确 billIds/payer/整数分在批准内；不把微信 UI 返回当核销                            |
| 两线：`/orders/[id]` 交接 → `/field/handover/tasks/[id]` → `/portal/handover-reviews/[id]` | 现场按真实工单采集 facts/证据并提交，客户完成既有交接确认/真实签署；接口来自 `apps/web/src/lib/field-handover-api.ts` 与 `apps/api/src/portal/portal-handover-review.controller.ts` | 实物、里程、钥匙/文件及受管附件；精确 handover evidence manifest 与签署归档一致；不得用任意照片 URL/手改完成状态                                  |
| 两线：`/orders/[id]` “订阅 Golden Path”                                                    | “通过证据” → `POST /api/subscription-journeys/:id/delivery-evidence-decision`                                                                                                       | `decision=APPROVED` 与当前 `version/workOrderId/manifestHash` 一致；每 Journey 仅一次 `DELIVERY_EVIDENCE_DECISION`                                |
| 两线：订单/门户及账单页                                                                    | 独立读回 Journey、订单、车辆、Lease、BillingSchedule、审计及 jobs                                                                                                                   | Journey `COMPLETED`；订单/Lease 权威激活、车辆实际占用、唯一日程与起租事实一致，不能只看一个 UI 状态                                              |

- [ ] 每次真实实名/上传/链接/签署或付款前复核适用批准及窗口，不把一次 route 调用批准扩大成整个租户操作。签署归档通过服务端保存的原始文件 digest 和受控预览/下载复核；`GET /api/portal/contracts/:id/signed-document/preview` 是现有入口，不以临时签署链接代替归档。
- [ ] 对每笔实际付款独立核商户原单（`out_trade_no`/`paymentOrderNo`、微信 `transaction_id`）、渠道成功与金额，再核平台 `PaymentOrder`、`PaymentRecord`、`PaymentWriteOff`、分摊及应收余额。现有应用没有可据此宣称的主动微信订单查询 API；商户控制台读取也须获批。窗口前必须确定各对象的既有只读证据来源，缺少核销读回就停止，不能新开 SQL/RBAC。
- [ ] 统计每条 Journey 的两类内部人工决定各 1、商业 final-plan 确认 1，步骤顺序一致。资料/信用审核是业务审核；交接证据确认、签署及将来退车结算响应不是新增商业方案确认；不把这些混为“只允许两次所有人工点击”。
- [ ] 回读通知的五场景真实记录与目标，不因合同/付款成功替通知报 PASS。核 Admin/Portal 无代扣 mutation UI/路线，权限隐藏与后端拒绝符合现有角色；不使用管理员越权来补缺失的客户动作。
- [ ] 对 A/B 复用、重复确认和“仅页面成功”的 Review Focus 逐项审查关联表，结论必须能指出各自真实对象/唯一决定/渠道与平台原件。任何 `UNKNOWN` 按任务 7 处置；不为完成样本重建新单覆盖原失败。

**出口：** A/B 两条真实主线各自完成、原件完整且独立复核；若正常商业变更确实要求重新报价，保留原事实并另定恢复验收，不将其伪记为本次“一次确认”成功样本。

## 任务 5：完整成熟样本的无争议正常到期与结束

**Files:** 消费到期/closure 服务、`apps/web/src/components/subscription-closure/return-evidence-stage.tsx`、`return-pricing-stage.tsx`、`return-settlement-stage.tsx`、`portal-return-settlement-panel.tsx`、`apps/web/src/lib/subscription-closure-api.ts`、`apps/api/src/portal/portal-billing.controller.ts`；未来写 R4 报告。

**Interfaces:** 消费独立成熟样本完整来源与合法实物/签署/财务安排；产出正常到期、实物接收、无争议结算和权威结束的完整事实。

- [ ] 准入第三个独立成熟样本：从真实服务来源核 Application/最终方案、Order、有效 Contract/签署归档、`SubscriptionContractSegment` 的起止日期与条款、Lease、BillingSchedule、周期账单、历史真实收款/核销、交付 manifest、非运营实物车辆及租期结束事实。它不得用新建 A/B 改日期替代；没有自然成熟且来源完整的受控样本就 `INPUT_UNAVAILABLE`。
- [ ] 在到期新写入前核三阶段发布准入：读取现有 Runbook 的目标分类、归档合同/交付基线与结算 publication 权威检查结果，人工审查/隔离项清零，`subscription_closure_settlement_publication_check` 验证状态真实成立；再消费 `SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED=true` 的精确配置批准及读回。现有 `stage1:return-closure-backfill:*`、`stage1:return-closure-constraint:*` alias 只是来源，不能证明可信 runtime 已接通或取得 DML 权限；缺项交所属 R/B owner，禁止临时补历史事实。关闭开关也不能让已有受管事实退回旧 UI。
- [ ] 核真实数据库时间和到期任务资格，沿 `SubscriptionChangeJobService.handle()` 的 `RENEWAL_EXPIRY_PROCESS` 调用 `SubscriptionExpiryService.expireSegment()`；观察正常到期审计、segment `COMPLETED`、Order `PENDING_RETURN`、Lease `RETURN_DUE`、唯一正常 return/closure 关联。不手动调用私有服务、改时钟/表数据或造 job。
- [ ] Admin `/orders/[id]` 的退车证据阶段，通过 `POST /api/subscription-closures/:id/return-checklists` 保存现场清单，以 `.../:id/return-evidence/upload` 上传有来源的受管证据；逐项核车辆外/内观、钥匙、行驶证、随车物品、里程与交付基线。使用正常客户签署路线，不借拒签/缺席例外缩短验收。
- [ ] 客户 `/portal/orders/[id]` 查看退车确认单，转真实供应商链接签署；`GET /api/portal/orders/:id/subscription-closure` 及签署归档预览证明当前 manifest 的签署/归档。该页面存在 mock-sign 分支，本验收禁止使用。
- [ ] Admin 按当前 checklist revision/hash 完成 `POST /api/subscription-closures/orders/:orderId/physical-receipt`，核物理控制时间、return、Lease 和关联 returnAssetWorkOrderId。实际执行检查工单，按真实状态/版本/证据与费用门槛关闭至 `CLOSED`；既有服务入口为 `POST /api/asset-operations/work-orders/:id/transition`（`apps/api/src/asset-operations/asset-operations.controller.ts`、`asset-operations.service.ts`），需既有 `ASSET_WORK_ORDER_MANAGE` 权限及独立批准的样本准备操作。当前未确认 Admin 有直接关闭此资产工单的按钮，不虚构页面；准备入口/权限未核实就列缺项，不能直接改表或只提交“已收车”。
- [ ] case 仍在 `RETURN_INSPECTION` 时，经 `POST /api/subscription-closures/:id/return-deltas` 对照已归档交付基线生成差异；有 `UNDETERMINED` 才通过 `.../:id/return-deltas/confirm` 逐项确认责任，回读当前 delta revision。确认真实检查工单已 `CLOSED`、currentChecklist/currentDelta 存在且无未判责任，再在 Admin 点击“确认车况检查完成”（`.../:id/inspection`）。当前 UI 该调用的 `evidence=[]`，依赖上述受管事实；它将 case 推进至 `PENDING_SETTLEMENT`，之后不能再生成仅允许 `RETURN_INSPECTION` 的 delta。
- [ ] 在 `PENDING_SETTLEMENT` 先“生成结算草案”（`POST /api/subscription-closures/:id/settlements/propose`），取得当前 `PROPOSED` revision，再按真实合同条款预览/生成正式收费（`.../:id/pricing`，绑定该 settlementRevisionId）。若定价产生新 bill、使 proposal 的财务快照变化，必须沿真实 `proposeManagedSettlement()` 再形成后继 proposal，再以 `createPricing()` 将 successor charge line 绑定新 revision、复用原 billId，最后 `.../:id/settlements/finalize`；不得改旧 proposal hash 或重复造 bill。Task 8 的 `apps/api/test/subscription-expiry-return.integration.spec.ts` 已有该真实服务顺序，但其 fixture 不是浏览器证据。当前 UI 只明确提供首个草案与争议后的后继草案按钮；若实际样本需要定价后重新 propose 而候选 UI 未提供可执行入口，停止并交业务 owner 关闭该界面缺项，不能用直接 API 成功冒充完整浏览器路线。正常无争议样本不走提前解约、法催、豁免/坏账或人工异常定价分支。
- [ ] 客户 `/portal/orders/[id]` 通过 `POST /api/portal/orders/:id/subscription-closure/responses` 对当前 settlementRevisionId/resultHash 作 `ACCEPTED` 响应；如有真实应付，沿既有主动 JSAPI、回调及核销链清偿。不要把这次结束结算响应称为重复的开单商业确认。
- [ ] 在 case 仍为 `PENDING_SETTLEMENT`、当前 FINALIZED 方案及客户响应/真实清偿事实已核验、尚未 completeOperations 时，先点击“固化并导出证据包”（`POST /api/subscription-closures/:id/evidence-packages`），核原始归档文件 digest、下载和受控保存，记录包生成时点；不以导出时临时重算代替原件 digest。`subscription-closure.projection.ts` 只在该待结算阶段投影导出动作，不能把点击安排到运营完成之后。
- [ ] 主验收选择当前运营完成路线：保持当前结算 `FINALIZED`，客户响应绑定其 revision/hash，独立核真实应收余额、支付/核销、deposit/结算事实且无未决争议；按实际车况与可用动作先“释放车辆库存”（`POST /api/subscription-closures/:id/inventory-release`），再“完成订单运营闭环”（`.../:id/operational-completion`）。回读 current FINALIZED revision、operationalCompletedAt 与完成审计。此路线不先调用“核验账单已清并完成财务结算”/`settlements/settle`：该旧路径已经推进 case/order/contract 终态，后续 release/complete UI 只在 `PENDING_SETTLEMENT` 准入，complete 对已终态也只返回 replay，不能声称三按钮串行执行。合法历史 `SETTLED` 仅按既有兼容规则读回，不改旧事实；`settledAt` 不是到账凭证，退款状态独立登记。
- [ ] 独立读回 closure、Order、Contract 正常 `COMPLETED`，Lease 终态、return/period、BillingSchedule 后续停止/无到期漏单、当前车辆库存限制和实际状态均一致；解除订单占用不自动证明车辆无条件可售。该终态读回与完成前生成的证据包是两个不同时点的事实，分别记录时间/原件，不把前包说成含完成后的终态。当前终态 UI 不提供 `EXPORT_EVIDENCE_PACKAGE`；若签字要求包含终态的最终包，先将该 UI 入口列缺项/STOP 交业务 owner，不调用直接 API 冒充浏览器导出。
- [ ] 对只有改日期、只有 `settledAt`、有未决责任/账款的输入作证据复核，保持未通过。任何业务失败保留原 case/revision/idempotency 关联，不能直接改 Journey/closure 状态绕过。

**出口：** 第三样本来源、自然成熟、实物归还、结算和权威结束全部闭合；争议/资金不明则该主线样本不签字。

## 任务 6：五模板及两轮有 due 对象的真实维护

**Files:** 消费通知 Runbook、`apps/api/src/billing-automation/billing-automation.controller.ts`、维护 worker/service/types、维护 command contract 与 collector；未来写 R4 报告。

**Interfaces:** 模板门槛先供任务 3 开窗，随后消费任务 4/5 的实际场景；维护消费真实业务日程，输出同 run 两轮不可变事实及每个 due 对象的结果。

| 模板变量                               | 场景与固定字段                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `WECHAT_TEMPLATE_APPLICATION_PROGRESS` | 申请受理：`character_string3,const4,const5,time6`；`const4=审核中`、`const5=车辆订阅申请` |
| `WECHAT_TEMPLATE_FINAL_PLAN_PENDING`   | 方案待确认：`character_string2,phrase5,car_number8,thing13,time9`                         |
| `WECHAT_TEMPLATE_CONTRACT_PENDING`     | 合同待签署：`character_string2,thing3,thing6,thing1`                                      |
| `WECHAT_TEMPLATE_PAYMENT_PENDING`      | 账单待付：`car_number1,thing2,amount4,amount7,time5`                                      |
| `WECHAT_TEMPLATE_HANDOVER_PENDING`     | 待取车：`character_string1,thing9,car_number5,thing11`                                    |

- [ ] 开窗前逐模板核映射/字段/行业模板版本，五场景不跨模板复用；需要官方列表读取和精确 OpenID smoke 时，各自消费独立批准。保存供应商受理结果、实际收件人可见结果、时间及业务关联；无回执能力时准确说明已证明层级，不把“入队”当“送达”。
- [ ] 在批准下设置 `NOTIFICATION_PROVIDER=wechat_official_account`、`NOTIFICATION_WECHAT_ENABLED=true` 并读回。任务 4/5 中核五场景实际触发及已有催收通知的真实结果；无到期催收对象时不能伪造催收通过，按批准样本安排正常业务事实或列缺项。
- [ ] 启用维护 evidence 前，为同一真实 run 的第 1、2 轮分别列出正常服务产生的 due schedules、到期时点、预期 job/source key 和下游账单/催收/结束结果。每轮必须 `dueCount>0`；既有对象因幂等而 `enqueuedCount=0` 时逐件给出既有 job 及完成结果，不用总数掩盖遗漏。不能只改 nextRunAt、日期、时钟或手工 seed 制造资格。
- [ ] 复核 worker 实际启动和周期：当前 `BillingAutomationWorker` 启动即可 poll，维护间隔 60 秒；`BillingMaintenanceEvidenceService` 同 run 只保存最先两条 `COMPLETED`（sequence 1/2），随后普通维护不会替换前两条。两轮自然 due 不能在批准窗口内成立时不启 evidence；不是随意睡两分钟就能通过。
- [ ] 在配置操作批准下绑定 `BILLING_MAINTENANCE_EVIDENCE_ENABLED`、`..._RUN_ID`（64 hex）、`..._RELEASE_SHA`（40 hex）、`..._IMAGE_DIGEST`（API digest）、`..._DATABASE_IDENTITY_SHA256`，来源均与候选/数据库独立身份一致；记录配置读回、启动和每轮数据库时间，不借 OS 时间补证。
- [ ] 两轮逐项读回 reconciliation 的 `eligibleCount/createdCount/existingCount/leaseActivationCount/blockedCount/blockerCodes`，enqueue 的 `dueCount/enqueuedCount`、前后 forbidden-domain counts/hash、实际 job 完成结果及业务对象。要求 `blockedCount=0`、无重复和遗漏、没有禁止域变动；两轮空跑或只报告 reconciliation 成功不通过。
- [ ] 使用既有 `GET /api/billing/automation/summary`、`/schedules`、`/jobs` 辅助浏览器/授权读回；`POST /api/billing/automation/reconcile` 只调用 reconcile，`/billing/collections` 的刷新也不是两轮维护证据。不要构造不存在的 HTTP `runMaintenance` 接口。
- [ ] 核最终 Runner 已接通 `stage1.billing-maintenance.evidence@1` 的 `collectBillingMaintenanceEvidence(context,input)`、真实只读 `queryBillingMaintenanceFacts`/custody 及独立 readback 后才运行批准 collector。仓库 alias `pnpm billing:maintenance:evidence` 当前指向 `scripts/release/trusted-launch-runner.mjs` 与 `.release-inputs/billing-maintenance-evidence.json`，它是接口来源，不是重启旧 full-RC 的权限；R2 仅 migrate/verify 不证明该命令已接通。缺适配交 R3/R2 owner，保持未通过。
- [ ] 若最初两轮已空跑、failed 或身份冲突，保留全部原件并记录失败；不得删除 facts 或换 runId 隐藏。另开 run 必须是明确登记的新操作，不能拼接两次 run 各一轮。复核空跑反例在最终签字表中仍被拒绝。

**出口：** 五模板真实结果与两轮有对象维护均可追到同候选、同目标、原始结果及独立读回。

## 任务 7：恢复处置演练、证据封存与最终签字

**Files:** 未来创建 R4 validation 报告，前向修改原 execution index；外部适用 JSON 的 `must-external-verify/must-human-verify` 是要求，不因完成一次运行而改成自创 PASS 枚举。

**Interfaces:** 消费任务 1–6 原件与独立复核；产出每项实际 PASS/FAIL/UNKNOWN/NOT_RUN、剩余阻断、恢复结论及角色签字。没有真实执行就不产生签字。

- [ ] 复核任务 3 的实际备份恢复演练，补齐健康、业务只读、附件/归档、权限和消费者关闭的恢复后验证。应用回退固定 digest 与 DB 恢复分别处理；Schema 不兼容旧镜像时不得直接降级。
- [ ] 做经批准的停止/恢复桌面演练：本次 enrollment 停止、精确 worker/consumer 暂停，独立观察不再产生新签署/付款/通知，再保管未完成 transaction/task/job 与审计。不得演练停生产消费者或其他系统；不为演练再制造真实扣款/重复签署。
- [ ] 对“支付成功后 DB 恢复到付款前”以及“签署已归档但 callback 未确认”两种情况逐条演练对账：外部付款、实名、签署、盖章、归档、通知不会被 DB restore 撤销。先按原商户订单/交易号、签署 task、原幂等身份查渠道与平台受控原件；不能换新 ID 盲重试、重发合同或重付。真实 restore 后仅按另行批准的业务恢复方法衔接，缺合法补偿路径就保留 `STOP/UNKNOWN`。
- [ ] 审核全部失败、中断和 `UNKNOWN`，给出可核终态或仍阻断的原因/责任人；不能只选最后一次成功。独立退款单列“未执行/处理中/渠道终态/财务对账”等实际状态；仅退款未完成不阻断主线，收款事实不成立或实际越界事故仍阻断。
- [ ] 按批准的关闭操作单移除本次精确 allowlist、关闭 enrollment/worker/通知等应关闭目标，读回无新增副作用；保留应用事实/原件，既有完成事实不靠删除客户、订单、卷或日志清理。需要继续运营的服务保持哪种状态由操作单明确，不按计划默认删除环境。
- [ ] 独立复核人逐项完成下表并签署实际日期、角色和批准/证据引用。执行人、独立复核人、业务/财务责任人和回滚负责人分别确认其负责事实；缺任一主线事实不得先签后补。

| 签字项         | 必须同时成立的条件                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 候选与环境     | 原分支修复/R2 正确集成；唯一可信 build proof；运行 API/Web/Runner/source/配置/API base 与同候选双链一致；原系统恢复、数据身份与资源隔离可核             |
| A/B 新单       | 两个新 Application、各自完整且同序 Journey；两类内部人工决定各一次、商业方案确认一次；真实签署/盖章/归档、主动 JSAPI/回调/核销、交付 manifest、权威激活 |
| 成熟正常结束   | 第三样本完整服务来源和自然成熟；实物接收/检查、责任与合同计价、无争议客户响应、真实财务事实、库存/订单/合同/Lease/期间终态及审计一致                    |
| 通知与维护     | 五模板与相应真实业务投递证据；同 run 两轮 `dueCount>0`、`blockedCount=0`，每个 due/enqueued/结果可核，无重复遗漏/禁止域变动                             |
| 恢复与安全收尾 | 备份实际可恢复、RPO/RTO 达标、恢复后验证；外部不可回滚事实与 UNKNOWN 已处置或仍明确阻断；窗口清理独立读回                                               |
| 证据保管       | source/命令/操作 ref/时间/exit-signal/目标、原件 digest/custody/readback、所有失败历史完整；无秘密/PII 泄露，审批与签字可追溯                           |

- [ ] 在原索引追加本次真实执行的单一入口，引用 R4 报告、同候选双链、浏览器/渠道、两轮维护、恢复与签字原件。用外部适用 ID 分别登记 `stage1.esign`、`stage1.active-payment`、`stage1.notification`、`stage1.admin`、`stage1.portal`、`stage1.normal-expiry` 的实际证据；`stage1.refund` 独立列项，不抹去旧 `NOT_RUN` 历史。
- [ ] 只在上述实际事实成立后登记“指定候选的 Stage 1 Staging 主线签字通过”；否则交付确切未完成项及下一操作门槛。该结论不扩展为生产发布、所有供应商能力、完整 S1 或 Task30 完成。

## 本次 DOC-ONLY 交付检查

- [ ] 确认仅新增本计划，链接/源码路径与路由有实际来源；未知 host/资产/金额/窗口/备份仍列非秘密缺项，没有虚构执行命令、对象或成功结果。
- [ ] 自审五项 Review Focus 在所属任务有可执行的复核方法；旧预检 F5、分支集成、两轮首事实及外部不可回滚边界没有被遗漏。
- [ ] 仅运行本 Markdown 的格式/差异检查并记录结果；不为文档任务执行 DB preflight、Prisma、测试、Docker 或网络。向主控交付未提交文档，由主控独立评审/集成后再处理未来操作批准。
