# Stage 1 S1 可信发布底座与测试隔离规格

日期：2026-09-01

状态：已批准

批准基线：`ee9ca6bca41ef3b8ec1403b584b45705301ec5b5`

基线提交：`0fe8011a687fb14f250bf9fadaf20cccf32ab1a3`

上位决策：

- [Stage 1 收敛治理主 ADR](./2026-09-01-stage1-convergence-governance-adr.zh-CN.md)
- [S0 原子事实权威与临时资产治理规格](./2026-09-01-stage1-s0-authority-and-temporary-asset-governance-design.zh-CN.md)

## 决策摘要

S1 采用 A+ 架构：单一仓库、单一 source SHA、一次可信构建运行生成 API、Web、Runner 三个不可变镜像及统一构建证明。Runner 是独立镜像、独立运行身份、独立凭证和独立执行生命周期，但不是可单独替换的发布单元。候选环境、最终发布物 Compose 和 Staging/Production 等长期环境中的迁移、验证及受控写操作，只能通过与构建证明匹配的封闭 Runner 命令执行。镜像构建前的 CI 临时数据库门禁使用受信源码执行器，只产生 source-gate evidence，并由最终 Runner 在构建后重复等价验证。

S1 同时建立：

1. PostgreSQL 17 独立数据库测试隔离和数据库测试发现全集；
2. fresh 与 sanitized snapshot 两条升级证据链；
3. `source-gate evidence`、构建证明、Environment Manifest 和执行证明的分层模型；
4. 按 digest 启动最终 API/Web/Runner 的 Compose 门禁；
5. API runtime 中治理文件与命令入口的逐项迁出边界。

本规格不批准施工，也不生成实施计划。S1 规格批准后，才能使用 `writing-plans` 形成独立实施计划。

## 目标与非目标

### 目标

- 让 Release 证据绑定实际源码、迁移、测试全集和最终发布物；
- 让数据库测试不再共享一个不可追溯的 `public` Schema；
- 让缺失数据库、漏选测试或条件性跳过直接阻断 Release；
- 将验收、迁移、修复和证据工具退出 API runtime；
- 对 DDL、DML、夹具和证据读取实行按命令最小权限；
- 为 S2 语义收敛和 S3 单一候选版本验收提供可信底座。

### 非目标

S1 不建设或修改：

- 常驻 Runner 服务、远程 Shell 或通用运维平台；
- 新应用 RBAC 权限码；
- 新业务模型、业务枚举、业务迁移或功能开关；
- 客户可见行为、应用 API 契约或领域语义；
- S2 的 Journey/领域权威修正；
- S3 的具体成熟订单夹具、Staging 数据修复或人工验收 Runbook；
- 脚本源码的最终删除；源码退役归 S4。

S1 可以改变发布、迁移、数据库测试和治理命令的运营行为，但不得借此改变业务行为。

## 当前实现基线

基线提交存在以下已核实现状：

- [CI](../../../.github/workflows/ci.yml) 使用 PostgreSQL 16，并让多套测试共享 `subscription_saas_test?schema=public`；
- [镜像流水线](../../../.github/workflows/docker-images.yml) 只构建 API 与 Web，没有 Runner 或统一构建证明；
- [API Dockerfile](../../../Dockerfile.api) 有 25 条 `/app/scripts` COPY 规则，并在 runtime 中验证 Prisma CLI；25 条 COPY 不等于 25 个独立命令；
- 两个脚本数据库测试在缺少数据库环境变量时使用条件性 `test.skip`；
- `/api/health` 只证明进程存活和存储配置，不访问数据库，不能证明数据库 readiness；
- 当前迁移会创建 `pgcrypto` 和 `btree_gist` 扩展，migration role 需要受控扩展安装能力，runtime-equivalent test role 不得因此成为 Schema owner。

这些事实只说明 S1 的必要性，不授权机械删除脚本、改写迁移或直接操作 Staging。

## 术语和信任边界

### 一次可信构建运行

一次受保护 CI 运行从同一个固定 checkout 构建 API、Web 和 Runner。内部可以并行构建，但最终聚合作业必须从 registry 解析实际 platform image digest，并生成唯一 `build-proof.v1`。

PR 临时运行可以产生镜像 digest 和测试证据，但不能获得“可提升”的可信构建证明。相同 tag、相同 source SHA 或相同镜像内容都不能替代受保护 CI 的信任根。

### Release bundle

Release bundle 是以下不可拆分集合：

- API image digest；
- Web image digest；
- Runner image digest；
- `build-proof.v1` 及其 digest。

Tag 只用于发现。Staging 和后续环境只允许按 digest 提升；禁止重新构建、使用 mutable tag 作为身份，或替换 bundle 中的单个镜像。Runner 变化也必须形成新的完整 bundle 和构建证明。

### 能力范围执行

执行范围分为：

- `full-rc`：完整候选版本提升与验收，必须验证并匹配 API、Web、Runner 三个镜像 digest；
- `migration-schema`：只执行迁移、Schema diff、checksum 或数据库 catalog 验证，只要求启动与该能力相关的 Runner，并验证同一 build proof 中的 API Schema、Runner、迁移目录和 repository contract；Web 不要求已经部署或启动。

两种范围都必须引用同一个完整 build proof，不能替换、重建或省略 bundle 的组成部分。`migration-schema` 只放宽“本次需要启动哪些制品”，不产生可提升的部分 bundle，也不能作为完整 RC 成功证明。执行证明必须记录 `executionScope`；命令注册表声明允许的 scope，运行参数不得扩大范围。

