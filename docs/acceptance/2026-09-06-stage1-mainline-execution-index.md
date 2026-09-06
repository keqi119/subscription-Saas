# Stage 1 主线执行索引

状态：P0.1–P0.6 范围交接已通过主控及独立子 agent 审查；P0.7 只读材料盘点待进行。仅完成 P0 静态与无外部副作用单元门禁，不是 API/数据库测试套件或验收通过。P1 技术计划已获批，下一步仅做 P1.0 只读核查，实际退役另行授权。真实来源/签发/部署仍未授权。

范围：A/B进件—审核—方案/预约—单次确认—签约归档—主动支付/核销—交付激活—账单/催收—无争议正常结束。

历史代码基线：Task 5 `1f0b0439`。Task 6 提案保管：`457c0011`，不代表批准。
Task 6/29R/30/I 系列冻结，Task 30 stash 不变。
执行入口：[P0/P1 准入实施计划](../superpowers/plans/2026-09-06-stage1-p0-p1-admission-implementation-plan.md)。

| 项目                                     | 初始状态          | 证据/限制                                                                                                                                                                                                        |
| ---------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本轮执行 SHA、批准引用、日期、stash 指纹 | P0.1 已实际记录   | SHA `645c89277d60d50bbdbba0e8bc6456e42cba5ab1`；本对话用户批准 `645c8927`（P0 可按序执行；P1 技术计划获批；P1.0 实际退役另行授权）；2026-09-06 14:02:33 +08:00；stash `b299ceeed80374d181998f8ef485629beba56b5f` |
| 两项人工决定                             | 口径已对齐        | 非业务验收；`FINAL_PLAN_DECISION`、`DELIVERY_EVIDENCE_DECISION`；车辆分配不另加内部批准                                                                                                                          |
| PG17 身份/迁移状态                       | NOT_RUN           | P1                                                                                                                                                                                                               |
| Schema validate / 实际 DB diff           | NOT_RUN           | 二者分别记录，不互相替代                                                                                                                                                                                         |
| unit / 五项主线 DB suite                 | NOT_RUN           | P1，非候选全量证明                                                                                                                                                                                               |
| 合法副本及读取/使用授权                  | INPUT_UNAVAILABLE | 当前未找到；只读盘点后更新                                                                                                                                                                                       |
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
