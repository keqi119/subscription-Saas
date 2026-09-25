# Stage 1 F4：协议完整门禁与 Schema 编译复用验证

执行日期：2026-09-25。依据[审计收口计划任务 3](../superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md)及其中追加的非业务性能修复范围。

当前结果：原四文件完整门禁 249/249、exit 0；Schema registry 回归 17/17。F4 限定实现及本地兼容验证完成。此结果不代表 R2 实现、最终 Node22 镜像、真实渠道或阶段 1 整体验收。

## 修复范围

- parser 的短前缀仅在尚未收到 LF 时视为未完成；收到 LF 的非法短头立即沿用 FRAME 错误。MS1/MS2 在 ACK 后带畸形尾部的完整归档恢复必须为 INTERRUPTED_UNKNOWN，不能据后续 CLOSED 原件冒认成功。原聚焦 RED 1/4 → GREEN 4/4，原提交 `453dffa2`，实现工作树对应 `3e89bb21`。
- 性能定位发现每次 `validateContract` 都重新编译全部 68 份 Schema。现在只保留最近一次成功编译的 registry，每次仍重新枚举完整文件列表、读取精确 Buffer bytes；root、路径及字节全部相同时才复用。编译使用同次读取的快照，失败不能回退旧结果；`compileAllSchemas` 保持强制编译。
- 不缓存 payload 验证结果，不改 Schema、协议、错误码、角色、权限或数据库 launcher。Ajv 错误的 params 深拷贝后返回，保留其形状、值及调用方可变性，防止 const/enum 引用被外部改写而污染后续验证。

## 失败历史与回归

首次完整门禁于 `2026-09-24T16:45:16.918Z` 启动、`20:47:04.359Z` 关闭：249 执行、248 通过，exit 1。唯一失败是已安装 Prisma 版本报告的 30 秒探测超时。其 stdout SHA-256 为 `63078edf9abf2a5004f7e51e29d9590a31278b93aab005656a0522a0ba00972e`。随后串行重跑没有 actual-close 原件，保留 INCOMPLETE_NO_CLOSE，不补造退出码。独立版本测试后续通过也未改判上述失败。完整历史保留在原工作树的 `2026-09-25-stage1-offline-fixes.md` 及原始日志。

编译复用测试先在 `93564976` 记录有效 RED：17 tests、16 pass、1 fail，相同内容连续验证实际调用真实 Ajv compile 四次，预期一次。最初 fixture 误用 `{root}` 的失败是测试接线错误，独立保存而不作为生产反例。实现 `fc1b1806` 后 17/17、exit 0；新增覆盖同 size/mtime 内容替换、文件增删/改名/不可读、无关坏 Schema、重复 ID、root 切换、坏 JSON 恢复、解码相同但原字节不同，以及外部修改错误详情。

只读重复验证诊断在修复前为 3919/3203/1563ms，修复后为 2469/15/14ms；均返回原 CONTRACT_SCHEMA_UNREGISTERED。它说明重复编译成本下降，不单独证明首次 Prisma 超时的全部环境原因。

## 最终完整执行原件

执行 source：`fc1b180644079e0643a4a9002674cd0a77e17980`，启动 checkout 干净，Node `v24.14.0`，Windows。本轮未提高原 30 秒版本探测超时，没有过滤、删除或替换任何慢用例。

```powershell
node --test packages/release-foundation/test/manual-runner-evidence.test.mjs packages/release-foundation/test/manual-stage1-session.test.mjs packages/release-foundation/test/manual-stage1-contracts.test.mjs packages/release-foundation/test/execution-state-machine.test.mjs
```

| 事实 | 实际值 |
| --- | --- |
| startedAt | `2026-09-25T05:59:24.254Z` |
| actual closedAt | `2026-09-25T06:10:42.870Z` |
| child PID | `73588` |
| actual exit / signal / spawnError | `0` / `null` / `null` |
| tests / passed / failed | `249` / `249` / `0` |
| cancelled / skipped / todo | `0` / `0` / `0` |
| test duration | `678441.4665ms` |
| sourceUnchanged / inputUnchanged | `true` / `true` |
| stdout bytes / SHA-256 | `21816` / `47e3fb72d02f3f255191867d8a0a89dbcab0e544d3bdd10cf82a701b8446e6a1` |
| stderr bytes / SHA-256 | `0` / `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

原四项短帧反例全部通过；真实已安装 Prisma 版本报告测试通过，耗时 5200.5325ms；MS2 bound-90 每 ACK 归档验证通过，耗时 57102.3857ms。旧授权兼容、UNKNOWN 保留、撤销、一次性消费和恢复等完整断言均实际执行。

契约校验同一 source exit 0：126 migrations、174 contract files、68 schemas、13 commands。migrationCatalogDigest 保持 `sha256:95354883403ca767eb5f8df2a6339b21517cfd59844eb30673b165d5d28dd990`；repositoryContractDigest 为 `sha256:3778c7b48e731073b722d3edd3f5b6fe393d1015ae19a4fc81367439a00678e8`。生产及测试文件 Prettier、`git diff --check` 通过。F3/B5 的历史数据库结果仍绑定其原 source 和原 digest，不移作本 source 的数据库矩阵证据。

原件根目录：`D:/Projects/auto-subscription-platform/.worktrees/stage1-audit-closure-20260925/.superpowers/sdd/2026-09-22-stage1-audit-driven-closure-plan/`。完整门禁为 `f4-post-cache-full.{launch.json,stdout.log,stderr.log,actual-close.json}`，捕获器为 `f4-capture-full.mjs`；其记录测试、release-foundation 源码、release/contracts、锁文件及 runner package 的运行前后摘要。Schema 原件为 `f4-schema-cache-final-red.log`、`f4-schema-cache-green.log`，契约为 `f4-contracts.log` 与 close。

独立代码、测试与完整执行原件审查均 ACCEPT：复算 249 条通过结果及全部 140 项输入摘要匹配，限定 F4 可关闭。actual-close 原件 SHA-256 为 `99dd7a7bd82f2cda8d17dcd4dae77f86e78d4b090bb950e232dfb171a0fe386d`。本轮沿用刚完成的受控 fresh migrate/status/diff 与 Prisma validate 预检；无业务、Schema、迁移或数据库连接变更，未访问退役目标。未连接服务器、恢复线上 Docker、调用供应商或执行资金操作。
