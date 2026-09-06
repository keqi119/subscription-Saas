# Stage 1 R2 最终 Runner migrate/verify 竖切实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development，子 agent 按提交边界施工，主 agent 逐项审查；如用户改变模式才使用 superpowers:executing-plans。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 R1 人工授权接入最终 Runner 的两个既有数据库命令，实际证明权限隔离、迁移重算和只读核验；不启动完整 RC、Staging 或 Task 30。

**Architecture:** 保留旧可信启动路径不变，在固定 Runner entrypoint 内增加封闭的人工交接分支。复用现有 PostgreSQL connector、runtime adapter、migration/schema 函数；不以云 approval、预制测试 JSON 或 `verified:true` 代替 R1 的真实验证和会话消费。

**Tech Stack:** 现有最终 Runner Node 22/Prisma 7.8.0/psql 17，PostgreSQL 17 digest-pinned 合成 fresh 目标，Docker 原生固定参数启动，Node 流/子进程测试。无新依赖、数据库迁移或云服务。

**Spec:** [最小受控发布决策 §3、§5](../specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md)、[R1 计划](./2026-09-06-stage1-r1-manual-trust-and-authorization-plan.md)、[覆盖路线图](./2026-09-06-stage1-mainline-minimal-release-implementation-plan.md)、[P0/P1 实际索引](../../acceptance/2026-09-06-stage1-mainline-execution-index.md)。

## Global Constraints

- 状态：**局部修订待复审，未授权施工**；原计划 `dce7ba1a`，本轮修订基于同一完整 HEAD `dce7ba1a4d3f5848dd5225e535dd43146a095974`。补齐既有 Prisma runtime 参数缺陷、fresh 权限安装时序和真实门禁选择隔离；R1/R2 仍分别审批，不把 R1 标记为已完成。
- P1 两个合成目标已经退役。没有可复用的 active record 或 credentials；不读取归档秘密，不访问 ambient DB URL，不以旧删除批准覆盖新目标创建/退役。
- R2.0–R2.3 是无外部副作用的代码/适配器测试；R2.0 可独立修正旧 runtime，R2.1–3 消费已审查 R1 代码。R2.4 的真实运行必须先完成 R1 H1/H2 和 H3 精确新目标操作批准。缺任何输入只停止真实门禁，不让 mock 报告转为实际证据。
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

**本轮实际工具偏差：** `Dockerfile.runner` 以 `/app` 为工作目录，config 在 `/app/apps/api/prisma.config.ts`；runtime 三次迁移/比较调用未明确 `--config`，其中 datasource-to-script 调用还传入 Prisma 7.8 `migrate diff` 不支持的 `--schema`。已有 runtime 测试用注入子进程返回值，不证明 CLI 兼容。这是原有工具缺陷，R2.0 精确修复并保留旧路径回归；不是本计划此前引入的产品回归。另 `apps/release-runner/package.json` 默认 `node --test test/*.test.mjs` 不得选入人工真实门禁，专用子目录与 discovery 例外各司其职。

## 2. 固定交接与证据顺序

`R1 build/profile 验真 → 父会话锁 → target-observe 批准 → 只读真实目标 observation → 冻结 manual baseline → 启动零凭证 Runner → 实际进程 challenge → 签发/消费精确命令批准 → 单 capability 凭证交接 → 命令 → post-state → manual execution record → 私密独立读回`

