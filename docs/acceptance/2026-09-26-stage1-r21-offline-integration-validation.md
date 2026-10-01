# Stage 1 R2.1 与 R1 MS2 本地组合验收

记录日期：2026-09-26。实际完整测试于 2026-09-25 执行，恢复任务后独立核验原件；没有因任务中断重跑已通过的完整集合。

**结论：R2.1 与本次 R1 MS2 工具调用兼容修复的本地范围完成，独立终审 ACCEPT。** 最终干净测试 source 为 `ba57efea2441bf29d1d9f0105591e418c6f919b0`，Node `v24.14.0`。最终八文件 343/343，无失败、取消、跳过、todo 或名称筛选。该结论不关闭 R2.2/R2.3、真实来源输入、最终 Node22 制品、H3 或阶段1。

## 实施与证明范围

- R2.1 八文件实现由 `51a158ee` 接入本地集成分支为 `b7e24171`：新增 manual command adapter / target observer 及测试；既有 applyMigration 增加封闭且可选的 executionIdentity 第三参数；更新现有 handler 测试、catalog 和 contract manifest。旧两参数入口保持。
- observer 经实际 connector/runtime 的离线 SQL 客户端执行固定 REPEATABLE READ READ ONLY setter 与两个 SHOW，读取实际身份、全部迁移行及现有 owner/extension 投影。无表和查询失败分开；错 system identifier、endpoint、DB OID/name、角色或 TLS 不进入领域执行。ownerInventory 仅覆盖现有 public schema 与关系/视图/物化视图/序列投影，不证明所有数据库对象的所有权。
- R1 四文件修复 `a9b52d47` 接入为 `4bd977d2`：MS2 接受真实 runtime 的固定组内并行与非空 apply 多轮调用；全部调用分别核验退出、保管、完整版本和 Schema 输出，不能仅取最后一次掩盖失败。跨组必须等前组完成；close 来源/tool/序号绑定；失败前缀仍可记录。MS1、parser、session 生产实现、共享 Schema 与导出没有变化。
- 追加 R2.1 两文件修复 `47b11b91` 接入为 `ba57efea`：catalog 读取后的工具 ACK 会推进 process，原 observation 时间/摘要滞后而被共享 live validator 拒绝。最终 RETURNED/THREW 形成不可变 observation 完成封套，取实际完成时钟与当前已验证 process 摘要，再计算 result.observationDigest；保留 catalog/schema/角色、合法 partial/postState 和错误原因。null 仍为 null，不增加查询、清理 SQL 日志或回填未来 parent close。
- 新组合测试直接执行真实 runtime，工具进程/SQL 仍为受控 double；每个 PREPARED/SPAWNED/CLOSED 的 ACK 经共享 live validator 后更新快照，再将 adapter 原样返回的 observation 交给 OBSERVATION ACK 校验。覆盖 dry-run/apply/verify/replay/reconcile 及工具失败后的 THREW 与合法 postState 保留。
- 已安装 Prisma 7.8.0 的实际多行 `--version` 报告在受控无 DB 凭证环境取得，经 runtime/plan/schema 映射保持完整；它不是最终镜像或真实迁移证明。

## 最终原件与命令

本地集成 worktree 为 `D:\\Projects\\auto-subscription-platform\\.worktrees\\stage1-audit-closure-20260925`。以下原件保留在该 worktree 的 ignored `node_modules/.cache/sdd/r21-r1-final-20260925/`，没有提交为生产权威证据。

```powershell
node --test --test-concurrency=1 apps/release-runner/test/manual-target-observer.test.mjs apps/release-runner/test/manual-command-adapter.test.mjs apps/release-runner/test/db-migrate-schema.integration.test.mjs apps/release-runner/test/database-runtime-adapter.integration.test.mjs packages/release-foundation/test/manual-runner-evidence.test.mjs packages/release-foundation/test/manual-stage1-contracts.test.mjs packages/release-foundation/test/manual-stage1-session.test.mjs packages/release-foundation/test/execution-state-machine.test.mjs
```

