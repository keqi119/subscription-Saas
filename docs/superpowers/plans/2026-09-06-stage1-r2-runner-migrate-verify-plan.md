# Stage 1 R2 最终 Runner migrate/verify 竖切实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development，子 agent 按提交边界施工，主 agent 逐项审查；如用户改变模式才使用 superpowers:executing-plans。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 R1 人工授权接入最终 Runner 的两个既有数据库命令，实际证明权限隔离、迁移重算和只读核验；不启动完整 RC、Staging 或 Task 30。

**Architecture:** 保留旧可信启动路径不变，在固定 Runner entrypoint 内增加封闭的人工交接分支。复用现有 PostgreSQL connector、runtime adapter、migration/schema 函数；不以云 approval、预制测试 JSON 或 `verified:true` 代替 R1 的真实验证和会话消费。

**Tech Stack:** 现有最终 Runner Node 22/Prisma 7.8.0/psql 17，PostgreSQL 17 digest-pinned 合成 fresh 目标，Docker 原生固定参数启动，Node 流/子进程测试。无新依赖、数据库迁移或云服务。

**Spec:** [最小受控发布决策 §3、§5](../specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md)、[R1 计划](./2026-09-06-stage1-r1-manual-trust-and-authorization-plan.md)、[覆盖路线图](./2026-09-06-stage1-mainline-minimal-release-implementation-plan.md)、[P0/P1 实际索引](../../acceptance/2026-09-06-stage1-mainline-execution-index.md)。

## Global Constraints

- 状态：**2026-09-07 DOC-ONLY 共享证据/依赖修订待复审**。R1.1 已在 `a7dae491` 批准，R1.2 尚无代码；R2.0 已由 `5a16ca8a` 修正，不能把历史缺陷继续报成待改。本轮只改现有 R1/R2 两份计划，内部审查通过后由主控分别本地提交供用户复审，修订不因此成为已批准，不执行代码/Schema/测试修改、DB/Docker/网络、真实 key/profile/H1/H2/H3 或 Task 30。下列新增/移交范围是后续独立代码单元，不是本回合执行授权。
- P1 两个合成目标已经退役。没有可复用的 active record 或 credentials；不读取归档秘密，不访问 ambient DB URL，不以旧删除批准覆盖新目标创建/退役。
- R2.0 已交付；R2.1–R2.3 的代码/适配器测试不连接外部目标，依赖 `R1.1 → R1.1E → R1.2 → R1.3` 各自审查通过。R1.1E 先独立交付共享契约，R1.2 不等待/反向导入 R2 runtime。R2.4 真实运行还须 H1/H2/H3、独立 expected-schema 输入及原进程/写者排他事实；缺任何输入 STOP，不能把离线 fixture 当来源证明。
- Task 6/29R/30/I、业务代码、API/Web、历史迁移、Schema 模型、RBAC、工作流、旧 final Compose DAG、OSS/WORM 和冻结 stash 均不动。
- 仅允许 `db.migrate.deploy@1`、`db.schema.verify@1`；只有 `migrate`、`verify` 两种既有 capability，一调用一凭证。没有新的 `database-test` capability，没有任意 Shell/SQL/模块路径或容器 entrypoint override。
- 所有 manual JSON 实际字节上限 1 MiB；日志不泄漏凭证。真实 source/snapshot、API/Web 联测、供应商、浏览器、双链全量及 Stage 1 签字均非本计划完成条件。
- 本轮权限修订采用 **两个固定真实测试阶段 + 中间 H3-B 人工精确授权**，取代原 R2.4 单命令；不增加 permission worker、签名协议、Runner capability 或通用 SQL 入口。H3-A 仅准备目标，H3-B 必须等迁移表实际产生后另行批准；两阶段都完成才可能形成完整 R2 结论。

## 1. 基线事实与不能省略的门槛