### 受信源码执行器

镜像构建前的数据库双链由受保护 CI 在固定 checkout 上使用受信源码执行器完成。该执行器：

- 只允许访问本次 CI 的临时 PostgreSQL 集群；
- 不持有 Staging/Production 或其他长期环境凭证；
- 使用与后续 Runner 命令相同的迁移目录、repository contract 和规范化结果 Schema；
- 只能输出 `source-gate-evidence.v1`，不能签发 build proof、Environment Manifest 或正式 execution proof。

最终镜像构建后，Runner 必须在 fresh 与 snapshot Compose 链重复执行迁移和 Schema 验证，并将规范化结果与对应 source-gate evidence 比较。源码执行器通过不能代替最终 Runner 验证。

### 可信启动方

可信启动方负责：

- 验证可信 CI 的证明来源或 attestation 引用；
- 从 registry 解析将要启动的实际 Runner platform digest；
- 在注入数据库凭证前，以受保护、只读且可验证的 launch attestation 把实际 digest 和目标意图交给 Runner；普通环境变量中的自报 digest 不能构成身份证明；
- 按执行策略禁止 entrypoint override、容器 exec、Docker socket 和绕过正式启动接口；
- 在 Runner 未产生证明时记录启动方终态。

拥有宿主 Docker 权限的人仍可能绕过容器内部约束，因此宿主级禁令必须由工作流权限和 policy-as-code 承担，不能宣称由 Runner 镜像自身保证。

### 规范化与 digest

所有证明和计划采用 RFC 8785 JSON Canonicalization Scheme 规范化，以 UTF-8 编码，并以 SHA-256 小写十六进制表示 digest。时间使用带 UTC 偏移的 RFC 3339 字符串；金额、数据库大整数和精确小数使用十进制字符串，避免不同 JSON number 实现产生歧义。

证明 Schema 必须有显式 `schemaVersion`。Schema 版本变化不允许静默兼容；读者只能接受注册的版本或显式迁移后的版本。

## 构建证明

### `build-proof.v1`

构建证明由 Runner 外部的最终 CI 聚合作业生成并固化。Runner 只能验证，不能自己签发再自己验证。

`identity` 包含：

- `schemaVersion`；
- API、Web、Runner 的 registry、platform 和 image digest；
- source SHA；
- migration catalog hash；
- repository contract digest。

`provenance` 包含：

- 生成时间；
- CI run 和 attestation 引用；
- 固定 checkout 身份；
- 基础镜像的声明 digest或实际 resolved digest；
- 构建器、外部 action 和依赖材料的固定版本或证明引用；
- registry 聚合作业读取实际 platform digest 的证据。

`identity` 与 `provenance` 都被最终 `build-proof.v1` digest 覆盖，但生成时间不构成制品身份。

三个镜像必须携带可读取的 OCI source revision，并与构建证明中的 source SHA 一致。Web 不得只依赖 deployment tag 表示版本。

### Migration catalog hash

Migration catalog 对按路径排序的迁移清单计算规范化 digest。每项至少包含相对路径、文件 SHA-256 和顺序。已应用迁移不得改写；checksum 不一致直接阻断构建或执行。

### Repository contract digest

Repository contract 对版本化契约目录计算 digest，至少覆盖：

- 构建证明、Manifest、`post-state-observation.v1`、执行证明和 source-gate evidence Schema；
- Runner 命令注册表；
- 数据库测试清单、发现规则和批准例外；
- snapshot sanitization contract；
- API runtime 允许内容和能力边界；
- 证明规范化算法及版本。

契约文件清单本身必须被纳入 digest，避免通过删除某个契约文件绕过门禁。

## Runner 边界

### 运行模型

Runner 是按任务启动、执行、输出证明后退出的一次性容器。正式接口只允许：

`runner execute <commandId>@<commandVersion>`

Runner 不提供受支持的任意 Shell、任意脚本路径、拼接 SQL 或 Docker 控制入口。镜像中即使因基础系统存在 `/bin/sh`，执行策略也必须拒绝 entrypoint override、容器 exec 和 Docker socket。

### 单一 capability

Runner 注册命令分为五类 capability：

| capability | 数据权限边界                       | 典型行为                                    |
| ---------- | ---------------------------------- | ------------------------------------------- |
| `verify`   | 只读 catalog/Schema/业务只读       | 版本、迁移、Schema、后置条件和身份验证      |
| `migrate`  | 受限 DDL、迁移表及批准的扩展安装   | fresh/forward migration、Schema convergence |
| `repair`   | 批准目标内的受控 DML               | 现有事实修复、退休或 backfill               |
| `fixture`  | 仅验收数据库的受控领域写入         | 通过领域夹具工厂建立完整来源事实            |
| `evidence` | 数据库只读，允许写受控证据输出目录 | 导出脱敏证据、计数和 digest                 |

每次调用只能获得一个 capability profile 对应的凭证。禁止向 Runner 注入包含多类权限的超级凭证。一个动作若同时需要 DDL 和业务 DML，必须拆成不同命令、不同凭证、不同 `operationId` 和不同执行证明，不得运行时提权。

五类 capability 协议和权限边界必须实现；只有存在 S1 范围内命令的 profile 才实际配置环境身份。S1 不因定义 `fixture` 协议而实现 S3 的具体业务夹具。

数据库生命周期还使用两个非应用 capability 的基础设施身份：

- `provisioner`：仅在批准的临时集群创建、授权和精确回收 database；
- `restore`：仅将批准的 sanitized snapshot 恢复到本次临时 database。

