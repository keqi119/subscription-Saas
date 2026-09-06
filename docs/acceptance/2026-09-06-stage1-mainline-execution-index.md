# Stage 1 主线执行索引

状态：P0.1–P0.6 已通过主控及独立子 agent 审查并提交为 `debc3ad21ba3684022274f198d81c55b6e09c1ac`；P0.7 本机只读盘点完成，副本材料仍不可用。P1.0 已完成目标身份、专属卷及当前连接数的只读核查，停在独立退役批准前；owner 无保留需求及停用窗口尚待确认。P1.1–P1.6、真实来源/签发/部署未执行，P0/P1 不等于 API/数据库套件或 Stage 1 验收通过。

范围：A/B进件—审核—方案/预约—单次确认—签约归档—主动支付/核销—交付激活—账单/催收—无争议正常结束。

历史代码基线：Task 5 `1f0b0439`。Task 6 提案保管：`457c0011`，不代表批准。
Task 6/29R/30/I 系列冻结，Task 30 stash 不变。
执行入口：[P0/P1 准入实施计划](../superpowers/plans/2026-09-06-stage1-p0-p1-admission-implementation-plan.md)。

| 项目                                     | 初始状态          | 证据/限制                                                                                                                                                                                                        |
| ---------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本轮执行 SHA、批准引用、日期、stash 指纹 | P0.1 已实际记录   | SHA `645c89277d60d50bbdbba0e8bc6456e42cba5ab1`；本对话用户批准 `645c8927`（P0 可按序执行；P1 技术计划获批；P1.0 实际退役另行授权）；2026-09-06 14:02:33 +08:00；stash `b299ceeed80374d181998f8ef485629beba56b5f` |
| 两项人工决定                             | 口径已对齐        | 非业务验收；`FINAL_PLAN_DECISION`、`DELIVERY_EVIDENCE_DECISION`；车辆分配不另加内部批准                                                                                                                          |
| PG17 身份/迁移状态                       | 部分只读核查      | P1.0 旧目标身份已由既有 wrapper 核对；新目标、迁移/status/diff 仍 NOT_RUN，旧 record 的 migrationHead 不是本轮迁移状态证明                                                                                       |
| Schema validate / 实际 DB diff           | NOT_RUN           | 二者分别记录，不互相替代                                                                                                                                                                                         |
| API unit / 五项主线 DB suite             | NOT_RUN           | P1，非候选全量证明                                                                                                                                                                                               |
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

## P1.0 只读核查与独立批准停止点

运行 SHA：`debc3ad21ba3684022274f198d81c55b6e09c1ac`。2026-09-06 14:18–14:21 +08:00，确认本地 Docker `desktop-linux`/`npipe`，无 ambient DB URL/PG 连接变量或 DOCKER_HOST override；工作树及已用私有路径无重解析点。仅核对本计划精确目标，未调用 migrate、清理入口、目标登记或退役锁。

| 精确目标           | 只读结果/拟议处置（尚未授权执行）                                                                                                                                                                                                    |
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

拟归档目标为本 worktree `.release-local/p1-retirements/` 下获批后新建且不复用的 owner-only 独立 UUID 登记目录中的 `archive/`，沿用批准计划的 CreateNew、逐文件处理和独立读回；当前未创建该目录。归档不是凭证字节销毁。删除卷会丢弃该旧目标数据库内容，不能靠五文件归档恢复数据；需要 owner 明确确认可丢弃、无保留需求。

以下普通本地会话记录位于 `.release-local/p1-operations/<operationId>/`，`result.json` 绑定 command/stdout/stderr/transcript 的字节 hash。主控独立读回 hash/身份、确认 owner-only ACL；不是新的 execution proof Schema。

| operationId / 步骤                                                                                  | exit / 状态                                                                                                             | result.json SHA256                                                 |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `a8b22a36-9148-4dbd-aa6a-1acb825ef462` / 临时只读容器核查                                           | 1 / FAILED：主控临时命令误写标签键；尚未执行数据库观察。失败原件保留，不改判成功                                        | `15a25d448913eeefcd4d25cb3a0167e965043f411f04c4749694e6a774298323` |
| `f6bd17c9-900b-4b6e-adfa-bcbceb7c484c` / 标签键修正后的独立只读核查                                 | 0 / 已核对：按既有入口的 `subscription-s1-controlled.run-id` 对照实际标签，仅修正临时只读命令，不改仓库/容器/原失败记录 | `ea609e44e859999e5b679ac32b97789b26e40f84904c6aea63988a2c9ffc2140` |
| `05732551-8025-40c1-a57d-cb55fb421ca4` / `with-controlled-target.mjs --profile verify` 只读连接计数 | 0 / 已观察：既有 wrapper 先核验真实身份，随后运行计划 P1.0 原样 SQL；无业务行或迁移表读取                               | `374f1335379a55cb908a5527b3ccb9449302abaece0278069a8e2c51c8d3c843` |

**P1.0 保持 BLOCKED，等待另行明确批准：** owner 确认上述目标归属、仅为可丢弃开发数据且无保留需求，所有消费者及 record 写入者已经暂停，停用窗口覆盖至归档独立读回结束；并明确批准删除上述精确容器及专属卷、归档五文件。批准前不删除、不归档、不新建替代库。批准后仍须在新的 pre-retirement operation 内按原计划重做全部检查，不能沿用本次观察；失败/部分完成/UNKNOWN 不得覆盖或自动重试。

下一责任包：用户确认精确退役范围与停用窗口；之后才可按批准 P1 技术计划推进。Task 6、29R/30、真实副本、Staging、外部施工仍冻结；本轮 stash `b299ceeed80374d181998f8ef485629beba56b5f` 未变。
