# Stage 1 主线执行索引

状态：P0 已完成；P1.0 旧目标已获明确授权、完成退役并通过独立审查。P1.1–P1.5 已有本轮实际通过证据：控制脚本单测 41/41、API 单测 4074/4074、五项主线 fresh suite 104/104；126 条迁移、status、diff、validate 均通过。P1.6 新目标回收尚未执行，等待新的 owner 停用窗口；完整 P1 仍未关闭。真实副本、候选全量/双链、固定 Node22 最终制品、供应商、浏览器及 Stage 1 人工验收均未执行。

范围：A/B进件—审核—方案/预约—单次确认—签约归档—主动支付/核销—交付激活—账单/催收—无争议正常结束。

历史代码基线：Task 5 `1f0b0439`。Task 6 提案保管：`457c0011`，不代表批准。
Task 6/29R/30/I 系列冻结，Task 30 stash 不变。
执行入口：[P0/P1 准入实施计划](../superpowers/plans/2026-09-06-stage1-p0-p1-admission-implementation-plan.md)。

| 项目                                     | 初始状态          | 证据/限制                                                                                                                                                                                                        |
| ---------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本轮执行 SHA、批准引用、日期、stash 指纹 | P0.1 已实际记录   | SHA `645c89277d60d50bbdbba0e8bc6456e42cba5ab1`；本对话用户批准 `645c8927`（P0 可按序执行；P1 技术计划获批；P1.0 实际退役另行授权）；2026-09-06 14:02:33 +08:00；stash `b299ceeed80374d181998f8ef485629beba56b5f` |
| 两项人工决定                             | 口径已对齐        | 非业务验收；`FINAL_PLAN_DECISION`、`DELIVERY_EVIDENCE_DECISION`；车辆分配不另加内部批准                                                                                                                          |
| PG17 身份/迁移状态                       | 本地开发自检通过  | 新 PG170011；126 条迁移全部应用、status 最新；migrate 身份自检，不是独立只读 verify 或候选证明                                                                                                                   |
| Schema validate / 实际 DB diff           | 分别通过          | 源码 validate exit0；受控新库实际 diff exit0/无差异，原件及 checkpoint 分别保留                                                                                                                                  |
| API unit / 五项主线 DB suite             | 本地执行通过      | 303 文件/4074 单测；五套 fresh 共104项，全部执行/通过且 report/custody 读回；非候选全量或 snapshot 证明                                                                                                          |
| 合法副本及读取/使用授权                  | INPUT_UNAVAILABLE | 用户此前确认“尚未准备”；本轮已再次询问受控元数据索引，尚无新材料。未搜索秘密、下载副本或触发导出                                                                                                                 |
| WSL/LUKS/宿主分页/备份排除               | NOT_VERIFIED      | 不等于已允许获取数据                                                                                                                                                                                             |
| 唯一可信 CI build proof                  | NOT_RUN           | R1/A2，不创建本地候选替代                                                                                                                                                                                        |
| 人工 launch authorization                | NOT_IMPLEMENTED   | R1/R2                                                                                                                                                                                                            |
| Admin/Portal 浏览器                      | NOT_RUN           | A1/A3                                                                                                                                                                                                            |
| 电子签/主动支付/通知                     | NOT_RUN           | 外部验证独立登记                                                                                                                                                                                                 |
| 成熟正常结束/两次有效维护                | NOT_RUN           | B5/B6/A1/A3                                                                                                                                                                                                      |
| Stage 1 签字                             | BLOCKED           | 以上实际验收条件未完成                                                                                                                                                                                           |

## P0 静态/单元门禁证据

运行 SHA：`645c89277d60d50bbdbba0e8bc6456e42cba5ab1`。最终门禁运行窗口：2026-09-06 14:13:13–14:13:24 +08:00。

