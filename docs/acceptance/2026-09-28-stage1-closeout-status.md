# 阶段 1 收口状态（2026-09-28）

阶段 1 尚未完成。当前主要差距集中在发布执行与真实验收；本轮没有增加业务功能，没有引入商用 KMS，也没有改动线上数据库。

## 本轮取得的证据

- 官方 CLI 续期已在此前用于 OSS 密文上传和完整 1 GiB 回读，两个进程退出码均为 0，摘要一致；当前没有待处理的续期请求。该事实不等于异机解密恢复完成。
- normal 组合测试 `51368` 自然退出 1。保存原件确认 observe、dry-run、apply 均为 `SUCCEEDED`，两个 Runner 子进程退出 0；首次独立结果核验失败，后续 verify/replay 尚未运行。
- 测试夹具的 `execFile` 分支错误地读取原始 `f.gh`；仅两处改为已传入的 `gh`。最小真实进程复现先出现 `expectedSpawn` 未定义，再通过（1 pass / 0 fail / 0 skip，实际 PID 82343、close 0/null）。生产执行规则未因此改变。
- 复用已保留的原始档案，进一步定位核验器误要求 target-observe 执行件具有 backup。现有 target-observe 只生成 archive 读回；Runner 成功执行件才在此检查 backup。修正后，同档案只读核验实际通过（1 pass / 0 fail / 0 skip，68,507.134551 ms），返回 `NOT_RUN`、计数 `expected=5 / consumed=3 / succeeded=3 / failed=0 / interrupted=0 / unresolved=0`。两次当前证明校验具有真实进程退出记录；867 个恢复文件前后摘要一致，未恢复私钥、凭证或重造签名记录。
- 上述 GREEN 仅说明已完成的迁移阶段能被独立读回，不能代替完整 normal、apply-interrupted 或真实 PostgreSQL 验收。完整 normal 的必要重验仍在运行；2026-09-28 02:11（北京时间）读回其原始档案，observe、dry-run、apply 均为 `SUCCEEDED`，verify 请求已产生但尚无执行终态。该观察不代替测试最终结果。
- R3 最小 consumer 合同已补齐前向 request/auth v3：只有 source/final，候选只引用一个 `buildProofDigest`，输入绑定固定 selector 和 index 原始字节摘要；final 另绑定既存 source 证据。定向 RED 后，原合同测试文件 79/79 通过（0 fail/skip），仓库合同校验通过（197 文件、78 schemas、128 migrations）。旧 v2 schema 字节不变；生产 session 仍拒绝 v3，此结果不授予读取、解密或恢复权限。

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

服务器迁移的上次只读结果为 126 条完成、0 条活动失败，候选为 128 条。本轮没有重新查询服务器；当时待应用的是 `20260925090000_stage1_operational_completion_terminal_shape` 和 `20260925091000_stage1_operational_completion_settlement_guard`。

R3 路线已按当前收口决策纠正：此前拟做的 prebuild 读取器不属于本期必要路径，草稿已停止，尚未写入生产代码或执行测试。[最小发布决策](../superpowers/specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md)明确延期构建前私有快照依赖；本期构建沿用唯一 `build-proof.v1`，提升前完成合法 snapshot 链。

当前未接线的 `manual-runner-request.v2` 强制要求旧 bundle/dispatch/RC workflow，非商用 producer 授权 v2 也带有同类依赖。不能为适配这些字段恢复已延期平台或填写替代值。本轮 consumer v3 已完成纯合同层面的纠正，保留 v2 历史解释；下一片回到 R3 Task1 的合法快照原件读取。实际权限来源、对象版本、独立保管读回、目的地和消费会话仍须闭合，不能用测试原件替代。只有确需新 producer 时才对齐它的前向授权；已有合法密文不因消费合同更新被强制重生产。

负责人、主机、Docker 恢复和无关容器暂停、迁移对齐及非商用方案的既有授权继续有效。当前无需用户重新登录或重复批准这些事项。

## 证据定位

隐藏工作目录为 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/runner-second-stage/`：

- 原失败与保全：`result-verifier-native02.log`、`result-verifier-native02-preserved-check.json`。
- 最小夹具复现：`native-gh-closure-red.log`、`native-gh-closure-green.log`。
- 同档案核验 RED/GREEN：`normal02-readonly-verifier01.log`、`normal02-readonly-verifier02.log`，后者 report digest 为 `sha256:d81e1a5fa1f2747837b04c691bcf3ed0232d713c8402a641d64210b7818ed6f3`。
- 运行中的 normal：`result-verifier-frozen04.json`、`result-verifier-native03.log`；活跃进程与后续终态以 `root-continuation.json` 为准。
- R3 范围纠正：`r3-prebuild-scope-correction-20260928.md`；此前 `r3-prebuild-input-reader-contract-20260928.md` 的“下一实施切片”建议已撤回，不再按它实施。
- R3 最小合同切片：`r3-minimal-consumer-forward-contract-proposal-20260928.md`、`r3-consumer-v3-red01.log`、`r3-consumer-v3-green01.log`、`r3-consumer-v3-contracts01.log`。这是固定签名/结构校验；其实际输入、消费会话和远端目标接线未完成。