它们由可信启动方编排，不增加应用 RBAC 权限，也不得与 Runner 的五类凭证叠加。

## 命令注册表

每个正式命令必须在版本化注册表中声明：

- `commandId` 和 `commandVersion`；
- capability 类别和所需数据库角色；
- 数据影响等级：只读、DDL 或受控 DML；
- `approvalMode: none | ci-policy | human`；
- `allowedExecutionScopes: full-rc | migration-schema`；
- 允许环境、禁止环境和未声明环境的处理；
- 输入、计划和输出 Schema；
- 是否支持 dry-run、apply、replay 或 reconcile；
- 锁对象、固定锁顺序、事务边界、超时和取消行为；
- 幂等键、版本/CAS 条件、前置和后置条件；
- 证据 Schema、owner、保留原因和退出条件。

以下任一变化必须提升 `commandVersion`：

- 输入或计划 Schema；
- 数据影响范围；
- 锁顺序或事务边界；
- 幂等、取消或恢复行为；
- 后置条件或证据 Schema；
- 允许环境、execution scope 或 capability profile。

已经发布的 `commandId@version` 不得原地改变语义，只能增加新版本或标记退役。命令注册表进入 repository contract digest。

## 目标意图与连接前门禁

Runner 在取得原始凭证和连接数据库前必须依次验证：

1. 构建证明来自受信 CI；
2. 启动方 launch attestation 中由 registry 实际解析的 Runner digest 与 build proof 一致；Runner 拒绝只由普通环境变量提供的 digest；
3. `commandId@version` 存在且 capability 匹配；
4. 环境声明存在，禁止环境优先，未声明环境默认拒绝；
5. command 的允许环境包含目标环境；
6. 凭证使用 secret reference，而非原始连接串；
7. secret metadata 中的 hostname、database、TLS、环境类别和网络策略符合目标策略；
8. 单一 capability profile 与 secret reference 匹配。

任一项失败时 fail closed，不获取原始凭证、不连接数据库。可信启动方记录 `PREFLIGHT_REJECTED`，该记录不是 Runner 执行证明。

连接后，Runner 再读取并核对：

- 实际数据库和集群指纹；
- `current_database`、当前角色和允许 Schema；
- `server_version_num`；
- migration head、checksum 和 Schema 状态；
- ephemeral marker 或长期环境登记。

数据库身份按以下规范化对象计算 SHA-256：受信基础设施登记或本次 ephemeral marker 的 `clusterIdentityRefDigest`、`current_database`、`pg_database.oid`、`server_version_num`、TLS 状态和目标环境 ID。证明只保存最终 fingerprint 及非敏感环境 ID；原始 hostname、database 名和基础设施内部标识只在受控执行日志中短暂使用并脱敏。任一组成值变化都会产生新的数据库身份，不能沿用旧批准。

核对通过后，dry-run 才能冻结本次批准前基线 Environment Manifest。apply 和 replay/reconcile 复用该不可变基线，不重新生成审批身份。原始连接串、密码、token、手机号或客户标识不得进入 Manifest 或证明。

## 批准策略和执行状态机

### 按影响等级分流

- `verify/evidence`：执行、后置条件和证明，不使用 apply/replay；具体命令可以是 `none` 或更严格策略；
- CI 临时数据库上的 `migrate/fixture`：可以使用受保护的 `ci-policy`；
- Staging 或其他非一次性环境的 DDL/DML：必须 `human`；
- 非一次性验收数据库上的 `repair`：必须 `human`。

`human` 才要求人工批准记录；`ci-policy` 必须引用受保护工作流和策略版本。命令注册表不能以运行参数降低既定 approval mode。

### Dry-run 和 apply

受控写命令的 dry-run 计划必须确定性生成，不含时间戳、随机 ID 或无序集合。`planDigest` 至少绑定：

- 输入参数和输入证据 digest；
- 目标对象集合；
- 预期逐表写入范围；
- 关键前后状态；
- 命令版本、数据库身份、基线 Manifest identity digest 和完整 Manifest digest。

批准策略绑定 build proof、基线 Manifest identity/full digest、数据库身份、命令版本和 `planDigest`。

apply 不生成新的基线 Manifest。它必须在声明的锁和事务边界内重新读取并核对基线 identity 字段、重新计算计划，并要求新 plan digest 与已批准值一致。无法全程锁定的对象必须通过版本或 CAS 防止 TOCTOU。任何输入、目标、角色、数据库身份、基线字段或计划变化都必须重新 dry-run 和批准。

apply 合法改变的 migration head、Schema、数据状态和配置观测进入独立 `post-state-observation.v1`，不反向改写基线 Manifest。证明生成顺序固定为：

1. post-state observation 记录 `operationId`、attempt/run ID、基线 Manifest identity/full digest、command ID/version、plan digest、数据库身份以及预期/实际后置条件；它不得引用尚未生成的 execution proof digest；
2. 对规范化的 post-state observation 计算 digest 并完成可信保管；
3. 生成 execution proof，并由它引用 post-state observation digest；
4. 后续 replay/reconcile 和 Release 聚合引用 execution proof digest，并可沿该 proof 查到 post-state observation digest。

该顺序是单向内容寻址链；post-state observation 与 execution proof 不得互相按 digest 引用。

### 中断与不确定终态

执行终态包括：

- `PREFLIGHT_REJECTED`：连接前由启动方记录；
- `SUCCEEDED`：Runner 完成并验证后置条件；
- `FAILED`：Runner 可确定失败且输出证明；
- `INTERRUPTED_UNKNOWN`：进程丢失或提交结果不明，由启动方记录。