- Runner 在 challenge 阶段没有 DB 凭证/连接；实际 container ID、resolved platform digest、挑战 nonce 已产生，才成为命令 request digest 的一部分。不得审批未来 container ID。
- 固定 entrypoint、无额外 argv，通过已建立的 stdin/stdout 管道交接；不建本地 HTTP broker。父进程仅运行在 R1 已验证 owner 会话。Runner 的 challenge/授权/credential frame 分类型、定长限额；secret frame 不被 tee/transcript 持久化。
- 授权被 R1 原子消费并读回后，父方生成并保管签名 `consumption-handoff` receipt，最后重查撤销再交凭证。父进程的 `parentDecision` 仅控制凭证释放；Runner 用镜像内固定 profile 校验原授权、receipt 的不同签名域、有效期和自身 challenge，生成独立 `childDecision`。不能跨进程传 WeakSet decision，也不能让子进程声称已直接读取宿主撤销账本。
- 管道关闭/父会话死亡：未交凭证时拒绝；已执行时停止进一步动作并记 UNKNOWN，父进程能存活时仅可停止记录中的精确子容器。数据库写入是否已提交以原幂等键 reconcile 判定，不能靠断开管道宣称已回滚。
- 人工 baseline 只引用唯一 `buildProofDigest`，保存真实 pre-state、目标、角色观察及批准引用，不复制 source/三镜像/catalog 的第二份权威。新型记录不进入旧 full-RC 聚合，不伪造旧 `approval-record.v1` 或 `launch-attestation.v1`。
- apply 不重新生成审批身份：锁内重算 plan，并对照冻结 baseline/批准 digest；post-state 是新观察。verify/replay/reconcile 引用前序结果，不因合法迁移头变化拒绝，也不覆盖旧 baseline。

## Task R2.0：修正既有 Prisma 7.8 固定配置和参数

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

