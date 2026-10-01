# Stage 1 B1：进件权威与业务等待验证

执行日期：2026-09-25。按已批准的[审计收口计划任务 6](../superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md)续接 [B1 原计划](../superpowers/plans/2026-09-06-stage1-b1-intake-and-business-wait-validation-plan.md) Task2–4。原 Task1 提交 `0e1cbe5c79b4d6e76310a7dca1e3cf8119e88166` 保留，未重做。

本轮只修改两份 unit 测试：`5c9223ca` 组合真实 CustomerService 分类器与 Journey service，`7ad53559` 扩展 worker 边界。未修改生产代码、Prisma、权限、web、manifest 或 launcher。

- 两条进件来源均从 Application 资料/信用/押金事实产生人工等待，保留 factVersion 和三个原因码。
- 补件产生 WAITING_CUSTOMER；REJECTED/CANCELLED 都使用既有 Journey 终态命令，但保留不同 Application 原因码。终态 fixture 无 soft hold；这些 unit 不证明真实数据库锁或持久化释放。
- worker 对人工等待、客户等待、拒绝和取消结果携带完整 payload 完成当前 lease，不 retry/dead-letter。抛出的技术错误才以脱敏 JOURNEY_EXECUTION_ERROR 和 36 秒有界抖动重试，不误记完成。
- 既有行为直接通过 characterization，不伪造 RED。Task2 两文件 82/82，Task3 worker 21/21，独立范围审查 ACCEPT。

## 当前完整门禁

执行 source：`7ad5355906fb47f6fa2b525c457ef946e645fbe7`。启动 checkout 干净；下列门禁执行期间 source 不变。

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/application-review-api.spec.ts test/self-service-application.spec.ts test/subscription-journey-application.spec.ts test/subscription-journey-worker.spec.ts
pnpm --filter @subscription-saas/api exec eslint test/application-review-api.spec.ts test/subscription-journey-application.spec.ts test/subscription-journey-worker.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-golden-path.postgres --chain fresh
```

Unit 四文件 112/112、exit 0，失败/跳过/todo 为 0；ESLint、API tsc、`git diff --check` 均 exit 0。Prisma validate exit 0；shared build/client 源码未变，沿用本轮已完成的本地生成准备。按原 B1 预检约束，没有对 ambient URL 执行 migrate status；fresh launcher 在本次唯一新目标内部执行 migrate deploy/status/diff，退出成功。

两份 owned 测试文件整文件 Prettier 检查失败；分别对其修改前 HEAD 调用同一 Prettier 也失败，属于既有格式基线。独立审查接受限于本次有意测试差异的例外，没有扩大为全文件格式改写，也没有登记 Prettier 通过。

| 本次 fresh 绑定 | 实际值 |
| --- | --- |
| started / closed UTC | `2026-09-25T06:24:48.6030873Z` / `2026-09-25T06:26:39.2710212Z` |
| runId / operationId | `a03265ee-e48d-492a-ae11-f404e3614aca` / `dabda510-ca43-4efc-8c81-41060b76217a` |
| database / OID | `s1ci_01389340e8c6345362a2269c` / `16386` |
| targetFingerprint | `sha256:03dbaad7f6375c20a5b04d7419cbf4ab0737833cbb6276c6a5016d70d4e42831` |
| counts | collected=selected=executed=passed=`1`；failed/skipped/todo/filtered/cancelled=`0` |
| exit / terminal / lifecycle | `0` / `PASSED` / `RETIRED` |
| manifestDigest | `sha256:f4892d83e4943fe8acaf729bf4fd87cc41fb143f6b6abc55e8b8e80929f74116` |
| discoveryDigest | `sha256:4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a` |
| sanitizedLogDigest | `sha256:2dadc1f5f55c71cefbd0db04fba9ff8b7e267610729d2ffd96019ff4bcf8ef5d` |
| report / content / readback / raw / canonical digest | `sha256:2a90a8ee249efa8e105a28f881964d90339055879ac1db123ae743fe4eccae0c` |
| report bytes | `972` |
| receiptId | `e1ae1c4b-e37c-4418-9037-10d728fc5739` |
| receipt file digest | `sha256:af14b51b1396397e97e1ff4fe1772bd40d2e445e4a25ecf002ca91cc01839860` |

原 Task4 Step3 PowerShell 块逐字提取执行一次，摘要 `6f4ff0e4f7b0668f088c0315577984c15784875cb85d99b4e3e292977f7d813f`。只按前后 receipt 文件名差集绑定唯一新 receipt；严格校验 digest 格式后读回内容，并分别比较原 stdout JSON、存储 JSON 的 canonical digest 和实际文件 SHA-256。七项 runtime 角色/ownership 权限均 false。当前 run 目录已由 launcher 退役，固定旧目标及四个固定 secret 路径仍不存在；没有读取旧凭证或手动清理目标。

原件根目录：`D:/Projects/auto-subscription-platform/.worktrees/stage1-audit-closure-20260925/.superpowers/sdd/2026-09-22-stage1-audit-driven-closure-plan/`。前缀 `b1-final-unit`、`b1-final-lint`、`b1-final-typecheck` 包含 log/close；`b1-final-fresh` 包含 stdout/result/close/log 及完整文件名清单。正式 report/receipt 位于同工作树 `.release-local/evidence/`。独立代码、原件及记录审查 ACCEPT，限定 B1 关闭；实际 receipt 清单为 20→21，唯一新增与表中身份一致。

限制：原 golden-path fixture 未改写，证明其 A/B 持久化形状收敛；不将它替代 B2 的真实 CustomerService 建单、车辆竞争、确认与事务回滚矩阵。本机 Node24 与 local-controlled-nonpromotable 证据不代表 snapshot 双链、最终 Node22 镜像、Staging、浏览器、供应商或真实客户验收。未连接远程服务器；需要线上联调时先恢复本系统对应 Docker 环境。