| 命令                                                                                                                                                                                                                   | exit | 结果                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0.2 文档契约 PowerShell 断言                                                                                                                                                                                          |    0 | `P0_DOCUMENT_CONTRACT_PASS`；`stage1LegacyCount=0`，六条 applicability 记录各一次，两项人工决定的五个计数及“两个 ManualTask”证据条目各一次                                     |
| `pnpm release:contracts:verify`                                                                                                                                                                                        |    0 | 159 个 repository contract 文件、59 个 Schema、13 个 command contract、126 条 migration；当前 digest `sha256:6388e7018f81ad6a46d7d53e96f9ec0e8827e86473e95112f0fd79c2d5410b6a` |
| `pnpm release:database-tests:discover`                                                                                                                                                                                 |    0 | `candidateCount=92`、`manifestedCount=36`、`exceptedCount=56`、`unclassifiedCount=0`；这是测试目录分类/适用性发现，不是执行数据库测试                                          |
| `node --test scripts/stage1-golden-path-production-preflight.test.mjs`                                                                                                                                                 |    0 | 14/14 passed，0 failed，0 cancelled，0 skipped，0 todo；这是无外部副作用的单元测试，没有运行同名 production preflight                                                          |
| `pnpm exec prettier --write docs/acceptance/2026-09-06-stage1-mainline-execution-index.md docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md release/contracts/external-validation-applicability.v1.json` |    0 | 三文件格式化完成                                                                                                                                                               |
| `git diff --check`                                                                                                                                                                                                     |    0 | 无输出                                                                                                                                                                         |

repository contract digest 从 HEAD blob 基线 `sha256:f9dc8a91e137aaeebef86fed53af744a3cdbb13cf44a35f5dd07161441f85be5` 变为 `sha256:6388e7018f81ad6a46d7d53e96f9ec0e8827e86473e95112f0fd79c2d5410b6a`。主控按现有 catalog identity/RFC 8785 算法只读复算 159 个 HEAD Git blobs 并逐项对比；只有 `external-validation-applicability.v1.json` 的字节 hash 改变，已排除换行差异。后续候选必须重新生成可信 `build-proof.v1`。

私密原件只记录受控索引和脱敏 digest；不入库原始 URL、凭证、客户/订单标识或合同。

每次运行记录：执行 SHA、命令、时间、精确退出码、测试计数、非秘密目标身份、原件位置/digest、失败阶段、下一责任包。没有输出就保留 NOT_RUN，不根据历史测试数填通过。

## P0.7 只读材料盘点（2026-09-06）

P0 提交后由独立子 agent 盘点，主控只读复核报告并单独合入索引。WSL 已注册 `Ubuntu`、`docker-desktop` 两个 WSL2；专用 `stage1-snapshot-local` 未注册。宿主 `wsl.exe`/`openssl.exe` 存在，宿主 `cryptsetup.exe` 不存在；没有启动发行版或执行 guest 命令，不能据此判断 guest 工具状态。

`.wslconfig` 不存在；有效 swap/guest swap0、per-input LUKS、备份排除仍为 NOT_VERIFIED。宿主自动分页已启用且有活动 pagefile，休眠能力和 crash dump 配置存在；这些观察不证明私密输入保护合规。没有安装、配置、挂载、生成密钥或读取 payload，R3 输入授权未获得。

只读报告原件（本 worktree 相对路径）：`.superpowers/sdd/2026-09-06-stage1-p0-p1-admission-implementation-plan/task-P0-inventory-report.md`；SHA256 `5b5e3fa5d61adb9a2c28fb5f3b640d5805bc0fbde9b61009c81f4a1a15ecb314`。报告记录具体命令和退出码；10 次盘点调用及 2 次辅助调用全部 exit0，包含两次 WSL 输出编码规范化的只读复跑，不是 12 项合规门禁。

P0 主控门禁记录：同目录 `task-P0-controller-verification.md`；SHA256 `0a00f92b0f2e4ba0b5ddab3df781643acfe233f2bd6463c69e52533103c0cb97`。上述本地记录不是可信发布证明。

## P1.0 只读核查与原批准停止点（历史）

