# 阶段 1 收口状态（2026-09-28）

阶段 1 尚未完成。当前主要差距集中在发布执行与真实验收；本轮没有增加业务功能，没有引入商用 KMS，也没有改动线上数据库。

## 本轮取得的证据

- 官方 CLI 续期已在此前用于 OSS 密文上传和完整 1 GiB 回读，两个进程退出码均为 0，摘要一致；当前没有待处理的续期请求。该事实不等于异机解密恢复完成。
- normal 组合测试 `51368` 自然退出 1。保存原件确认 observe、dry-run、apply 均为 `SUCCEEDED`，两个 Runner 子进程退出 0；首次独立结果核验失败，后续 verify/replay 尚未运行。
- 测试夹具的 `execFile` 分支错误地读取原始 `f.gh`；仅两处改为已传入的 `gh`。最小真实进程复现先出现 `expectedSpawn` 未定义，再通过（1 pass / 0 fail / 0 skip，实际 PID 82343、close 0/null）。生产执行规则未因此改变。
- 复用已保留的原始档案，进一步定位核验器误要求 target-observe 执行件具有 backup。现有 target-observe 只生成 archive 读回；Runner 成功执行件才在此检查 backup。修正后，同档案只读核验实际通过（1 pass / 0 fail / 0 skip，68,507.134551 ms），返回 `NOT_RUN`、计数 `expected=5 / consumed=3 / succeeded=3 / failed=0 / interrupted=0 / unresolved=0`。两次当前证明校验具有真实进程退出记录；867 个恢复文件前后摘要一致，未恢复私钥、凭证或重造签名记录。
- 完整 normal 重验 `7809` 已自然结束，host/Node exit 1，0 pass/1 fail/0 skip，2,560,020.847688 ms。observe、dry-run、apply、verify 原执行件均为 `SUCCEEDED`；迁移后独立核验返回 `NOT_RUN`、计数 5/3/3/0/0/0。replay 在 READY 后最后凭据释放检查发生 `MANUAL_TIME_INVALID`，最终独立核验尚未到达，不能称 normal 通过。
- replay 的原 receipt 为 `18:26:49.654Z` 签发、`18:27:19.654Z` 到期，DISPATCH_CLOSED 为 `18:27:24.165Z`（清理端点，不等于精确失败时刻）。实际子进程 PID 86172 exit 1，记录的连接/工具/query 均为 0；replay 保留 `INTERRUPTED_UNKNOWN`，原 apply 成功记录未改写。1,086 个保留文件（含 12 项公件和原 Git bundle）自一致检查通过；原临时 fixture 已清理，此检查不宣称源目录仍可逐项比较。
- 对同批原件的只读组件测量：session 整图读取约 1,691.808 ms、launcher 整图读取约 2,012.996 ms，两者读取相同 205 对象/660,697 bytes。205 份副本前后摘要不变、外部 effect 为 0。这不是原完整窗口计时，不能据此归因、延长有效期或删除最终检查。首轮在 import 阶段因缺已有 `postgres` 依赖 exit 1，未测量；保留失败后补入已锁定依赖的精确副本，测量自然 exit 0。尚未再跑 normal、apply-interrupted 或旧故障矩阵。
- R3 最小 consumer 合同已补齐前向 request/auth v3：只有 source/final，候选只引用一个 `buildProofDigest`，输入绑定固定 selector 和 index 原始字节摘要；final 另绑定既存 source 证据。定向 RED 后，原合同测试文件 79/79 通过（0 fail/skip），仓库合同校验通过（197 文件、78 schemas、128 migrations）。旧 v2 schema 字节不变；生产 session 仍拒绝 v3，此结果不授予读取、解密或恢复权限。
- 新定向 receipt 用例在准备阶段暴露 H1 路径误判：真实 `/tmp` 公共祖先目录的 nlink 从 59 变成 60，使未变化的私有原件被拒绝。只对既有 `contents=false` 且两侧均为目录的祖先比较允许 nlink 波动；dev/ino/mode/uid/gid、私有目录完整比较、叶文件 nlink=1 和独立重读均保留。直接 H1 回归先出现 1 pass/1 fail，修复后与既有私有根目录替换拒绝用例一起 2/2 通过（0 skip，3,276.926508 ms）。未通过改变生产器临时目录规避该问题；receipt 用例的早期准备失败不算有效边界验证。
- 已将三项与 receipt 无关的交付准备检查原样移到 sign/consume 前，保留原 30 秒期限、首次新鲜消费检查、READY 后资源与输入检查，以及 secret pin 后最终检查。定向篡改在实际 receipt 写入时改变 Docker 目标身份：旧顺序的有效 RED 未到 READY；新顺序实际收到 1 个 READY 后拒绝 `MANUAL_H3_RESOURCE_MISMATCH`，凭据交付/连接/工具/query 均为 0，原消费 receipt 与唯一 UNKNOWN 执行件保留。新用例自然 exit 0，1 pass/0 fail/0 skip，163,115.184884 ms；实际子进程 PID 96622 exit 1/null 是预期拒绝。此结果只证明该边界仍有效，不证明完整 normal 已通过或原 replay 超时已消除。

本轮离线预检：Prisma schema validate 退出 0；migrate status 在子进程未设置数据库 URL 的条件下退出 1，错误为 `The datasource.url property is required in your Prisma config file when using prisma migrate status.` 此命令没有连接数据库，不能据此推断服务器当前迁移状态。修改文件语法、Prettier 和 diff 检查通过。

## 剩余收口顺序