`INTERRUPTED_UNKNOWN` 下禁止重新 apply。只能使用相同幂等键调用注册的 reconcile/replay，通过数据库事实和后置条件判定最终结果。reconcile/replay 必须同时引用批准前基线 Manifest、前序 execution proof 和已有 post-state observation；若前序 post-state 缺失，则以数据库事实生成恢复观测并与原计划后置条件核对。

dry-run、apply、replay/reconcile 分别生成执行证明，使用相同 `operationId` 和前序 proof digest 串联。旧失败或未知证明不可覆盖、删除或改写。

## 夹具和修复约束

Fixture 命令只能调用注册的领域夹具工厂，并记录夹具规格版本、输入指纹和结果 digest。夹具必须建立完整、可验证的来源事实集合；禁止：

- 直接覆盖 Journey 状态；
- 只修改一个日期来伪造时间经过；
- 绕过领域不变量执行任意 SQL；
- 在非验收数据库使用 fixture capability。

Repair 命令必须绑定：

`同一 build proof + 同一基线 Manifest + 同一数据库身份 + 同一 dry-run plan digest + 同一批准策略记录`

任一项变化都要求重新 dry-run。修复不能跨批准目标扩大 DML 范围，也不能把合同变更 bootstrap 等 S0 排除能力带入 Stage 1 基础验收。

## 证明分层

### Source-gate evidence

镜像构建前的源码和数据库测试门禁输出 `source-gate-evidence.v1`。它不是正式 Runner 执行证明，不声称绑定 Runner digest。至少包含：

- source SHA；
- migration catalog hash；
- repository contract digest；
- 数据库测试清单和发现规则 digest；
- PostgreSQL image digest 与 `server_version_num`；
- fresh/snapshot 链标识；
- 完整测试执行等式和终态；
- Schema diff、迁移状态和脱敏日志 digest；
- CI run/provenance 引用。

### Environment Manifest

受控写命令的 dry-run 在连接后核对通过时生成并冻结 `baseline-environment-manifest.v1`。Manifest 分为：

`identity`：

- `schemaVersion` 和 environment class；
- build-proof digest；
- source、migration catalog 和 repository contract digest；
- 目标策略引用和 secret reference 指纹；
- 数据库不可逆身份指纹、数据库名指纹、角色和 Schema；
- PostgreSQL 版本、批准前 migration head 和批准前 Schema digest；
- 环境开关的非敏感配置指纹。

`provenance`：

- 生成时间；
- 启动方和 launch attestation 引用；
- Manifest 生成工具版本和执行 run 引用。

分别计算 `manifestIdentityDigest` 和覆盖 identity/provenance 的完整 `manifestDigest`。批准记录同时绑定两者；apply 复用原始 Manifest，并重新核对 identity，不因重新读取当前时间生成新 digest。

apply 后先生成独立 `post-state-observation.v1`，记录新的 migration head、Schema digest、配置观测、数据库身份、后置条件以及本次 operation/attempt、command 和 plan 身份，不引用 execution proof digest。完成 observation digest 后再生成引用它的 execution proof。replay/reconcile 引用原基线 Manifest、前序 execution proof digest 和由该 proof 引用的 post-state observation digest，不把合法 post-state 当作基线漂移。

只读 `verify/evidence` 命令可以为单次执行生成自己的 Manifest 和 post-state observation，但不使用 apply/replay。Manifest 不进入 build proof。fresh 与 snapshot 必须分别生成独立基线 Manifest、post-state observation 和证明，不能共用。

### Execution proof

最终 Runner 在 Compose 或环境执行中输出 `execution-proof.v1`，至少包含：

- `operationId`、阶段、前序 proof digest 和终态；
- build-proof、基线 Manifest identity/full digest 和 execution scope；
- command ID/version、capability 和 approval mode；
- 数据库身份、输入、计划和输出 digest；
- 后置条件结果和 post-state observation digest；
- 开始/完成时间、版本信息和脱敏错误分类；
- 启动方、策略和批准引用。

fresh 与 snapshot 使用不同数据库身份、`operationId` 和执行证明。

### Release 聚合证明

Release 聚合证明同时引用：

- build proof；
- fresh/snapshot 的 source-gate evidence；
- fresh/snapshot 的 Environment Manifest、post-state observation 和 execution proof；
- API/Web/Runner Compose、API readiness 和 Web 真实客户端证据。

聚合时必须验证 source SHA、migration catalog、repository contract、测试清单和 snapshot 版本一致。不同输入版本的成功证明不得拼接。

## 证据保管协议

### 可信存储

所有证明、Manifest、post-state observation、启动方记录、脱敏日志和聚合索引必须进入受控、按内容寻址且在保留期内不可改写的制品存储。普通 Runner 文件系统、临时 CI workspace、控制台输出或数据库本身都不是可信证据存储。

上传协议固定为：

1. 在产生方计算规范化 digest 和大小；
2. 以 digest 作为不可覆盖对象身份上传；
3. 存储端返回包含对象身份、大小、时间和保留策略的 receipt；
4. 独立回读对象或可信存储元数据，重新验证 digest 和大小；
5. 将 receipt digest 写入后续证明或 Release 聚合索引。

只有上传、receipt 和回读校验全部成功，证据才进入 `CUSTODY_CONFIRMED`。临时数据库只能在所需证据全部 `CUSTODY_CONFIRMED` 后回收；Release 聚合也只能引用已确认保管的对象。上传失败不得通过复制控制台文本人工补签。