运行 SHA：`debc3ad21ba3684022274f198d81c55b6e09c1ac`。2026-09-06 14:18–14:21 +08:00，确认本地 Docker `desktop-linux`/`npipe`，无 ambient DB URL/PG 连接变量或 DOCKER_HOST override；工作树及已用私有路径无重解析点。仅核对本计划精确目标，未调用 migrate、清理入口、目标登记或退役锁。

| 精确目标           | 14:18–14:21 只读结果/当时拟议处置（实际授权及退役见下文）                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 容器               | `8ad87116924cdf709f9c40df94a32bc4a06cd3f832e177523501a6ef724a1ea8`；拟精确删除                                                                                                                                                       |
| 专属 PGDATA volume | `04fe0d650f040d1d5f91d66bf1a58ab31980f6a4165d478112b5f034e356c84e`；实际仅由上述容器引用，拟精确删除                                                                                                                                 |
| runId / 来源 SHA   | `ba53ccd1-5814-4e4a-aa47-2077ea4a9908` / `f8ed944030646bb697c4724e9071b1151e64e5ef`                                                                                                                                                  |
| 数据库 / OID       | `s1dev_f16ae0ba9f509196ff67fb93` / `16387`；只读身份与 record 一致                                                                                                                                                                   |
| 镜像               | `docker.io/library/postgres@sha256:7bade6d532592ca8ce7ee32def7399dad2607c4ea5583839fc4352a095a11ea6`；wrapper 核对实际镜像、marker、角色与 PG17 身份                                                                                 |
| record 字节 SHA256 | `423fd2117c2e819afd84760013617b22d793b10911eca9873fa89faeba27f380`；只读核查前后未变                                                                                                                                                 |
| 原记录迁移头       | `20260901010000_stage1_schema_drift_convergence`；本轮未读取迁移表，不是 migrate status/diff 通过证据                                                                                                                                |
| 当前其他连接       | 2026-09-06 14:21:31–14:21:33 +08:00 通过 verify wrapper 执行计划中的 `BEGIN READ ONLY`/计数/`ROLLBACK`，`other_sessions=0`、exit0；不能替代 owner 停用窗口                                                                           |
| 拟归档的五文件     | `.release-local/controlled-target.v1.json`、`.release-local/secrets/bootstrap.json`、`.release-local/secrets/migrate.json`、`.release-local/secrets/verify.json`、`.release-local/secrets/runtime-test.json`；均存在，未输出凭证内容 |

归档目标依批准计划为本 worktree `.release-local/p1-retirements/` 下新建且不复用的 owner-only UUID 登记目录根部，**没有额外的 `archive/` 子目录**；此处纠正旧索引措辞，不修改批准操作。沿用 CreateNew、逐文件处理和独立读回。归档不是凭证字节销毁；卷中数据库内容删除后，不能靠五文件归档恢复。

以下普通本地会话记录位于 `.release-local/p1-operations/<operationId>/`，`result.json` 绑定 command/stdout/stderr/transcript 的字节 hash。主控独立读回 hash/身份、确认 owner-only ACL；不是新的 execution proof Schema。

| operationId / 步骤                                                                                  | exit / 状态                                                                                                             | result.json SHA256                                                 |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `a8b22a36-9148-4dbd-aa6a-1acb825ef462` / 临时只读容器核查                                           | 1 / FAILED：主控临时命令误写标签键；尚未执行数据库观察。失败原件保留，不改判成功                                        | `15a25d448913eeefcd4d25cb3a0167e965043f411f04c4749694e6a774298323` |
| `f6bd17c9-900b-4b6e-adfa-bcbceb7c484c` / 标签键修正后的独立只读核查                                 | 0 / 已核对：按既有入口的 `subscription-s1-controlled.run-id` 对照实际标签，仅修正临时只读命令，不改仓库/容器/原失败记录 | `ea609e44e859999e5b679ac32b97789b26e40f84904c6aea63988a2c9ffc2140` |
| `05732551-8025-40c1-a57d-cb55fb421ca4` / `with-controlled-target.mjs --profile verify` 只读连接计数 | 0 / 已观察：既有 wrapper 先核验真实身份，随后运行计划 P1.0 原样 SQL；无业务行或迁移表读取                               | `374f1335379a55cb908a5527b3ccb9449302abaece0278069a8e2c51c8d3c843` |