| 原件/检查                | 实际结果                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `full.inputs.json`       | 完整 argv、Node 版本、source 和14个输入文件 SHA256；无筛选                                                       |
| `full.log`               | 343/343，fail/cancel/skip/todo 均0，715988.5118ms                                                                |
| `full.close.json`        | 2026-09-25T10:22:45.3743888Z → 10:34:41.5459996Z，exit0，inputsUnchanged=true                                    |
| 日志 SHA256              | `41a017ae068ffbf76bc0babeca949f2819614ba579325eefac1817addad4b347`，独立重算匹配                                 |
| 2026-09-26 独立复核      | 14个输入当前字节匹配、历史/最终日志和实际关闭记录匹配，ACCEPT；没有重跑完整测试                                  |
| `contracts.log`          | 128 migrations、176 contract files、68 schemas、13 commands，exit0                                               |
| contract digest          | `sha256:9630a34b556da831b260396b8aa28e2176cb1e113a174962ff09a94382d4dbb3`                                        |
| migration catalog digest | `sha256:65ebe3208fc618ae82ad24f66b793e9bddd7464526dd45b8a0d9893d24a0ff62`                                        |
| `discovery.log`          | 95 candidates / 39 manifested files / 56 excepted / 0 unclassified，exit0；不是数据库执行计数                    |
| `checks.close.json`      | 2026-09-26T08:35:32.7949373Z → 08:35:40.7524742Z；上述两检查、9个相关 .mjs 的 node --check 和 diff-check 均exit0 |
| 格式                     | R2八文件与后续两文件 Prettier通过；R1两测试/计划通过，保留生产 parser 既有换行例外                               |

上述 checks 的 contracts/discovery 日志 SHA256 分别为 `e65f7a16f747309cd028e98323e066b974087e5df37ec946a0c7f1545477b924`、`e81d889074607a7ee9f2baed1a3f292c39803e26c77e29bf74b81cfaa41cf1a9`。所有时间为UTC。

## 保留的先前结果

- R2 原 worktree `stage1-r21-adapter-20260925` 的 `node_modules/.cache/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/main-focused-final.*`：62/62、exit0，2026-09-25T09:51:33.8383901Z → 09:51:44.6630626Z，日志 SHA256 `5fca5c5538d553574dfc1ce4c86ec8ac73b414e8018ff3d82a47a8cb7c8023b9`，八文件字节独立匹配。此前60项及部分初始 RED 仅留在工具输出，不能称独立读过其原始日志。
- R1 worktree `stage1-r1-tool-evidence-20260925` 的 `node_modules/.cache/sdd/r1-tool-evidence-schedule/` 保留并发/串行/前缀/session/伪parent close等 RED：19项17/2、2项0/2、1项0/1、3项1/2及1项0/1；GREEN 22/22、31/31、最后来源绑定3/3、session3/3。31项在最终 source/tool 小修之前，随后3项覆盖该修复，不能相加计数。
- 集成 worktree `node_modules/.cache/sdd/r21-r1-combined-20260925/full.*`：source `4bd977d277349122fee12da5528b40e1da12ec26`，339/339、exit0，2026-09-25T09:59:02.4144268Z → 10:17:11.1523748Z，日志 SHA256 `62c4908542372b5137b52e312ae71fc68f49f80b4c541be00544da91c7532c76`。该轮漏掉动态 observation/ACK 边界；保留其通过事实，但不据此关闭缺陷。
- 补漏 worktree `stage1-r21-process-snapshot-20260925` 的 `node_modules/.cache/sdd/r21-process-snapshot/`：动态摘要 RED 0/2 → GREEN 2/2；共享 live 组合与相关两文件56/56，最后增加查询次数断言后组合2/2。该目录没有独立 actual-close 文件，聚焦记录按原日志/工具输出边界引用；完整实际关闭证据以最终343轮为准，不累加重叠计数。

## 尚未证明与下一步

默认 ESLint 不能记为通过。R1 当前默认诊断210项、基线204项，新增6项是同一 Node globals 配置下的 Buffer no-undef；带Node globals的诊断对照仍为既有6项，不能替代默认 lint。保留历史 parser 格式例外，没有为本单元修改全局配置或扩做格式清理。

没有运行线上 Docker、真实 PG/H3、provider、CI、部署、push 或 PR；没有以本单元改写旧迁移。SQL/process doubles、合成保管/授权夹具和 Node24 回归不证明真实原始 Buffer/PID/存储保管、H1/H2/H3、expected-schema 来源或最终 Node22。原件来源与 raw UTF-8/1MiB 限额仍由 R2.2 固定 IO/collector 验证。collector 必须使已开始工具调用停止推进后再封装并发送最终 observation，不能更新已经发出的原件。

下一步按原 R2.2 八文件范围实施固定 launcher/entrypoint，先完成 expected-schema、H3-B 和角色凭证的私有固定输入定义；随后 R2.3 独立只读 verifier 与专用真实门禁入口。真实环境阶段仍要求实际可信输入与该系统 Docker 恢复/健康核验，不因本地验收自动放行。