### Owner、访问和脱敏责任

| 证据类别                                                 | owner              | 写入者                                 | 读取权限                                    |
| -------------------------------------------------------- | ------------------ | -------------------------------------- | ------------------------------------------- |
| build proof、source-gate evidence、Release 聚合          | Release 工程负责人 | 受保护 CI 身份                         | Release、QA、安全和审计只读                 |
| launch attestation、Manifest、execution/post-state proof | 数据库发布负责人   | 可信启动方和对应单 capability Runner   | Release、数据库发布、安全和审计只读         |
| snapshot、sanitization、owner mapping 和 ownership proof | 数据治理负责人     | 受控脱敏流水线、restore/provision 身份 | 数据治理、Release、安全和审计按最小范围只读 |
| Web 网络、API readiness、Compose 和工具版本证据          | Release 验证负责人 | 受保护 CI/真实客户端验证身份           | Release、QA、安全和审计只读                 |

各 owner 负责访问复核、脱敏规则和到期处置。写入身份不能覆盖既有 digest 对象，也不能删除保留期内记录；人工批准者不自动获得原始日志或 snapshot 读取权限。

### 保留期和到期处置

- 执行、失败、`PREFLIGHT_REJECTED` 和 `INTERRUPTED_UNKNOWN` 证明默认保留 180 日；
- active bundle 的 build proof、Release 聚合及其必需引用至少保留到 bundle 退出所有环境后 180 日；
- snapshot 及其 sanitization/ownership 证明至少保留到 snapshot 失效后 180 日；
- 法务、合规或事故调查需要延长时，必须有独立 legal hold/retention 批准。

“不可覆盖”只表示批准保留期内的内容不可变，不等于永久保存。到期后由 owner 按批准策略安全删除或转入更长期合规存储，并生成删除/转存 receipt；是否永久保留必须另行审批。失败和 UNKNOWN 证明与成功证明使用相同保管、访问和到期规则。

## Release 数据库测试发现全集

### 候选发现规则

数据库测试候选全集是以下规则的并集：

- 文件名匹配已登记的 integration、e2e、postgres 或 schema 数据库模式；
- 导入或初始化 Prisma、`pg`、数据库 repository/client 或数据库测试 helper；
- 读取 `DATABASE_URL` 或其他数据库测试环境变量；
- 使用显式数据库测试标签。

发现规则必须版本化。每个候选文件必须：

- 进入 Release 数据库测试清单；或
- 登记为例外，并包含 owner、原因、适用范围和复核日期。

未分类候选直接失败。清单、发现规则和例外共同进入 repository contract digest。纯类型导入或完全 mock 的单元测试如被发现，也必须通过例外登记说明，而不能静默忽略。

### 测试清单

每个套件至少声明：

- suite ID、测试文件和清单版本；
- fresh、snapshot 或两者的适用性；
- 所需迁移、夹具和数据库角色；
- 是否可并行、允许的 shard 数和明确串行原因；
- 超时、并发 barrier 和数据库时间要求；
- 外部供应商依赖拆分状态。

未执行某条升级链必须有独立批准的 N/A；不能默认“不适用”。同时依赖数据库和外部供应商的测试必须拆成数据库契约测试与外部验证，不能因缺少供应商凭证排除数据库不变量。

## 数据库身份与隔离

### PostgreSQL 基线

Release 数据库门禁统一使用按 digest 固定的 PostgreSQL 17，并记录实际 `server_version_num`。基础镜像 digest 或 registry resolved digest 进入 source-gate evidence 和 provenance。

### 角色分离

| 角色                      | 允许能力                                          | 明确禁止                                           |
| ------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `provisioner`             | 创建、授权、精确回收本次临时 database             | 业务查询、迁移、前缀批量删除                       |
| `restore`                 | 向批准的空临时 database 恢复 sanitized snapshot   | 访问原始 Staging、创建其他 database                |
| `migration role`          | 拥有目标 Schema、执行迁移和批准的数据库级扩展     | `SUPERUSER`、`CREATEDB`、跨目标修改                |
| `runtime-equivalent test` | 使用与应用运行时等价的 DML/查询权限执行数据库测试 | `SUPERUSER`、`CREATEDB`、`BYPASSRLS`、Schema owner |
| `verify`                  | 只读 catalog、迁移状态、Schema diff 和后置条件    | DDL、业务 DML                                      |

快照恢复若需要额外权限，只能使用独立 restore profile。测试不得借用 migration role 掩盖运行时权限缺口。

### Snapshot ownership normalization

Sanitized snapshot 必须携带版本化 owner mapping，列出源 owner 到目标 owner 的允许映射。恢复协议固定为：

1. provisioner 创建目标 database、migration role、runtime-equivalent test role 和只服务本次恢复的 restore executor；
2. dump 不恢复源环境 owner/ACL，等价使用 `--no-owner --no-acl`；
3. restore executor 只在本次目标 database 内获得临时、可审计的 `SET ROLE migration_role` 能力，使新建 Schema、表、序列、函数、类型和 `_prisma_migrations` 直接归 migration role；
4. 恢复结束后运行 ownership inventory，逐类验证对象 owner 与 owner mapping 一致，拒绝未知 owner、跨目标对象和 runtime-equivalent test role ownership；
5. provisioner 在迁移前撤销 restore executor 对 migration role 的临时成员关系并吊销 restore 凭证；
6. migration role 重新连接并验证自己拥有目标 Schema、迁移表及迁移需管理的对象；runtime-equivalent test role 只获得已批准运行时权限；
7. ownership normalization proof 上传并确认后，才允许开始前向迁移。