上述历史停止点已由本对话用户明确确认解除：旧目标仅含可丢弃开发数据、无保留需求，所有消费者及 record 写入者暂停至归档读回结束，并批准删除列明精确容器及专属卷、归档五文件。没有沿用批准前观察作为删除门禁。

## P1.0 实际退役与独立读回

执行 SHA：`debd50d6904b58169cf83b1da27d6e738651024d`。2026-09-06 17:03 +08:00，批准后的新 operation `44f8bb27-a28f-47b0-8d0a-de720edc7f68` 原样执行计划中的 `P1.0-pre-retirement-and-exact-cleanup`：固定锁/record guard、精确身份/卷专属性/路径核验、fresh `other_sessions=0`，gate PASS，退役 COMPLETE/COMPLETE、exit0，readback VERIFIED。

精确旧容器及卷均已删除，固定 record/secrets 源路径均不存在。五文件直接归档至 `.release-local/p1-retirements/518ae6aa-c3a4-4a99-81d1-950f87478cc0/`；目录还有初始 record 和 registration 两份原件，不是额外移动的文件。五文件均 owner-only ACL，归档 record hash 仍为 `423fd2117c2e819afd84760013617b22d793b10911eca9873fa89faeba27f380`。主控和独立 reviewer 分别复算 hash、核对 ACL、源路径和 Docker 实际缺失；未读取四份 secret 内容。

| 原件                                                | SHA256                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| registration UUID 目录的 `target-registration.json` | `4d0e68be110b2df41365e26acf1f5957f9be752aacfd6e0a36fa0a8f4feebf34` |
| operation 目录的 `result.json`                      | `daf3a8d09716506da1abf180aec4ebb5c769f8c9d37d32df991d6ce3a8c10d0a` |
| `pre-retirement.json`                               | `3cae12237a3d891d8dfe52f1080a4326306a78339200fc49ac7f7cd427e113a5` |
| `retirement-result.json`                            | `b00f98364e0cb82c1e3f110cce5f77e6de8d73c10c54ca5e48dfb6c85d78f3ad` |
| `retirement-readback.json`                          | `fa762731aa1929970669e551419d1644e5d5c26320b4a61bf19f1108b229ef56` |

两次调度失败也保留：第一次误将尚待批准 helper 创建的 `p1-retirements` 根作为必需现存路径（`P1_REQUIRED_PATH_MISSING`）；第二次 fenced-block 选择器错误（`P1_BRIEF_BLOCK_SELECTION_FAILED`），均 exit1、发生在 registration/退役 operation/删除之前。主控逐次只读确认旧资产完整；改为静态核验的单次调用后才生成上述唯一实际退役 operation。没有把失败改判成功或重试 UNKNOWN 删除；正式计划、脚本未修改。

本地 SDD 记录根为 `.superpowers/sdd/2026-09-06-stage1-p0-p1-admission-implementation-plan/`：`task-P1-retirement-report.md` 保留上述历史；独立 `task-P1-retirement-review.md` 结论 CLEARLY APPROVED，SHA256 `6173c56bc616ffddbd081d7ab689f94ec6084dd253477487855cfb2ff87a884b`。均为普通本地记录，不是可信发布证明。

## P1.1–P1.5 本地合成库开发基线

执行 SHA 同上。P1.0 独立通过后，依据用户对 `645c8927` P1 技术计划的批准执行；没有借用旧目标窗口作为新回收批准。实测 Node24.14.0、pnpm11.4.0、PowerShell7.6.4、Docker29.5.3，本机 `desktop-linux`/`npipe`，无 ambient DB URL/PG 或 DOCKER_HOST override。无真实副本、业务客户数据或外部服务调用。

以下 15 个 operation 的目录均为本 worktree `.release-local/p1-operations/<operationId>/`；每个 `result.json` 绑定同目录 command/stdout/stderr/session 四份原件字节 hash。最终主控逐一核对 15 个 operation、60 个日志 hash、source/argv/exit，均通过。