| 顺序 | 尚未完成的工作                                                                                    | 完成依据                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1    | R2 独立结果核验器完整 normal / apply-interrupted 组合；已完成 UNKNOWN 的备份要求；replay 失联回归 | 原始失败保留，必要定向用例自然结束；不能把局部 GREEN 汇总成完整通过                        |
| 2    | 最终候选的受保护 CI 构建与 H2 证据读回                                                            | 同一源码、API/Web/Runner 镜像及独立保管身份的真实原件                                      |
| 3    | R2 两个独立 PG17 目标的 migration、权限读回、verification / reconcile                             | normal 和 apply-interrupted 各自的真实 operationRef、目标身份与结果；原 UNKNOWN 不改写     |
| 4    | R3 非商用快照消费接线、隔离加密目标及同候选 fresh / snapshot 双链                                 | 合法快照来源、消费权限、目的地与会话原件齐全；认证后恢复与两条 37-suite/API-Web 链真实执行 |
| 5    | Staging 迁移对齐和服务恢复                                                                        | 发布链应用待迁移、读回实际状态；API/Web 健康及关键路径通过                                 |
| 6    | R4 A/B 申请、签约、支付回调、激活、终态及恢复验收与签收                                           | 实际业务结果和审计记录、维护/恢复证据、负责人签收                                          |

2026-09-28 02:28（北京时间）经既有 SSH 身份只读核对：Staging PostgreSQL 正常，API/Web 及其余容器停止。数据库 `subscription_saas_staging` 的 PG 版本为 170010，迁移表共 127 行，其中 126 条完成、1 条历史 rolled-back、0 条活动失败；126 条已完成迁移的 checksum 全部与当前工作树匹配，无 remote-only 或 checksum 漂移。候选仍有 128 条，待应用的仍是 `20260925090000_stage1_operational_completion_terminal_shape` 和 `20260925091000_stage1_operational_completion_settlement_guard`。SQL 在只读事务内执行，没有应用迁移或读取业务行。

R3 路线已按当前收口决策纠正：此前拟做的 prebuild 读取器不属于本期必要路径，草稿已停止，尚未写入生产代码或执行测试。[最小发布决策](../superpowers/specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md)明确延期构建前私有快照依赖；本期构建沿用唯一 `build-proof.v1`，提升前完成合法 snapshot 链。

当前未接线的 `manual-runner-request.v2` 强制要求旧 bundle/dispatch/RC workflow，非商用 producer 授权 v2 也带有同类依赖。不能为适配这些字段恢复已延期平台或填写替代值。本轮 consumer v3 已完成纯合同层面的纠正，保留 v2 历史解释；下一片回到 R3 Task1 的合法快照原件读取。实际权限来源、对象版本、独立保管读回、目的地和消费会话仍须闭合，不能用测试原件替代。只有确需新 producer 时才对齐它的前向授权；已有合法密文不因消费合同更新被强制重生产。

负责人、主机、Docker 恢复和无关容器暂停、迁移对齐及非商用方案的既有授权继续有效。当前无需用户重新登录或重复批准这些事项。

## 证据定位

隐藏工作目录为 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/runner-second-stage/`：

- 原失败与保全：`result-verifier-native02.log`、`result-verifier-native02-preserved-check.json`。
- 最小夹具复现：`native-gh-closure-red.log`、`native-gh-closure-green.log`。
- 同档案核验 RED/GREEN：`normal02-readonly-verifier01.log`、`normal02-readonly-verifier02.log`，后者 report digest 为 `sha256:d81e1a5fa1f2747837b04c691bcf3ed0232d713c8402a641d64210b7818ed6f3`。
- normal 终态及原件：`result-verifier-frozen04.json`、`result-verifier-native03.log`、`result-verifier-native03-preserved-check.json`、`normal03-original-timing.json`；该核验进程已结束。
- 只读组件计时：`native03-receipt-await-chain-memo.md`、`normal03-graph-cost-result02.json`（原失败为 `normal03-graph-cost-result.json`）；不包含实际 session/凭据交付。
- 服务器迁移只读原件与比较：`staging-migrations-readonly-20260928.json`、`staging-migrations-comparison-20260928.json`；后者绑定原读回 SHA-256 `aa7bdda6d60dd0247c677a3a62f7bbdc6f4464a603e033e27d685ccc5f4537f8`。
- R3 范围纠正：`r3-prebuild-scope-correction-20260928.md`；此前 `r3-prebuild-input-reader-contract-20260928.md` 的“下一实施切片”建议已撤回，不再按它实施。
- R3 最小合同切片：`r3-minimal-consumer-forward-contract-proposal-20260928.md`、`r3-consumer-v3-red01.log`、`r3-consumer-v3-green01.log`、`r3-consumer-v3-contracts01.log`。这是固定签名/结构校验；其实际输入、消费会话和远端目标接线未完成。
- H1 公共祖先误判：`consume-h1-paths01.log` 保存实际变更字段；`trust-ancestor-red01.log` / `trust-ancestor-green01.log` 和同名 JSON 保存定向结果及复制源码摘要。`consume-resource-red01` 至 `red04` 均属准备失败，尚未触达 receipt 变更边界。
- 检查前移的有效边界回归：`consume-resource-red05.log`（0/1/0，171,240.391399 ms）与 `consume-resource-green01.log`（1/0/0）。每次都核对 243 项复制源码原始摘要；对应 manifest 分别为 `20260927-190140-561481037-copy.sha256` 和 `20260927-190549-209596540-copy.sha256`。原件保存在 `originals/consume-resource-change-*`，无真实密钥或业务凭据。