Restore 和 ownership normalization 不得使用 `SUPERUSER`、跨 database owner 修改或未知 cluster-global 权限。无法按 owner mapping 交接的 snapshot 直接失效，不能通过临时提升 migration/runtime 角色绕过。

### 隔离单位

默认每个测试套件或并行 shard 使用独立 database 和独立 runtime-equivalent test role。只有证明迁移、扩展、Raw SQL、搜索路径和数据库级对象完全 Schema-safe 后，单个套件才能申请唯一 Schema 隔离。

整个体系不得依赖单 worker。明确验证串行语义的场景可以登记原因并串行运行；并发测试使用确定性 barrier 和数据库时间，不用随机 sleep 证明竞态。

若迁移创建或修改 role、database、tablespace 等 cluster-global 对象，必须改用独立 PostgreSQL cluster，或由 Release 迁移契约明确禁止。数据库级扩展由 migration role 在独立 database 内受控创建，不赋予测试角色 owner 权限。

## 双升级证据链

本节描述镜像构建前由受信源码执行器运行的 source-gate 双链；它们只生成 source-gate evidence。最终镜像构建后，Compose 门禁必须使用同一 build proof 中的 Runner 重新执行等价的迁移、ownership 和 Schema 验证，并对比规范化结果。

### Fresh 链

1. provisioner 在批准临时集群创建精确命名 database 和 ephemeral marker；
2. migration role 从零执行全部迁移；
3. verify role 检查 checksum、migration status 和 Schema diff；
4. runtime-equivalent test role 执行清单适用测试；
5. 输出 source-gate evidence；
6. 证明完成可信保管后精确回收 database。

### Sanitized snapshot 链

1. 校验 snapshot artifact、sanitization contract 和失效时间；
2. provisioner 创建独立空 database 和 ephemeral marker；
3. restore profile 按 owner mapping 恢复最终脱敏制品；
4. 执行 ownership inventory，撤销 restore 临时成员关系和凭证，确认 migration role 为目标 owner；
5. migration role 执行前向迁移；
6. verify role 执行 checksum、migration status 和 Schema diff；
7. runtime-equivalent test role 执行清单适用测试；
8. 输出独立 source-gate evidence；
9. 证明完成可信保管后精确回收 database。

### Snapshot sanitization contract

快照必须绑定版本化 sanitization contract，并记录：

- 来源 Schema 和 migration head；
- 生成流水线和工具版本；
- sanitization contract digest；
- owner mapping digest 和 ownership normalization contract 版本；
- 自动敏感字段和秘密扫描结果；
- 创建时间、owner、复核日期和失效时间；
- 存储位置、访问策略和 artifact digest。

过期或扫描不通过的快照不得进入 Release CI。原始 Staging 数据不得经过普通 CI artifact；脱敏只能在受控边界完成，普通 CI 只读取最终不可变制品。

## 零跳过完整执行等式

每条数据库测试链必须满足：

`collected = selected = executed = passed + failed`

并且：

- `failed=0`；
- `skipped=0`；
- `todo=0`；
- `filtered=0`；
- `cancelled=0`。

禁止 `.only`、条件性 `test.skip`、条件 suite 选择、隐式回退数据库 URL和 fail-fast 导致的未执行测试。缺少数据库身份、迁移失败、发现全集与清单不一致或测试未枚举时直接失败。

供应商、浏览器和人工场景不进入数据库测试计数，必须在独立适用性登记中标记为：

- 必须自动化；
- 必须外部验证；
- 必须人工验证；
- 有审批的 N/A。

N/A 必须有 owner、原因、适用版本和复核日期，不能重新包装为 skip。

## Provision 与回收安全

Provision 和 cleanup 前必须验证：

- 目标是批准的临时集群身份；
- 存在本次 CI 生成且与 run ID 匹配的 ephemeral marker；
- database 名与本次运行记录完全一致；
- hostname、TLS 和环境类别符合临时目标策略；
- 目标不是 production、Staging 或未知集群。

回收只接受精确 database 名，不接受通配符、前缀批量删除或运行时拼接的删除清单。必须先完成测试证明的可信保管和 digest 回读确认再回收；保管失败时不得清理数据库，改为保留 ephemeral marker、限制访问并进入有时限的基础设施处置。回收失败视为基础设施失败并保留目标指纹和人工处置记录。

## 五阶段 Release CI

### 阶段 1：源码契约门禁

- 固定 checkout；
- 计算 migration catalog 和 repository contract digest；
- 执行静态检查和数据库测试发现；
- 拒绝 `.only`、未分类候选和未批准例外；
- 固化测试清单 digest。

### 阶段 2：数据库双链门禁

- 受信源码执行器在固定 PostgreSQL 17 digest 上运行 fresh 与 snapshot；
- 使用分离身份；
- 验证完整执行等式、Schema diff 和迁移状态；
- 分别输出 source-gate evidence。

阶段 1、2 在镜像构建前发生，不能输出绑定 Runner digest 的正式执行证明，也不能操作候选或长期环境。

### 阶段 3：一次可信构建运行

- 可以并行构建 API、Web、Runner；
- 三个镜像都携带 OCI source revision；
- 基础镜像、构建器、action 和依赖材料固定或进入 provenance；
- 最终聚合作业只读取 registry 实际解析出的 platform image digest；
- 生成外部 `build-proof.v1`。