- Create: `release/contracts/schemas/manual-runner-request.v1.schema.json`
- Create: `release/contracts/schemas/manual-baseline-manifest.v1.schema.json`
- Create: `apps/release-runner/src/manual-command-adapter.mjs`
- Create/Test: `apps/release-runner/test/manual-command-adapter.test.mjs`
- Create: `apps/release-runner/src/manual-target-observer.mjs`
- Create/Test: `apps/release-runner/test/manual-target-observer.test.mjs`
- Modify: `packages/release-foundation/src/catalogs.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: R1 `verifyManualHandoff/assertManualHandoffDecision`；现有 `planMigration/applyMigration`、`verifySchema` 和 catalog/registry 读取函数。父 decision 不得用于 command adapter。
- Produces: `buildManualBaseline({trustedBuildDecision,targetObservation,roleObservation,preState,authorizationDigest}):manifest`；`executeManualCommand({request,decision,baseline,database,runtime}):result`。result 明确 `kind:"manual-command-result"`、`promotionEligible:false`，不构造旧 execution-proof。
- Produces: `observeManualTarget({database,endpointPolicy,approvedClusterObservation}):{physicalIdentity,roleObservation,preState,schemaObservationDigest}`。同一实际连接执行固定只读查询：`SELECT system_identifier::text FROM pg_control_system()`、本连接 `inet_server_addr()/inet_server_port()`、database OID/name、current_user 和本会话 TLS。physical identity 绑定 system identifier 与 H3 独立读回的精确 Docker/container/volume/image/marker/endpoint 记录；角色/TLS 另作 observation，不改既有 connector 的含角色 fingerprint。endpointPolicy 来自固定 profile，不能由请求自报。
- `preState` 由本 observer 在 `REPEATABLE READ READ ONLY` 中实际读取：`to_regclass('public._prisma_migrations')`、存在时的已完成未回滚 migration path/checksum/head、schema owner、排序后的对象 owner/inventory、extensions/version；没有迁移表是显式空前缀，不是读取错误时退回空数组。`schemaObservationDigest` 对这些规范化 catalog 字段计算，不伪称 Prisma schema-diff。父方把完整 observation/preState 原件归档并独立读回，`buildManualBaseline` 仅消费该受信读回值；H3 allocation record 和调用方 JSON 都不得替代实时 preState。后续子进程在各自角色/锁内重读，角色 fingerprint 不能从 observer 改写冒充 migrate。
- request 必填 command/version、phase、baseline digest、operation/idempotency、session/challenge/container/digest 绑定；仅 migrate apply 带批准 plan，replay/reconcile 必须前序记录。允许目标来自固定 profile，不使用 CLI host/db 覆盖。

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
- [ ] **4. 增加 plan/replay RED → GREEN。** 基线 plan 生成后改变 applied catalog、owner 或 DB fingerprint；断言 `PLAN_CHANGED_SINCE_APPROVAL` 且 deploy 调用为 0。reconcile 已提交/未提交/仍未知三结果分开，不把只读观察到的任意终态都当成功。旧函数行为不符本契约时停下给精确反例，不顺带改事务/锁顺序。
- [ ] **5. 注册、回归、提交。** 上述两个新测试加 `db-migrate-schema.integration.test.mjs`、`database-runtime-adapter.integration.test.mjs`；两个新模块纳入 `RELEASE_GATE_ENTRY_POINTS` 和 contract manifest，`pnpm release:contracts:verify`。Files 八文件 Prettier、unstaged/staged diff 检查及独立审查后提交 `feat(runner): map manual requests to existing database commands`。

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
- Produces（同文件非 CLI 导出阶段）: `connectAndObserveManualTarget({session,operationRef}):{observation,readbackDigest}`。observation 包含 R2.1 的完整 physicalIdentity/roleObservation/实时 preState/schemaObservationDigest。父方从固定索引取得 H3 精确目标意图，先人工签发并消费 `target-observe` 授权，检查 parentDecision/撤销，才从 profile credential root 内的 H3 固定 observer 引用读取单一凭证、连接并调用 R2.1 observer；归档/独立读回后关闭连接并释放凭证。正式调用不接受既有 database 连接、caller preState 或 caller decision；尚未通过本阶段不得冻结 baseline/启动 Runner。

- [ ] **1. CLI 负向 RED。** 实际 Node 子进程调用新入口的 `--command`、`--entrypoint`、`--shell`、`--adapter`、`--profile-file`、`--archive-root`、未知 operation-ref；断言错误码且 spawn Docker/secret-read/DB 三计数为 0。已有无 envelope/多余 argv 负向测试保留。
- [ ] **2. 实现固定解析并 GREEN。** 父方只设置常量 `RUNNER_EXECUTION_MODE=manual-stage1`，它是模式选择而非授权；与旧 `RUNNER_LAUNCH_ENVELOPE_FILE` 同时出现必须拒绝。不允许 Docker command/entrypoint override；旧分支原样保留。新分支没有 raw secret 文件/环境路径消费能力，等待受限管道授权。测试仅设置该模式仍不能读凭证或连接 DB。
- [ ] **2a. 目标预观察 RED → GREEN。** `node --test scripts/release/launch-manual-stage1.test.mjs`：伪造、过期、已撤销、错目标及未消费的 target-observe 授权均断言 secret-read/DB-connect 为 0。实现上述父方阶段，测试正确授权只取得 observer 凭证、不取得 migrate/verify/provision 凭证；观察写入或读回失败不启动 Runner。只读 observer 本身不是第三个 Runner 命令，不要求未来 container/challenge。
- [ ] **3. challenge/父会话 RED。** 假 container ID、错误实际 Runner digest/OCI revision、旧 challenge、父退出、授权消费后取消、第二 credential frame、输入 1 MiB+1、credential 写入日志均拒绝。身份不匹配在读取 DB 凭证前失败。
- [ ] **4. 实现单次交接并 GREEN。** 父方从 R1 trusted build 获取 Runner registry/platform digest，实际 registry/inspect 与 OCI source 一致；启动固定镜像、内部网络、只读 rootfs/受控 tmpfs、无 Docker socket/privileged/host-network/额外挂载，argv 为空。收到 child challenge 后在同一 owner 会话生成规范化 request，人工确认、签发、撤销重查及消费读回；按 R1 生成签名 consumption-handoff receipt 并独立保管读回，再重查撤销，仅以 stdin 交当前能力凭证。子进程复验固定 profile、原授权、receipt 的消费/readback 身份和 container/challenge/时效，取得 childDecision 后才构造真实 connector/runtime adapter。不传宿主 KeyObject、WeakSet 品牌或账本路径。签名 receipt 不是云 launch attestation。
- [ ] **5. 异常/取消 RED → GREEN。** 从 credential-read 前、DB connect 后、deploy 后/记录前分别注入断管；未产生 DB 调用的记录为拒绝，提交不确定为 UNKNOWN；保存同幂等键后续 reconcile。父方容器退出码、原 stderr 分类及受限日志来自实际进程，不能接收外部“已通过” JSON。任何 credential frame 不进入 R1 归档。
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

- Consumes: R2.2 `launchManualStage1({operationRef})` 以及其档案原件；不接受 `--evidence-input-file` 或 injected successful adapters。
- 同一对真实测试文件覆盖两个分别批准的场景链：正向与真实 apply 中断。每条链内部保持同一 allocation/build/baseline/原始 apply；不同场景不得混用目标或原件。最终 verifier 要求同一可信 build 下两条链均完整，UNKNOWN 原件本身不是成功迁移记录；第二场景未获独立 H3 批准时显式 NOT_RUN，不自动运行。
- Produces: `verifyManualRunnerResult({operationRef}):{status,counts,recordDigest,promotionEligible:false}`。此只读函数从固定 R1 索引独立读回实际工具/DB/容器记录，验证下面固定用例清单；不能仅验 JSON Schema 即通过。第一阶段仅形成 migration 阶段记录，verification 未运行显式为 `NOT_RUN`，不能生成整体 PASS。最终汇总必须关联同一 allocation/build/原始 baseline/迁移 operation 和 H3-B 人工操作原件、独立权限读回；不得接收 caller 提供的权限通过布尔值。

- [ ] **1. 先写 result verifier RED。** 构造受控测试档案：缺 child PID/实际镜像 digest/版本、少一项命令、统计 dropped/skipped、改写结果字节、工具 stdout 为预制但没有对应进程记录、只给 liveness 均拒绝。`node --test scripts/release/verify-manual-runner-result.test.mjs` 首次缺模块；断言 `MANUAL_RESULT_INCOMPLETE`/`MANUAL_RESULT_IDENTITY_MISMATCH`。
- [ ] **2. 最小校验实现并 GREEN。** 固定运行清单：target-observe、migration dry-run/apply、H3-B 精确权限安装及独立读回、readonly verify、migration readonly replay、失败/UNKNOWN 的只读 reconcile。核对每个 operation/前序关系和实际 readback；fresh 正向迁移必须确有 pending 条目，不以空库“零变化”冒充迁移执行。增加缺 H3-B、表 OID/owner/受让角色不符、provision 未退出或第二阶段重新 apply/生成 baseline 的反例；拒绝整体 PASS，不要求尚未生成的 H3-B 记录作为第一阶段前置。
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
- [ ] **4. 检查 plan 与真实 apply UNKNOWN。** 正向目标证明锁内实际重算及 readonly replay 无重复迁移。另对 H3 独立精确批准的合成中断目标，以相同两个固定测试命令执行实际 pending migration 的提交后/父记录前中断；测试文件从本次已批准操作索引识别固定场景，不接受 CLI 故障代码或任意 hook。第一阶段仅证明观察到原 apply 的 UNKNOWN，立即进入 H3 的独立恢复停止点；不能把预期测试断言通过写成 migration 成功。恢复批准、真实表/权限读回和 provision 退出后，第二阶段只读 reconcile 按同一 apply 幂等键、真实 `_prisma_migrations`/schema 判定已提交/未提交/仍未知。replay 中断的状态必须属于 replay 自己，不能替代此提交不确定性用例。未获该场景批准或未完成真实 reconcile 时标记该项 NOT_RUN/BLOCKED，整体 R2 不得 PASS；不自动创建第二目标或重跑 apply。
- [ ] **5. 先保管、读回再回收。** 两个测试阶段分别报告完整计数再汇总；各自满足 `collected=selected=executed=passed+failed`，failed/skipped/todo/filtered/cancelled 全为 0，且 H3-B 完成才可能通过；未运行阶段明确 NOT_RUN，第一次失败原件仍保留。R1 私密档案/加密备份/owner 签收、H3 精确退役及独立读回分别有事实，不能用一条“成功”代替。
- [ ] **6. 独立 reviewer 签报告后结束。** 报告列实际运行 source/build/工具版本、每次命令/phase/op/目标、统计、失败历史、保管/退出状态。仅报告文件格式与 staged diff 检查后提交 `docs(acceptance): record manual runner vertical slice evidence`。若任一门槛失败，不提交“通过”结论，停止并请求精确修复或重跑批准。

## 交接与停止点

R2.0–3 的单元/适配器通过只说明代码可进入真实门禁，不解除 H1/H2/H3。R2.4 成功后也只交付 fresh migrate/verify；真实 snapshot、独立数据授权/隔离、API/Web 公共路径、全量双链归 R3/A2，Staging 部署/签字归 R4/A3。旧 Task 29R/30、KMS、自动化工作流及外部施工继续冻结。