| 位置                                                                     | 本次只读确认                                                          | 处理                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/release-runner/src/cli.mjs`                                        | `runProductionEntrypoint` 已调用真实 runtime adapters                 | 不是“默认占位器”；保留现有生产模式，新增分支显式隔离                                  |
| `apps/release-runner/src/postgres-connector.mjs`                         | 实际读取 DB OID/role/TLS，fingerprint 包含角色                        | physical DB identity 与各 profile observation 分开比较，禁止改写既有 fingerprint 含义 |
| `apps/release-runner/src/commands/db-migrate-deploy.mjs`                 | 确定性 plan、锁内重算、真实 Prisma 调用、replay/reconcile             | 直接复用，不能另写 SQL migration runner                                               |
| `apps/release-runner/src/commands/db-schema-verify.mjs`                  | catalog/checksum/owner/diff/版本/只读 statement 检查                  | 直接复用，verify 身份必须有实际读取所需的最小权限                                     |
| `apps/release-runner/test/db-migrate-schema.integration.test.mjs`        | 测试 context 是内存对象                                               | 可作回归，不能称真实 PG/镜像测试                                                      |
| `apps/release-runner/test/database-runtime-adapter.integration.test.mjs` | Prisma/psql 子进程也被注入替代                                        | R2.4 才采集真实最终镜像执行                                                           |
| P1/bootstrap 与 suite launcher                                           | P1 verify 没有迁移表读取授权；普通 fresh launcher 使用非 TLS 本地通道 | 不把它们直接当最终只读/TLS 门禁；H3 独立建立并读回目标权限，R2 不改 P1 record         |

当前可信 CI build proof 及真实 profile 尚未落实，R1 H2 还明确了 public Actions 180 日保管的现存阻断。本计划不修改工作流解决它；真实候选不可用时 `TRUSTED_BUILD_UNAVAILABLE`，不能偷偷改成本地 build 或绕过 attestation。

**历史工具偏差与当前状态：** `Dockerfile.runner` 的 `/app` 工作目录和 `apps/api/prisma.config.ts` 固定 config 已由 `5a16ca8a` 的 R2.0 参数修正覆盖；当前源码有 `configRelativePath` 与三处固定 `--config`，script 不再传非法 `--schema`。适配器测试仍不证明真实 Prisma/镜像/DB 兼容，真实门禁未因此通过。另默认 `node --test test/*.test.mjs` 不得选入人工真实门禁，专用子目录与 discovery 例外各司其职。

## 2. 固定交接与证据顺序

唯一字段/producer/时间/digest/nullable/phase/三态谓词规范是 [R1 §2.5](./2026-09-06-stage1-r1-manual-trust-and-authorization-plan.md#25-r1r2-唯一共享请求原件与派生判定契约r11e-所有)。R2 不复制 Schema 或重新实现提交判定；下面只规定实际生产/映射职责。

`R1 build/profile 验真 → 父会话锁 → observe attempt allocation 读回 → 完整 observe request 读回/签发/消费 → 实际 observation → baseline → 新 runner attempt allocation 读回 → null-request PREPARED 读回 → 零凭证 Runner/challenge → 完整 request 读回 → request-bound 快照读回/签发/消费 → 单 capability 交接 → PREPARED 持久化 → 实际调用与进程事件 → observation/result → R1 post-state/execution → 独立读回`

- Runner 在 challenge 阶段没有 DB 凭证/连接；实际 container ID、resolved platform digest、挑战 nonce 已产生，才成为命令 request digest 的一部分。不得审批未来 container ID。
- 固定 entrypoint、无额外 argv，通过已建立的 stdin/stdout 管道交接；不建本地 HTTP broker。父进程仅运行在 R1 已验证 owner 会话。Runner 的 challenge/授权/credential frame 分类型、定长限额；secret frame 不被 tee/transcript 持久化。
- 授权被 R1 原子消费并读回后，父方生成并保管签名 `consumption-handoff` receipt，最后重查撤销再交凭证。父进程的 `parentDecision` 仅控制凭证释放；Runner 用镜像内固定 profile 校验原授权、receipt 的不同签名域、有效期和自身 challenge，生成独立 `childDecision`。不能跨进程传 WeakSet decision，也不能让子进程声称已直接读取宿主撤销账本。
- 管道关闭/父会话死亡：未交凭证时拒绝；已执行时停止进一步动作并记 UNKNOWN，父进程能存活时仅可停止记录中的精确子容器。数据库写入是否已提交以原幂等键 reconcile 判定，不能靠断开管道宣称已回滚。
- 人工 baseline 只引用唯一 `buildProofDigest`，保存真实 pre-state、目标、角色观察及批准引用，不复制 source/三镜像/catalog 的第二份权威。新型记录不进入旧 full-RC 聚合，不伪造旧 `approval-record.v1` 或 `launch-attestation.v1`。
- apply 不重新生成审批身份：锁内重算 plan，并对照冻结 baseline/批准 digest；post-state 是新观察。verify/replay/reconcile 引用前序结果，不因合法迁移头变化拒绝，也不覆盖旧 baseline。

## Task R2.0：修正既有 Prisma 7.8 固定配置和参数

**历史交付：** 已由 `5a16ca8a` 实施；以下保留原任务范围/参数依据，不在此次 DOC-ONLY 回合重跑或重新提交，也不宣称真实外部门禁通过。

**Files:**

- Modify: `apps/release-runner/src/database-runtime-adapter.mjs`
- Modify/Test: `apps/release-runner/test/database-runtime-adapter.integration.test.mjs`
- Read/Test: `apps/release-runner/test/db-migrate-schema.integration.test.mjs`
- Read: `Dockerfile.runner`
- Read: `apps/api/prisma.config.ts`
- Read: `apps/api/prisma-env-policy.ts`
- Read: `packages/release-foundation/src/catalogs.mjs`
- Read: `release/contracts/repository-contract-files.v1.json`

**Interfaces:** 保持 `prismaMigrateDeployArgs({schema,repoRoot})`、`prismaSchemaDiffArgs({schema,repoRoot})` 和 `createDatabaseRuntimeAdapter(...)` 签名不变；script argv 私有函数仍不导出。只修三个参数数组，config 从固定 `repoRoot/apps/api/prisma.config.ts` 解析，不接收 caller config/工作目录覆盖，不改变锁/事务、凭证、错误分类或旧 handler 语义。runtime 已纳入 repository contract；修改将改变摘要，H2 必须基于新代码构建。

- [ ] **1. 写参数 RED。** 原测试的 deploy/diff 两数组增加固定 `--config`；经 `adapter.observeSchema()` 捕获 `--script` 调用，新增完整 script argv 断言，确保没有 `--schema`。使用跨平台 `path.resolve(repoRoot, ...)`；错误 schema 仍拒绝，凭证仍只在既有受控子进程环境中、不进入 argv。执行 `node --test apps/release-runner/test/database-runtime-adapter.integration.test.mjs`，记录实际缺 config/多 schema 的断言失败，不把 mock 子进程通过视为真实 Prisma 验证。
- [ ] **2. 最小 GREEN。** 保留 `assertSchemaPath`，由同一固定 repoRoot 生成 config；目标参数为：

```js
const config = path.resolve(repoRoot, "apps/api/prisma.config.ts");
// deploy: --schema 在此子命令合法；同时固定 datasource/migration config。
["migrate", "deploy", "--schema", schema, "--config", config];
// diff-to-schema: 不得增加独立 --schema。
[
  "migrate",
  "diff",
  "--from-config-datasource",
  "--to-schema",
  schema,
  "--exit-code",
  "--config",
  config
];
// 当前数据库的 script/digest：仍读取真实 datasource，不改成从 schema 生成。
["migrate", "diff", "--from-empty", "--to-config-datasource", "--script", "--config", config];
```

第三数组仍先执行现有固定 schema 路径校验，只是不再将该路径当非法 flag 传入。三处均无需依赖 shell cwd；保留 `STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV=1`。不更新 Prisma 版本、不改 config 文件或 Dockerfile。参数依据：[Prisma 7 migrate/diff](https://docs.prisma.io/docs/cli/v7/migrate/diff)。

- [ ] **3. 旧路径回归与精确提交。** 运行 `node --test apps/release-runner/test/database-runtime-adapter.integration.test.mjs apps/release-runner/test/db-migrate-schema.integration.test.mjs`，再运行默认 `pnpm --filter @subscription-saas/release-runner test`；`pnpm release:contracts:verify`。只有两文件可暂存；Prettier、unstaged/staged diff、独立审查后提交 `fix(runner): bind Prisma commands to fixed v7 config`。记录此时仍只是参数/适配器证据，真实 Linux `/app`、Prisma 7.8 和 datasource 连接留给 R2.4 最终镜像，不能提前声明工具实测完成。

## Task R2.1：人工请求、baseline 与 handler 映射

**Files:**

- Read（唯一创建/修改 owner 为 R1.1E）: `release/contracts/schemas/manual-runner-request.v1.schema.json`
- Read（唯一创建/修改 owner 为 R1.1E）: `release/contracts/schemas/manual-baseline-manifest.v1.schema.json`
- Read: `release/contracts/schemas/manual-runner-evidence.v1.schema.json`
- Read: `packages/release-foundation/src/manual-runner-evidence.mjs`
- Create: `apps/release-runner/src/manual-command-adapter.mjs`
- Create/Test: `apps/release-runner/test/manual-command-adapter.test.mjs`
- Create: `apps/release-runner/src/manual-target-observer.mjs`
- Create/Test: `apps/release-runner/test/manual-target-observer.test.mjs`
- Modify（本修订新增计划范围）: `apps/release-runner/src/commands/db-migrate-deploy.mjs`
- Modify/Test（本修订新增计划范围）: `apps/release-runner/test/db-migrate-schema.integration.test.mjs`
- Modify: `packages/release-foundation/src/catalogs.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: R1 `verifyManualHandoff/assertManualHandoffDecision`、R1.1E 唯一 request/manifest/evidence Schema 和两个纯函数；现有 `planMigration/applyMigration`、`verifySchema` 与 catalog/registry。父 decision 不得用于 command adapter。
- Produces: `buildManualBaseline({trustedBuildDecision,targetObservation,roleObservation,preState,authorizationDigest}):manifest`；`executeManualCommand({request,decision,baseline,database,runtime}):result`，manifest/result 形状完全见 R1 §2.5。该任务只构造真实原件、不输出自报 committed boolean；父方/独立 reader 通过共享 assessor 推导结论，不构造旧 execution-proof。
- Produces: `observeManualTarget({request,database,endpointPolicy,approvedClusterObservation}):Observation`（R1 §2.5 的完整 observation）；request 只提供经验证 A/requestDigest，physical/role/catalog 必须实际读取，不能复制授权作为观察。固定查询为 `SELECT system_identifier::text FROM pg_control_system()`、本连接 `inet_server_addr()/inet_server_port()`、database OID/name、current_user/TLS，再收集全部 catalog。physical identity 绑定 system identifier 与 H3 独立读回的精确 Docker/container/volume/image/marker/endpoint 记录；角色/TLS 分开。endpointPolicy 来自固定 profile，不能由请求自报；baseline factory 的 preState 即 observation.catalog，不重造观察。
- `preState` 是共享 CatalogObservation，observer 在真实 `REPEATABLE READ READ ONLY` 中读取 `to_regclass`/真实迁移表 OID、**全部** migrationRows（含未完成/失败/回滚）、owner/inventory、extensions/version；固定查询不得采用旧 runtime 仅成功行过滤。现有 connector 的 transaction callback 内先执行固定 `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`，不增加 caller SQL 入口。迁移表不存在与查询/权限失败严格分离，失败不得返回空前缀。完整 catalog 摘要不是 schemaScript digest。基线只取实际归档读回；子方各角色独立观察，跨角色 identity 不伪造。
- 完整 request 的顶层 ManualBinding 保持 R1.1 既有结构，target-observe 无 command/phase；fresh attemptId/runId/attemptAllocationDigest 与稳定 DomainInput 按共享契约。允许目标来自固定 profile，CLI 不覆盖 host/db。
- **最小 handler 接缝（新增两文件范围，唯一 owner R2.1）：** `planMigration(context, domainInput)` 不改签名/摘要；`applyMigration(context, approved, {executionIdentity} = {})` 新增可选第三参数，executionIdentity 精确 `{operationId:UUID,attemptId:UUID,runId:UUID}`，只供手工 adapter 从已验证完整请求复制。省略时继续读取原 approved.input 的三字段，旧两参数 handler/input/plan/proof 行为不变；提供时禁止 domainInput 内再放同名三字段，防止双重身份。post-state 身份只从有效 executionIdentity 取，其余 input/postconditions/锁内重算/Prisma 顺序不变。旧 `dbMigrateDeployHandler` 不启用此参数，command registry/v1 不改。

```js
// R2.1 手工分支的唯一领域调用映射；不是新 handler/plan 算法。
const input = request.domainInput;
const executionIdentity = {
  operationId: request.operationId,
  attemptId: request.attemptId,
  runId: request.runId
};
// dry-run: await planMigration(runtime, input)
// apply:
await applyMigration(
  runtime,
  { input, planDigest: request.approvedPlanDigest },
  { executionIdentity }
);
// verify/replay: await verifySchema(runtime, input)
// reconcile: 先独立收集全行 catalog，再尝试 verifySchema；抛错仍保管已真实获得的观察。
```

- **预期 Schema 输入硬门槛：** 签发 runner request 前固定输入读回核对共享 schema-expectation 的真实来源、同 build/source Schema、Prisma 输出格式与 raw script bytes。现有 runtime 的 datasource→script 仅是实际态，不是预期来源；当前没有确认合格生产原件，报 `MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED`，禁止 freeze runner request/sign/credential-read。不新建生成器、不将 catalog/profile/baseline digest 冒充 expectedSchemaDigest；来源决定仍需单独精确输入，离线测试只证明该 gate 拒绝/接受受控测试原件。
- **进程收集分工：** R2.1 定义固定调用对应的证据需求并保存 handler 原返回/抛错、完整 observation 与 statements 快照；R2.2 在已有 runtime `runProcess` 注入点安装同文件私有的真实 spawn collector，先保管/ACK PREPARED 再 spawn，保存 Buffer/真实 PID/close/超时/超限，再返回旧 runtime 所需 `{exitCode,signal,stdout,stderr}`。必须在 `requireSuccess` 抛错之前保管全部已产生事实；旧 executeProcess 的解码字符串/statementLog 不是完整原始进程或外部 Prisma SQL 证据。生产不能从 CLI/env 选择替代 collector。

- [ ] **1. 建立模块入口 RED。**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { executeManualCommand } from "../src/manual-command-adapter.mjs";

test("rejects fabricated approval before database access", async () => {
  let databaseCalls = 0;
  await assert.rejects(
    () =>
      executeManualCommand({
        request: { commandId: "db.migrate.deploy", commandVersion: "1", phase: "apply" },
        decision: { verified: true },
        database: {
          observeIdentity() {
            databaseCalls += 1;
          }
        }
      }),
    { code: "MANUAL_HANDOFF_UNTRUSTED" }
  );
  assert.equal(databaseCalls, 0);
});
```

`node --test apps/release-runner/test/manual-command-adapter.test.mjs` 首次预期缺模块；最小实现先调用 R1 `assertManualHandoffDecision`，然后补齐 Schema。

- [ ] **2. 为身份/映射增加 RED。** `node --test apps/release-runner/test/manual-target-observer.test.mjs apps/release-runner/test/manual-command-adapter.test.mjs`：相同 DB name/OID 但不同 system identifier、相同 identifier 但非批准 Docker endpoint，拒绝 `MANUAL_CLUSTER_IDENTITY_MISMATCH`；同 Schema 错 DB、错误 role/TLS、baseline 被修改、请求第三命令、组合 credentials、replay 缺前序记录、伪造云批准均拒绝。另测 parentDecision 冒充 childDecision、未消费/过期 receipt、旧 challenge 和改签名域。migration 与 verify 角色不同但 physical identity 相同的合法分支必须通过。
- [ ] **3. 实现 observer 和封闭映射并 GREEN。** observer 查询缺权限/字段或 H3 原件缺失直接拒绝，不能退回只比较 DB OID 或改用超级凭证。本轮仅准入 H3 合成 fresh 集群，不推断其覆盖副本/远端数据库。只调用现有两个 command handler 的领域函数；固定命令版本必须存在于 JSON registry/handler map。manual 授权是新路径外层门禁，不通过把旧 approvalMode 改成 none 规避旧验证。`database/runtime` 注入只用于内部构造及测试，正式 CLI 不接收 adapter 路径。
- [ ] **3a. preState/readback RED → GREEN。** 修改 H3 旧 head 不改变实时读取结果；缺 migration 表与无 SELECT 权限分别处理；篡改 preState、缺独立 readback 或新读取 owner/head 与批准 baseline 不同，必须拒绝，deploy 计数为 0。增加“合法空前缀 → live preState 归档读回 → baseline → dry-run”的正向用例，避免基线使用尚未产生的命令结果。
- [ ] **4. 增加 plan/identity/reconcile RED → GREEN。** 两个 fresh attempt/child envelope 的相同 domainInput 产生相同 plan，apply postState 的 attempt/run 必须取新的完整请求，旧两参数路径快照/错误码全部保持；改变 input/catalog/owner/fingerprint 才触发 PLAN_CHANGED_SINCE_APPROVAL，deploy=0。共享 assessor 正反例覆盖完整已提交、完整未 dispatch 证明、部分迁移/失败行/DML可能/缺终态仍 UNKNOWN；不在 adapter 重写谓词。增加 expected-schema 来源缺失、把实时 catalog/datasource digest 填为预期的拒绝，签发/凭证/DB=0。超出可选身份接缝的问题 STOP，不改事务/锁顺序。
- [ ] **5. 注册、回归、提交。** 两个新测试与修改后的 `db-migrate-schema.integration.test.mjs`、只读回归 `database-runtime-adapter.integration.test.mjs` 及共享 evidence/kernel/state-machine 测试通过；两个新模块纳入 RELEASE_GATE_ENTRY_POINTS/manifest，原 handler 已纳管。`pnpm release:contracts:verify`，Files 中八个 Create/Modify 文件格式/unstaged/staged diff 与独立审查后由主控提交 `feat(runner): map manual requests to existing database commands`；四个共享 Read 文件不重复修改/暂存，Schema 变更退回 R1.1E owner。

## Task R2.2：固定父启动方与零凭证 Runner 交接

**Files:**

- Create: `scripts/release/launch-manual-stage1.mjs`
- Create/Test: `scripts/release/launch-manual-stage1.test.mjs`
- Create: `apps/release-runner/src/manual-entrypoint.mjs`
- Create/Test: `apps/release-runner/test/manual-entrypoint.test.mjs`
- Modify: `apps/release-runner/src/cli.mjs`
- Modify/Test: `apps/release-runner/test/cli.test.mjs`
- Modify: `packages/release-foundation/src/catalogs.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: R1 `openTrustedManualSession`（内部实际固定 key loader，不接收调用方私钥或 owner 布尔值）、`verifyManualHandoff`，R2.1 request/adapter/observer，`createPostgresConnector()`、`createDatabaseRuntimeAdapter()`。
- Produces: `launchManualStage1({operationRef}):manual record reference`，`runManualEntrypoint({input,output,environment}):result`。正式 CLI 唯一用法为 `node scripts/release/launch-manual-stage1.mjs --operation-ref <固定档案内非秘密记录ID>`；不接受绝对请求路径、profile/roots、raw credentials、JSON 证明结果或随意命令。
- `operationRef` 只解析 R1 固定根内 UUID/digest 索引，读取前核对 owner-only 路径和上限；不能从任意输入路径得到信任。没有有效索引时明确拒绝，不为操作员生成签名授权。
- Produces（同文件非 CLI 导出阶段）: `connectAndObserveManualTarget({session,operationRef}):{observation,readbackDigest}`。observation 为 R1 §2.5 封闭 Observation。父方从固定索引取得 H3 精确目标意图，分配本次 attempt/归档请求后签发并消费 target-observe；检查 parentDecision/撤销后才读取固定 observer 凭证、连接并向 R2.1 observer 传已冻结 request。归档/独立读回后关闭连接并释放凭证。正式调用不接受既有连接/caller preState/decision，尚未通过本阶段不得冻结 baseline/启动 Runner。
- **唯一生产所有权：** 本任务的现有 launcher/entrypoint 两文件分别拥有父方 allocation/完整请求 create-only 与子方 process collector，所有形状引用 R1.1E，不新建额外文件或构造器。allocation 先于签发/消费/DB；零凭证 Runner 启动先写并重开 requestDigest=null、同 attemptAllocationDigest/A 的 PREPARED，实际 spawn 后追加 SPAWNED。取得实际 child/challenge、冻结并读回 request 后，以 previousProcessEvidenceDigest 连接不可变 null 原件，新写 requestDigest=D 绑定快照并读回；既有事件/时间不改，此后禁止回 null/换 request。R1 sign 只生成授权 ID，不事后分配执行 attempt。每次工具调用在既有 runProcess 注入点用固定 spawn 参数数组，PREPARED 通过管道由父方持锁保管、重开并 ACK 后才 spawn；真实 SPAWNED/原始流/CLOSED 再 append，collector 保存输出后才允许旧 runtime 返回或抛错。parent 原件记录实际容器 create/start/inspect/challenge/exit 与非秘密协议时序，secret frame 不记录。R1.2/R2.3 各自独立重开最终 process 链；子方输出不能建立宿主存储成功事实。
- 凭证释放前因实际校验失败而终止的 DISPATCH_CLOSED 要记录本次控制流真实拒绝、最后 consumption/handoff 原件及管道/child 关闭，且没有 deploy PREPARED；该完整证据才可供共享谓词判未 dispatch。缺日志、PREPARED 后死亡、ACK/写入成败未知全部保留 UNKNOWN；不能以派生布尔值覆盖原件。原 attempt/request 丢失只保留已有 slot/session 并 STOP，不生成恢复 UUID。

- [ ] **1. CLI 负向 RED。** 实际 Node 子进程调用新入口的 `--command`、`--entrypoint`、`--shell`、`--adapter`、`--profile-file`、`--archive-root`、未知 operation-ref；断言错误码且 spawn Docker/secret-read/DB 三计数为 0。已有无 envelope/多余 argv 负向测试保留。
- [ ] **2. 实现固定解析并 GREEN。** 父方只设置常量 `RUNNER_EXECUTION_MODE=manual-stage1`，它是模式选择而非授权；与旧 `RUNNER_LAUNCH_ENVELOPE_FILE` 同时出现必须拒绝。不允许 Docker command/entrypoint override；旧分支原样保留。新分支没有 raw secret 文件/环境路径消费能力，等待受限管道授权。测试仅设置该模式仍不能读凭证或连接 DB。
- [ ] **2a. 目标预观察 RED → GREEN。** `node --test scripts/release/launch-manual-stage1.test.mjs`：伪造、过期、已撤销、错目标及未消费的 target-observe 授权均断言 secret-read/DB-connect 为 0。实现上述父方阶段，测试正确授权只取得 observer 凭证、不取得 migrate/verify/provision 凭证；观察写入或读回失败不启动 Runner。只读 observer 本身不是第三个 Runner 命令，不要求未来 container/challenge。
- [ ] **2b. allocation/process 原件 RED → GREEN。** 两个既有新测试文件覆盖 allocation 写/读回失败、request 缺 attempt、重复 attempt、消费后原身份丢失、PREPARED ACK 前调用、实际 spawn 失败/非0/超时/输出限额/非法UTF-8、只有stdout字符串没有raw Buffer、close丢失。再覆盖合法 null 启动→实际 challenge→D 绑定正例，以及缺 null 原件、错 allocation/A、null 分支提前 DB/工具/凭证、spawn 后补 PREPARED、D 绑定后回 null/换 digest、重写旧事件时间的反例；断言这些拒绝或证据缺失不会补 UUID/close/成功原件，ACK 失败 deploy=0；在临时目录真实 Node 子进程采集 PID/原始 bytes/实际 close，正例证明完整事件链可被共享 assessor消费。仅使用本任务固定测试辅助子进程，不访问 Docker/DB，不将该测试报为真实 Runner。
- [ ] **3. challenge/父会话 RED。** 假 container ID、错误实际 Runner digest/OCI revision、旧 challenge、父退出、授权消费后取消、第二 credential frame、输入 1 MiB+1、credential 写入日志均拒绝。身份不匹配在读取 DB 凭证前失败。
- [ ] **4. 实现单次交接并 GREEN。** 父方从 R1 trusted build 获取 Runner registry/platform digest，实际 registry/inspect 与 OCI source 一致；先将 R1 §2.5 严格 null 分支的零凭证 PREPARED 保管/重开，再启动固定镜像、内部网络、只读 rootfs/受控 tmpfs、无 Docker socket/privileged/host-network/额外挂载，argv 为空。收到实际 child challenge 后在同一 owner 会话生成并重开规范化 request，再新写并重开 request-bound 快照（原 null 事件前缀不变），才人工确认、签发、撤销重查及消费读回；按 R1 生成签名 consumption-handoff receipt 并独立保管读回，再重查撤销，仅以 stdin 交当前能力凭证。子进程复验固定 profile、原授权、receipt 的消费/readback 身份和 container/challenge/时效，取得 childDecision 后才构造真实 connector/runtime adapter。不传宿主 KeyObject、WeakSet 品牌或账本路径。签名 receipt 不是云 launch attestation。
- [ ] **5. 异常/取消 RED → GREEN。** 从 credential-read 前、DB connect 后、deploy 后/记录前分别注入断管；只有实际完整拒绝/关闭链能证明未 dispatch，任何不确定用 UNKNOWN。恢复使用同原 operation/key/plan 与新 reconcile attempt；只读 query 失败不对原状态发 ATTEMPT_FAILED。父方容器退出码/原 stderr/受限日志来自实际进程，不接收外部成功 JSON。验证“全部原迁移完成+原进程退出+完整排他历史”和“schema虽一致但未知写者/部分行”两个对照，后者保留 UNKNOWN；secret frame 不入档。
- [ ] **6. 提交门禁。** `node --test scripts/release/launch-manual-stage1.test.mjs apps/release-runner/test/manual-entrypoint.test.mjs apps/release-runner/test/cli.test.mjs`；契约纳管、Files 八文件格式/unstaged/staged 检查、独立审查后提交 `feat(runner): add closed foreground manual launch handoff`。

宿主 Docker 管理员本身可以绕过容器限制，本方案信任已批准 owner/宿主，不能声称容器能阻止其 `docker exec`。本入口必须拒绝这些参数并对实际容器 spec 读回，不把工具允许项当实际部署证据。

## Task R2.3：真实执行测试入口与计数，尚不运行外部目标

**Files:**

- Create: `scripts/release/verify-manual-runner-result.mjs`
- Create/Test: `scripts/release/verify-manual-runner-result.test.mjs`
- Create: `apps/release-runner/test/manual/manual-runner-migration-postgres.integration.test.mjs`
- Create: `apps/release-runner/test/manual/manual-runner-verification-postgres.integration.test.mjs`
- Modify: `release/contracts/database-test-exceptions.v1.json`
- Modify: `packages/release-foundation/src/catalogs.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: R2.2 `launchManualStage1({operationRef})` 及其档案原件、R1.1E `assessManualRunnerEvidence`。固定 IO 独立重新枚举/读回同目标历史、真实原进程停止及 H1/H2/H3/expected-schema 来源门槛，再调用唯一纯判定器；不接收外部 Assessment、`--evidence-input-file` 或 injected successful adapters，不复制三态分类代码。
- 同一对真实测试文件覆盖两个分别批准的场景链：正向与真实 apply 中断。每条链内部保持同一 allocation/build/baseline/原始 apply；不同场景不得混用目标或原件。最终 verifier 要求同一可信 build 下两条链均完整，UNKNOWN 原件本身不是成功迁移记录；第二场景未获独立 H3 批准时显式 NOT_RUN，不自动运行。
- Produces: `verifyManualRunnerResult({operationRef}):{status,counts,recordDigest,promotionEligible:false}`。此只读函数从固定 R1 索引独立读回实际工具/DB/容器记录，验证下面固定用例清单；不能仅验 JSON Schema 即通过。第一阶段仅形成 migration 阶段记录，verification 未运行显式为 `NOT_RUN`，不能生成整体 PASS。最终汇总必须关联同一 allocation/build/原始 baseline/迁移 operation 和 H3-B 人工操作原件、独立权限读回；不得接收 caller 提供的权限通过布尔值。

- [ ] **1. 先写 result verifier RED。** 构造受控测试档案：缺 child PID/实际镜像 digest/版本、少一项命令、统计 dropped/skipped、改写结果字节、工具 stdout 为预制但没有对应进程记录、只给 liveness 均拒绝。`node --test scripts/release/verify-manual-runner-result.test.mjs` 首次缺模块；断言 `MANUAL_RESULT_INCOMPLETE`/`MANUAL_RESULT_IDENTITY_MISMATCH`。
- [ ] **2. 最小校验实现并 GREEN。** 固定运行清单：target-observe、migration dry-run/apply、H3-B 独立权限读回、readonly verify、migration readonly replay、原 apply UNKNOWN 的只读 reconcile。核对完整历史并调用共享 assessor；fresh 正向迁移必须非空 pending，不能“零变化”冒充迁移。用同组完整成功档案作为正例，再删 H3-B/改表 OID/owner/角色、缺 provision 退出、第二阶段重新 apply/baseline、reconcile本次SUCCEEDED但原not-committed、未知原进程终态、仅schemaPASSED，逐一拒绝整体迁移 PASS。第一阶段不要求未来 H3-B，本次只读调查签收不等于原迁移成功。
- [ ] **3. 写两个实际 PG 测试文件。** 精确位置为 Files 列出的 `test/manual/` 两文件，该子目录不被默认 `test/*.test.mjs` 覆盖；相对导入按新增层级修正。migration 文件仅执行 target-observe、原始 baseline、dry-run/apply、保管读回并结束；verification 文件从固定索引消费同一 allocation/build/原始 baseline/迁移前序记录和完成后的 H3-B 原件，再实际核对目标与权限，执行 verify/replay/reconcile。后者禁止 apply、重新分配目标或重建 baseline。使用 Node test；缺本阶段实际 H1/H2/H3 输入即 throw `MANUAL_REAL_GATE_INPUT_REQUIRED`，没有 `.skip`/`.only`/test-name filter 或 Boolean 外部开关。测试真实调用 launcher，不能提供 `createClient/runProcess/handler` mock。测试进程不持有 migration/provision credential；Runner 能力凭证只由 R1 父会话交给对应单次 Runner。H3-B 是测试之间单独批准的人工操作，不伪装为 R1 `target-observe`/`runner-command` 批准。
- [ ] **4. 独立登记适用性。** 两文件属于真实最终镜像门禁，不混入 source CI DB 清单。分别按精确路径登记为有 owner、原因、复核日期和各自唯一执行命令的例外；manifest 不伪造 source/fresh 执行条目。`release:database-tests:discover` 必须发现并分类两文件，不能靠目录漏选。例外理由只覆盖 source 测试集合，不豁免 R2.4 两阶段实际执行。
- [ ] **5. 无数据库提交门禁。** 运行 result verifier 单测、契约与测试发现，并在没有 H1/H2/H3 的开发环境执行默认 `pnpm --filter @subscription-saas/release-runner test`；默认运行必须不包含 `test/manual/` 两个真实门禁且不得出现 `MANUAL_REAL_GATE_INPUT_REQUIRED`。不能改 package glob、加 skip 或靠 discovery 例外控制 Node 选择。精确七文件 Prettier、unstaged/staged diff、独立审查后提交 `test(runner): define real manual migration verification gate`。报告明确两阶段真实数据库计数均为 NOT_RUN；真实文件仅由 R2.4 的两个精确命令执行。

例外及 contract manifest 修改与 B3/B5 串行集成，保留先前已合入条目；不重写整张清单。现有 `database-test-exceptions.v1.json` 的条目固定为 `path/owner/reason/scope/reviewDate`：新增两个精确测试路径，owner 为 `stage1-r2-owner`，scope 为 `manual-final-image-gate`，reviewDate 为 `2026-12-06`；各 reason 写明 source 集合不适用、由 R2.4 对应的唯一 Node 命令实际执行。R2 不修改 source suite manifest，也不让例外成为最终门禁的 skip。

## H3：精确合成目标准备与回收批准

在 R2.4 前停下提交本次精确摘要。R1 H1/H2 任一未完成，不能进入 H3 实际目标创建。H3 不是把 P1 已删除的目标恢复，也不是 Stage1 实际副本。

- [ ] 列明单次批准的新临时 cluster/container/专属 volume 或创建参数、PostgreSQL 17 digest、loopback/内部网络、TLS、精确 marker/run、database 名、provision/migrate/verify/observer 四个不同角色及四个独立凭证位置（仅位于 R1 固定 credential root 内）和回收计划。observer 仅供父方预观察，verify 仅供 Runner schema 命令；不组合凭证，不复用 migration 身份。名称必须由本次分配记录产生，不从旧 record 复制；用户批准后才执行该次一次性操作单。
- [ ] **H3-A 初始权限。** migration 拥有目标 Schema；verify/observer 为固定身份/catalog 只读角色，均非 owner、无 DDL/DML/SUPERUSER/CREATEDB/BYPASSRLS/额外 role membership。fresh 库确认 `_prisma_migrations` 不存在，将该表 SELECT 明确记为 `PENDING_TABLE_CREATION`，不能提前记已授权；observer 此时可以通过 `to_regclass` 记录真实空前缀。provision 初始进程退出并清除内存凭证，其 credential 在固定 root 中密封保留，仅可在另行批准的 H3-B 人工进程重新开启；不得交给测试或 Runner。迁移不承担业务 seed，R2 不写业务数据。
- [ ] **H3-B 的权限发行者前置披露。** migrate 将成为迁移表 owner，普通建库 provision 身份并不自动拥有授权资格。本方案在 H3-A 精确审批中声明该单次隔离合成集群的临时 provision 管理身份及实际 PostgreSQL `SUPERUSER` 属性，仅用于已批准建库/权限安装/撤权操作；不声称数据库把它限制成单表 grant-only。该管理凭证不得跨集群，不得成为 migration/test/verify/observer 身份。若用户不接受此临时管理身份保留到 H3-B，停止真实运行，不借用 migrate 凭证或 `SET ROLE` 绕过，也不另建权限框架。
- [ ] 独立读回 cluster system identifier、精确 Docker/container/volume/image/marker/endpoint、DB OID、role、TLS、PG17 实际版本、owner/扩展/权限。migration/verify 各角色必须能执行 observer 固定只读函数；若需精确 `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system()`，列入本次 H3 权限批准、独立读回 `has_function_privilege`，不能运行时提权。角色权限以 `pg_roles`、`pg_auth_members`、owner、`has_schema_privilege/has_table_privilege` 固定查询核验；错误 TLS/owner/角色必须阻断。旧 suite launcher 的 `tlsMode:disable` 或 P1 migrate 自检不是替代。
- [ ] **H3-B 表创建后的独立批准。** migration 阶段实际 apply/内部自检完成并保管、其 Runner 与连接退出后，停止提交新操作单：本次 allocation/build/原始 migration 记录、真实 cluster/DB/table OID、migrate owner、verify/observer 精确受让角色、权限发行者、固定 `GRANT SELECT ON TABLE public._prisma_migrations`、读回及撤权顺序。用户另行批准后，独立人工操作进程才使用密封 provision credential；不新增自动 worker、R1 签名 kind 或 Runner 命令。禁止 `GRANT ... ON ALL TABLES`、默认全表 SELECT、grant option、业务 DML/DDL。实际授权前再核对目标/表 owner/OID；只能针对上述一表和两个角色。
- [ ] **H3-B 完成与退出。** verify/observer 各自连接实际读迁移表，核对成功 SELECT、无表 owner/额外成员关系、无业务表 SELECT，并保存本次人工批准来源、真实命令/退出码、前后权限及独立读回。原件归档到已批准固定档案并绑定 allocation/迁移记录，不接受 caller JSON 代替实时权限事实。provision 在独立操作进程中撤销自身登录/管理权限、关闭最后连接；凭证按本次精确清单处置，随后由只读身份读回 `pg_roles`/活动会话和宿主精确文件状态。只有撤权/退出/独立读回全部完成，才允许第二个 verification 测试。GRANT、提交、撤权或读回不确定均记 UNKNOWN，阻断后续；另获精确恢复批准，不自动重跑 migration apply。
- [ ] **apply UNKNOWN 独立恢复分支。** 正向 allocation 与受控中断 allocation 分别申请 H3，不在已完成正向迁移的库中伪造 pending 条目。中断场景在第一阶段真实 Prisma 提交后、父方完成记录前中断，保存该 apply 的 operation/idempotency/批准 plan/实际进程和 UNKNOWN 原件，立即停止。此时不得使用正常 H3-B 成功前置；另行向用户申请本次 UNKNOWN 的精确只读调查及必要单表授权/撤权操作单，绑定未知 apply 和其实际目标，由独立 provision 操作进程核对迁移表存在、owner/OID、实际 catalog/head/checksum，再完成获准的 H3-B 恢复步骤。第二阶段只读 reconcile 判定的是原 apply，不是 replay 的 UNKNOWN；不能根据管理方读回自动抹除旧 UNKNOWN 或重新 apply。目标/表状态不足以授权时保持阻断。
- [ ] 执行前批准消费者暂停范围；成功保管后按精确清单另行确认退役窗口。失败/UNKNOWN 保留原件并停止；禁止 `docker compose down --remove-orphans`、prune、通配删除或“自动清干净”。回收后独立确认容器/专属卷/凭证与 record 状态，不能只信删除命令退出码。

H3 精确对象在本稿编写时不存在，因此这里不提供可直接误执行的 Docker 删除命令。所有实际创建、权限写入及销毁仍需用户另行批准；不足以制定精确操作单时停止，不扩建新的 provision/cleanup 平台。

## Task R2.4：最终镜像、真实 PG17 migrate/verify 与独立审查

**Files:** 无产品或工具代码修改；只新增执行后报告 `docs/acceptance/2026-09-06-stage1-r2-manual-runner-verification.md`。保密原件进入 R1 固定档案，不提交凭证或原始 DB 连接串。

**Interfaces:** 第一阶段 Consumes R1 H1/H2、H3-A 真实读回；第二阶段还必须消费之后产生的 H3-B 读回及原始 migration 记录。Produces 指定 bundle/同一目标的两个阶段统计及完整本地 manual 竖切报告，不是 full-RC/Stage1 完成证明。

- [ ] **1. 核验准入后运行 migration 阶段。** `node --test apps/release-runner/test/manual/manual-runner-migration-postgres.integration.test.mjs`；固定索引读取 H1/H2/H3-A 批准而非临时参数拼接。缺失时不运行以制造可预知失败，也不得记通过。此阶段只到真实 apply/内部 migrate 自检、原件保管读回并退出，不提前运行 readonly verify。任何失败/UNKNOWN 停止正常序列，只能另获精确只读调查/恢复批准。
- [ ] **1a. 人工权限停止点。** 按 H3-B 提交精确操作单并等待用户批准；不得把 H3-A 或本计划批准当作该 DCL 操作批准。完成实际授权、两个角色独立读取、provision 撤权/退出和档案读回后，才执行 `node --test apps/release-runner/test/manual/manual-runner-verification-postgres.integration.test.mjs`。两次精确命令不得替换为 glob/filter/skip；第二阶段只能消费同一目标、build、原始 baseline 和迁移结果，不再次 apply。H3-B 未完成时第二阶段为 NOT_RUN，R2 未通过。
- [ ] **2. 检查真实正向结果。** 实际最终 Runner Node22、Prisma7.8.0、psql17、PG17 版本，三镜像同一 build proof/实际 Runner digest，真实 pending migrations 应用与 checksum/head、Schema diff=0、迁移 owner 完整、verify 只读。API/Web 本轮不启动；完整 bundle 匹配不意味着完整 RC 通过。
- [ ] **3. 独立核验反例。** 通过 H3 权限只读 readback 与实际 verify 查询证明角色边界；固定 verify handler 不接受任意 DDL/DML，不能为了负向测试新增 SQL 入口。若还需实际写拒绝探测，应先提交 H3 独立精确探测批准，不将其伪装成 Runner 命令；当前两命令测试不自动执行。错误 cluster/DB/OID/TLS/镜像/批准/组合凭证在指定边界失败；不符合权限 readback 时停止保留现场。测试进程不持有 migration credential。
- [ ] **4. 检查 plan 与真实 apply UNKNOWN。** 正向目标证明锁内重算及 readonly replay 无重复迁移。另对 H3 独立批准的合成中断目标，以相同两个固定命令执行非空 pending 的提交后/父记录前中断；固定场景由批准索引识别，无任意 hook。第一阶段只形成原 apply UNKNOWN，立即进入 H3 恢复停止点。第二阶段先独立读回原 attempt/request/批准 plan、原进程真实停止、全目标排他历史、H3权限/退出，再读取全部 migration rows 与真实 schema，以共享谓词判原结果；不能仅看完成行/exit0/schemaPASSED，不能把父事务回滚解释为 Prisma 全回滚。部分提交/失败行/仅schema一致/无法归因保持 UNKNOWN，整体 BLOCKED；未 dispatch 的完整拒绝才可能 not-committed，本次调查成功仍不能计原迁移成功。replay 中断属于 replay 自己，不能替代原 apply 用例。不获批准或证据不足明确 NOT_RUN/BLOCKED，不重跑 apply、不改原 operation/key/plan。
- [ ] **5. 先保管、读回再回收。** 两个测试阶段分别报告完整计数再汇总；各自满足 `collected=selected=executed=passed+failed`，failed/skipped/todo/filtered/cancelled 全为 0，且 H3-B 完成才可能通过；未运行阶段明确 NOT_RUN，第一次失败原件仍保留。R1 私密档案/加密备份/owner 签收、H3 精确退役及独立读回分别有事实，不能用一条“成功”代替。
- [ ] **6. 独立 reviewer 签报告后结束。** 报告列实际运行 source/build/工具版本、每次命令/phase/op/目标、统计、失败历史、保管/退出状态。仅报告文件格式与 staged diff 检查后提交 `docs(acceptance): record manual runner vertical slice evidence`。若任一门槛失败，不提交“通过”结论，停止并请求精确修复或重跑批准。

## 交接与停止点

R2.0–3 的单元/适配器通过只说明代码可进入真实门禁，不解除 H1/H2/H3。R2.4 成功后也只交付 fresh migrate/verify；真实 snapshot、独立数据授权/隔离、API/Web 公共路径、全量双链归 R3/A2，Staging 部署/签字归 R4/A3。旧 Task 29R/30、KMS、自动化工作流及外部施工继续冻结。