### 阶段 4：最终发布物 Compose 门禁

Compose 不允许 build、mutable tag、source mount、entrypoint override、容器 exec 或 Docker socket。fresh 与 snapshot 分别执行：

1. 可信启动方验证 build proof 和实际 Runner digest；
2. provisioner/restore 准备独立数据库；
3. Runner 使用 migration profile 冻结基线 Manifest、完成迁移、输出 post-state observation 后退出；
4. Runner 使用 verify profile 执行真实 Prisma、`psql`、Schema diff 和数据库身份核对后退出；
5. API 使用真正 runtime identity 启动；
6. `/api/health` 仅作为 liveness；另调用现有只读 `GET /api/portal/catalog/model-definitions`，证明 API 实际完成数据库查询；
7. Web health 通过；
8. 无头浏览器或等价真实客户端执行 Web 产物的请求逻辑，捕获请求目标；
9. 对比实际请求目标、Web 内嵌 API Base 和 Environment Manifest；验证路径与 CORS；
10. 记录 Runner 内 Node、Prisma、`psql` 和数据库 `server_version_num`；
11. 将 migration/Schema 规范化结果与同一 source SHA 的 source-gate evidence 对比；
12. 输出该链独立的基线 Manifest、post-state observation、`operationId` 和 execution proof。

该门禁只验证连通性和构建配置；视觉和人工业务验收仍归 S3。

### 阶段 5：Release 聚合门禁

以 `full-rc` scope 聚合并核对：

- build proof；
- fresh/snapshot source-gate evidence；
- fresh/snapshot 基线 Manifest、post-state observation 和 execution proof；
- API/Web/Runner digest、OCI revision 和 Compose 证据；
- 数据库测试计数、Schema diff、API readiness 和 Web 请求证据。

任一必需证据缺失、输入 digest 不一致或终态非成功，本次验证尝试不可提升。

### 合法重试

基础设施或阶段失败后，允许对相同不可变 bundle 重新运行完整失败阶段，但必须：

- 使用新的 run/operation ID 和执行证明；
- 保留原失败或 UNKNOWN 证明；
- 不覆盖、删除或修改旧证明；
- Release 聚合只选择同一 build proof、contract digest、测试清单和 snapshot 版本的一组成功证明。

禁止替换单个镜像、修改旧证明或拼接不同输入版本的证据。失败不会永久污染 bundle；该次失败尝试在批准保留期内不可覆盖，并与成功证明采用相同保管规则，不自动永久保存。

## 负向门禁责任

### Runner 连接前负责

- build proof 或 Runner digest 不匹配；
- command/version 不存在；
- 环境未声明、被禁止或目标策略不匹配；
- capability 与 secret reference 不匹配；
- 提供原始连接串而不是 secret reference。

### 可信启动方和 policy-as-code 负责

- mutable tag、混合 source SHA 或非 registry digest；
- entrypoint override、容器 exec、Docker socket；
- 绕过正式启动接口调用 Docker；
- PR 临时制品被错误标记为可提升；
- Compose/runtime spec 含 source mount 或额外 capability。

### Web 门禁负责

- Web 内嵌 API Base 与 Manifest 不一致；
- 实际请求未从公共 API Base 发出；
- 请求命中错误 API、路径错误或 CORS 失败。

## API runtime 工具迁出

### 双向盘点矩阵

25 条 COPY 规则不能作为迁移完成单位。S1 必须建立两张互相可追溯的矩阵：

`镜像文件 → 依赖它的命令/运行时消费者 → 处置决定`

`命令入口 → 完整依赖闭包 → 当前调用方 → Runner commandId@version`

盘点覆盖 package scripts、CI、Runbook、Compose、部署配置、人工操作、外部自动化和 API 运行时内部调用。所有 COPY 文件必须有去向，所有可执行入口必须登记。

### 处置类别

每个文件和命令只能进入以下一种决定：

- 正式应用运行能力：改为明确应用模块并保留批准的 runtime 依赖；
- Runner 注册命令：迁移到封闭 `commandId@version`；
- 仅保留源码：不再是 Release/Staging 可执行入口；
- 待 S4 退役：S1 先退出 API runtime，源码后续决定。

“仅保留源码”必须同时满足：

- 不复制进 API 镜像；
- 不保留可用于 Release/Staging 的 package script、Runbook 或 CI 入口；
- 允许单元测试或 Runner adapter 引用核心模块；
- 正式环境只能通过注册 Runner 命令执行。

迁移过渡期可以同时打包旧、新实现，但写命令只能有一个获得 capability 凭证和批准的活动入口，禁止双执行。

### 行为等价

行为等价不要求字节级输出一致。每个命令必须定义规范化语义契约，并在来自同一基线的两个独立数据库分别运行旧入口和 Runner 后比较：

- 目标集合和逐表影响；
- 事务、锁顺序和幂等结果；
- dry-run 计划和后置条件；
- 业务审计事实；
- 退出状态和错误分类；
- 超时、取消和故障注入结果；
- replay 后无重复副作用。

两个写入口不得在同一数据库顺序运行。Runner 增加的证明信封不参与旧输出的字节比较，但证明中的规范化业务结果必须与语义契约一致。

### 调用方切换证明

“零调用方”必须同时覆盖：

- 仓库引用和 package scripts；
- CI、Compose、Runbook 和部署配置；
- 最终镜像文件清单或 SBOM；
- 外部自动化 owner 的迁移签字；
- 人工操作入口关闭记录；
- 旧入口无法取得有效 capability credential 的负向测试。