| operationId                            | 实际命令                                                                                                                                                                                                   | exit / 结果                        | result.json SHA256                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `bdc80486-c74b-47fa-97e8-0792f76215dc` | `node --test scripts/release/bootstrap-controlled-postgres.test.mjs scripts/release/database-test-launcher-cli.test.mjs`                                                                                   | 0；41/41，fail/cancel/skip/todo0   | `8ea8a558e1de4ce110b3ea0426be1cc8d2d6fcf85f039709f81013465f940f19` |
| `e98bfdb1-6079-4fe7-b0aa-40dcb8ab9497` | `node scripts/release/bootstrap-controlled-postgres.mjs --output .release-local/controlled-target.v1.json`                                                                                                 | 0；新空库，锁内立即登记专属卷      | `719bde6e54a2e97ef7977fbd4ddf1229cb6fe23421c9813935da57f3e037e409` |
| `250c630a-419b-4fa6-badb-d8e35409307d` | `node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma`                                       | 0；126条全部应用                   | `4825dfa0a34f18ac883fd9be8832684440b253155bebba8239dbf8937e4e2abe` |
| `00e4e521-c6a2-4a8c-a02c-1c0bc356bc85` | `node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma`                                       | 0；最新                            | `8881d3d873cc1d7263484727de24bd14fd963ebda8208ce7d3c95250ad2aa321` |
| `cc2c8102-a6d2-46e1-b4fc-e4267a17a719` | `node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | 0；无差异，随后立即保存 checkpoint | `a672c100567eff5aa09f064eefb00d44a6e4eb48a40f87dc3e3827fb38a6487a` |
| `b49c0761-f681-402a-9628-89e59644a41b` | `node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:validate`                                                                                                                 | 0；源码 Schema 有效                | `ca046156e17c09ae8ac90e4fd16ab3097385cc6b528e6e3400a8db5e58bf6228` |
| `2cc64a04-77fd-4a4b-a485-5a46229efafe` | `pnpm --filter @subscription-saas/shared build`                                                                                                                                                            | 0                                  | `7f0c3d6d9fe4875c5910778fd71cde8e1a4e7e9e2946192c1dd2492fdde61fe9` |
| `9053c75e-5f15-4dfe-a26c-7cb010fb7c4f` | `node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:generate`                                                                                                                 | 0                                  | `425bdab526626f890bfe5e746795f279661c718b2ef2f4b30390bff60bb4c641` |
| `d70ebe05-4c57-4659-9ce4-47ed0a0ec20c` | `node scripts/release/with-controlled-target.mjs --profile verify -- pnpm --filter @subscription-saas/api test:unit`                                                                                       | 0；303文件/4074测试全部通过        | `d5aef82c16c2b0d20efc355f8b24c643d9ef63e1bd051b2e166b2cb4d5647f06` |
| `9e352e16-c63d-4dbd-b6c8-099e97d8c060` | `pnpm release:database-tests:discover`                                                                                                                                                                     | 0；92候选/36纳管/56例外/0未分类    | `392c460ca9789d5d44dc0dadc2fa6c56bd2a4b64c6731c9597bd7fe80ac38740` |
| `2a31f810-d1bc-44ad-8d35-9753354e2bde` | `node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-golden-path.postgres --chain fresh`                                                                                       | 0；1/1                             | `2794b721d3ec6a7a9162d81b943fbfa9633ae2585ee52fa2da3f646b41efaf42` |
| `94d973bc-20bc-4eba-9d10-518498277b47` | `node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-integrity.postgres --chain fresh`                                                                                         | 0；10/10                           | `9f1a12e55adb7383c6a599bc906ff7ebb5c3537807cdc654439382cf9d154bf4` |
| `1e0b1e41-6b6b-4450-aa96-a328bd2c2836` | `node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-failure-recovery.postgres --chain fresh`                                                                                  | 0；5/5                             | `0bf710f5bcb1061161fd221007778db51185ebde713d41af09445fef5081d540` |
| `ed3761d9-3d25-44f1-868c-c1e342a6354c` | `node scripts/release/run-database-suite.mjs --suite-id api.billing-automation.postgres --chain fresh`                                                                                                     | 0；8/8                             | `f3908e6b431face7fe70fec13e3da3d2ce9c6874a4982e9772de618e1e2c7c62` |
| `654c605d-df0c-47e7-bab6-61db6a274a84` | `node scripts/release/run-database-suite.mjs --suite-id api.subscription-expiry-return.postgres --chain fresh`                                                                                             | 0；80/80                           | `88e98317fcea5dca882d5c6d288bf525e482c4c2a85c292c4a34e97f6782d9ba` |

API 单测实际输出 303/303 文件、4074/4074 passed；该 reporter 没有单列 cancelled 数，未补造计数。五套数据库报告分别满足 `collected=selected=executed=passed>0`，failed/skipped/todo/filtered/cancelled 全为0，共104项；各用独立数据库及 runtime-equivalent 身份，不从 wrapper 借 URL。按原循环逐套执行并读回后才推进下一套，未重试或手工清理。

### 五套 report/custody 精确引用

下表报告 digest 均加前缀 `sha256:`；原始规范化报告路径为 `.release-local/evidence/evidence/<digest>.json`，receipt 路径为 `.release-local/evidence/receipts/<receiptId>.json`。`readback.json` 位于上表同套 operation 目录，实际 readback 均 VERIFIED。主控已复算报告与 receipt 字节 hash；raw stdout、canonical report、receipt 和 readback 是不同原件，不互相冒充。

| 套件             | readback.json SHA256                                               | 报告 digest（不含前缀）                                            | receiptId / receipt 字节 SHA256                                                                             |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| golden-path      | `fc173944f2b4ee53e503e606657d123abdf9148684ff7eeccbcb2eaf7c27c453` | `8e0020fcccacefd0495fe24b6da7d9e56eba6a1a3f6f654310078310771799b6` | `4c446342-0cbe-4961-a38b-7dc61d7318d4` / `f92735d5c6824e210d291487340ab12d9f4b0e202c54c5c2220fe466dfa1f5f9` |
| integrity        | `267abd43b6551a26f05d598668ae9a3724ae81c89fd47d5dd1b2f561ae8d7924` | `e9fe87e15b688f165b3afaf7b293ce4d1b2e50a2a828d492dfb7a56312067469` | `0afa05d5-2a45-45af-a929-f23bb7bc28c3` / `6e580288d131b776e7ae12b4508a43e39b00b06802e1a0c7bc9f0d64ee962106` |
| failure-recovery | `072afd50f0a9d4caccd2bbede826db8216024fc96e01fd014a395198fc518a08` | `2e062deb131bd4cbed413b021ba000440c1087dfee3cadf9fc6691ac70b118e1` | `5aed9a6d-af80-4613-abbe-8219ffd0f6cb` / `d14858b482db3e5a86b23c959a22405bc6ff3b5b2d40777e81fe0fd29474bc78` |
| billing          | `605bc0c80aab48af3b9747693cd706d5c73f561d363d9b377c91ba057daefbdb` | `ba3d5a5ce075955f664412e9a8d1f8c65ce738b35cf34cffc117e3bfc266bd89` | `2440df20-a60d-4686-aa9e-f8a3bcdfe0d8` / `8d0291aac3d632a75d7750e43d68f50366b1fc1c610cc2591bb8e4ef9165d544` |
| expiry-return    | `3916ee676eed7fa8086537a8d5010b8206c80466b6f35a812a3eaf53d479fff2` | `b1b8d44c42a00dcf5582ab27d12684190fbbabd5c2423cb59bb2ff52e1cc7666` | `2bf1abaa-08a8-4c5c-9b61-e48b9a6acb70` / `fe3bbad69f3058783386fce25a77652857b31968c5ed0cb0f5eba5f90dfc6c1b` |

限制：suite 内迁移/Schema/PG版本观察未单独持久化原始日志，成功测试日志原件也不由 suite CLI 保证；不从摘要补造这些证明。上述本机普通文件及 local-controlled-nonpromotable custody 不宣称不可篡改权威存储。测试用确定性 provider 不是供应商联通证明；本轮只有五项 fresh 开发基线，不是全量 fresh/snapshot 最终 Runner 验收。

### P1.6 新目标停用窗口与精确回收停止点

| 新目标/证据          | 当前保留身份                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| container            | `797a4d2e27f756cb863b37480ac2c610cc8412be70355642e240cba0a1ad7aec`                                                                                                                                                      |
| 专属 volume          | `c444341da882fd083e9f9cd179081a837c04f97b9ace4f4005cef285ce2a596a`                                                                                                                                                      |
| run / database / OID | `261aeedf-70df-42e4-9ec4-f6dbd4152934` / `s1dev_2039832846a3d34ff332c081` / `16387`                                                                                                                                     |
| 实际 PG / image      | `170011` / `docker.io/library/postgres@sha256:7bade6d532592ca8ce7ee32def7399dad2607c4ea5583839fc4352a095a11ea6`                                                                                                         |
| registration         | `.release-local/p1-retirements/71bd3bf5-144f-4b06-b36b-835390d1376f/target-registration.json`；SHA256 `7760e2f104bb2df5e9b6edc64719b75054a2c728748c7e6e2c5ecad93eca38ac`                                                |
| 初始 record          | 同 registration 目录 `record-initial.json`；SHA256 `a31d3ef677cdbe9373e0506f24e3c3e5db179f4910556f046342813a02996274`；初始 migrationHead 为 null                                                                       |
| 最终 checkpoint      | `.release-local/p1-operations/cc2c8102-a6d2-46e1-b4fc-e4267a17a719/record-checkpoint.json`；SHA256 `c2e078c73f4cc838b192239fc974753ef23f52ea82bc5351ee2c792603e19fc8`                                                   |
| 最终 record          | checkpoint 同目录 `record-after-migrate.json`；SHA256 `abc658ff01e89eefb4337b3fe155c2373dd83b9fe86eb757e42e8dc9f72b35c9`，与当前 controlled record 一致；migrationHead `20260901010000_stage1_schema_drift_convergence` |
| 后续五文件归档       | 当前 `.release-local/controlled-target.v1.json` 及 `.release-local/secrets/{bootstrap,migrate,verify,runtime-test}.json` 保留；P1.6 获得新窗口后按批准计划移至上述新 registration UUID 根部，不覆盖原件                 |

新 target 的 container/run/database/volume 全部与旧 target 不同；迁移后稳定身份不变，仅允许 migrationHead 演进。diff 后立即在锁内保存最终 checkpoint，后续无 migrate profile；本轮 deploy/status/diff 使用迁移角色自检，validate 仅校验源码，均不冒充独立只读 verify。

**当前停止：** 用户对 `645c8927` 的批准已覆盖新合成目标技术生命周期，但尚未提供该新目标的 owner 停用窗口。执行 agent 的前景会话已正常退出，未执行 P1.6，也未删除新容器/卷或归档新凭证。请 owner 确认新目标所有消费者及 record 写入者暂停，窗口持续至 P1.6 归档独立读回结束。收到后仍须新 operation 原样执行 checkpoint、精确身份、卷专属性、fresh 无消费者、删除/逐文件归档/独立读回，不能复用旧窗口或本次观察。

SDD 完整执行报告 `task-P1-baseline-report.md` SHA256 `d2f63749c7553190a96f6db6c1eb5f2825b4968a816f1c155b8150aefc317ade`；独立审查见同目录 `task-P1-baseline-review.md`。P1 仅在新目标完整回收读回后才可关闭；现阶段不能进入 Stage 1 人工验收。没有修改产品代码、迁移文件、Runner、工作流、RBAC 或 stash，也没有 push/PR/部署。Task 6、29R/30、真实副本、Staging、外部施工继续冻结。