启动日志只作补充证据，不能证明低频人工或应急入口已经退出。

### API 镜像允许边界

API runtime 采用允许内容和能力边界，不只依赖脚本名称黑名单：

- 治理 `/scripts` 入口不存在；
- Prisma CLI、`psql` 和其他非运行必需治理工具不可执行；
- 不存在可调用任意治理脚本的 package entry；
- 允许 Prisma Client、迁移元数据读取所需的已批准资产和正式应用运行依赖；
- 允许清单本身进入 repository contract digest，并以最终镜像负向测试防止回归。

Prisma CLI 只有在依赖盘点证明 API 正式运行确实需要时才能保留；“曾由 Dockerfile 验证存在”不能作为保留理由。

## 回滚矩阵

每个 Runner 写命令必须登记命令级回滚策略：

| 情况               | 合法处理                                                             |
| ------------------ | -------------------------------------------------------------------- |
| 未发生数据库变更   | 安全终止，保留失败证明                                               |
| 结果确定或可查询   | 使用同一幂等键 reconcile/replay                                      |
| 仅应用制品回滚     | 必须证明旧 API 与当前 Schema 向后兼容，并按完整 bundle 回滚          |
| 数据库提交结果未知 | 标记 `INTERRUPTED_UNKNOWN`，禁止 apply，只允许注册恢复命令           |
| 数据库恢复         | 最后手段；停止写入、声明数据丢失窗口、验证恢复能力并取得独立人工批准 |

已应用迁移不得改写。不能为了恢复旧 API 脚本而逆向修改迁移历史，也不能在同一 RC 中把旧 API 脚本当作应急后门。

## S1 后续实施计划拆分约束

S1 规格批准后，实施计划至少拆成可独立评审的工作流，而不是预设三个大 PR：

1. 数据库测试发现、清单与隔离基础设施；
2. 逐套迁移数据库测试和完整计数门禁；
3. sanitized snapshot contract、ownership normalization 与双升级链；
4. Runner 镜像、命令注册表和 capability 边界；
5. 构建证明、基线 Manifest、post-state、执行证明和证据保管；
6. 最终镜像 Compose 与真实 Web/API 门禁；
7. API runtime 双向盘点和逐命令迁出。

具体 PR 数量由实施计划按风险和变更规模拆分。不得把上述七项压缩成单个大爆炸提交。

## S1 完成门槛

S1 只有在以下条件全部满足时才能关闭：

- release bundle、可信构建运行和信任根通过正向及负向验证；
- `full-rc` 与 `migration-schema` scope 都从同一完整 build proof 执行，且 scoped 操作不能生成可提升的部分 bundle；
- 五类 capability 协议和权限边界实现；只为 S1 实际命令配置身份；
- 命令注册表不可变版本规则、批准策略、TOCTOU 防护和 UNKNOWN 恢复通过验证；
- 受信源码执行器只操作临时数据库，其 source-gate 结果已由最终 Runner 等价复核；
- source-gate evidence、build proof、基线 Manifest、post-state observation 和 execution proof 分层清晰并可复核；
- 数据库测试发现全集、例外、双升级链和完整执行等式通过；
- PostgreSQL 17 digest、实际版本、角色隔离、snapshot ownership normalization 和精确回收证据齐备；
- API/Web/Runner 按 digest 分别通过 fresh 和 snapshot Compose；
- API 数据库 readiness 和 Web 真实客户端公共 API 请求通过；
- API runtime 的双向矩阵完整，已迁出治理入口具备零调用方证明；
- API 镜像不包含治理 `/scripts`、非必要 Prisma CLI、`psql` 或任意治理入口；
- 所有必需证据完成可信上传、receipt、digest 回读确认，并具有 owner、访问控制和与 S0 对齐的保留/到期处置；
- 所有证明、日志和 Manifest 不含秘密、原始连接串或客户敏感数据；
- S1 没有改变客户可见行为、应用 API 契约或领域语义。

## S1 停止条件

出现以下任一情况时停止 S1 并返回规格或实施计划修订：

- Runner 需要任意 Shell、Docker socket 或多 capability 超级凭证；
- 构建证明由 Runner 自签发、自验证，或只依赖 tag/source SHA；
- scoped migration/schema 操作脱离完整 build proof、替换 bundle 组成或被当作可提升部分 bundle；
- 受信源码执行器持有长期环境凭证，或 source-gate evidence 没有被最终 Runner 等价复核；
- 数据库测试仍共享未知数据库、存在 framework skip 或发现全集未分类；
- fresh/snapshot 证据共用基线 Manifest、post-state、数据库身份或 `operationId`；
- apply 重新生成基线 Manifest，或合法 post-state 被当作审批身份漂移；
- apply 不重新计算计划，或无法通过锁/CAS 防止 TOCTOU；
- snapshot 恢复后存在未知 owner、restore 凭证未撤销或 runtime-equivalent test role 成为对象 owner；
- 旧 API 写入口和 Runner 写入口可以同时获得凭证；
- 为了迁出脚本而改变业务 API、领域语义、已应用迁移或客户数据；
- 证明可以被覆盖、不同输入版本可以被拼接，或秘密进入日志；
- 临时数据库在证据进入可信存储并完成 digest 回读前被回收，或证明没有 owner/保留期；
- 任一 P1 未闭环但准备启动 S2/S3。

S1 关闭前，S2 规格可以阅读已批准的 S0 权威模型，但不得生成实施计划或施工；S3 继续保持阻断。
