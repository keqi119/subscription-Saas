# R2.2 原始 baseline 复用限定验证

隔离分支提交 `fd1f88526fb98d40f0e15679137a99728c2bf5a7`，基于 `8adc39baa652dfef225874cdaf6ad4cc55a34d39`；只改 `scripts/release/launch-manual-stage1.mjs` 及既有测试。代码尚未整合主业务候选，R2.2 与阶段 1 仍开放。

复用路径从固定私密 archive/journal 独立重开唯一 baseline、原 request/consumption/execution/result/post-state 及 MATCH custody。完整性或身份不符、缺失、多义均停止，不分配新观察 attempt、不重读凭证、不连接或重建 baseline。成功分类仍由共享 assessor 完成，返回原 observation 和原读回摘要。

独立审查发现一个 P1：合法 baseline 可指向同 request 下的另一 observation，而共享 assessor 分类的是原执行结果。已最小修正为 baseline、result、post-state 的 observation digest 三者相等，生产修正仅 +8/-2。新增反例先证明合法双 observation 图可通过共享 assessor，再证明旧复用 API 错误放行；同一 reviewer 限定复审通过，无未解决发现。

| 验证阶段             | 实际结果                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| 初始聚焦 RED         | 14 tests / 8 pass / 6 fail；包括原 STOP 与旧源码额外分配观察暴露的后续夹具影响，原日志保留       |
| 初始聚焦 GREEN       | 15/15，exit 0，188167.5906 ms；三个复用顶层案例（其中一个含 11 子案例）及已有 partial-write 边界 |
| P1 反例在旧冻结源码  | 新 case 与 table 容器 0/2，exit 1，32634.1456 ms；预期的 Missing expected rejection              |
| 最小修复后定向 GREEN | 4/4，exit 0，84627.6181 ms；仅两个受影响正例、新反例及其容器                                     |
| 静态检查             | 两文件格式、Node syntax、diff、既有 scoped Node ESLint 均 exit 0                                 |

上述计数有重叠，不相加。没有重跑耗时约 17 分钟的 launcher 全文件、R1/R2 全套或业务测试；复审和提交均未重跑测试。AGENTS 的同轮隔离 preflight 沿用已记录 migrate status exit 1（显式无 URL，无服务连接）与 Prisma validate exit 0；无业务/schema 修改。

最终源码 SHA-256：launcher `115448b874a13a107139581f99f64e1aa51354545f9a40a09794a28462bf21a8`；test `c78185230c322c9630d56df8730945a36aecff8f9980e870991bc528ed629e38`。提交前后相同，提交后隔离工作树 tracked 状态干净。完整命令、历史失败原件、fix1 小 diff 与独立审查记录保存在 R2.2 工作树 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/`。

父入口仍止于 `MANUAL_RUNNER_INPUT_REQUIRED`。expected-schema 来源、真实父子进程证据/ACK 与 Runner dispatch 尚未完成；本轮没有真实 DB、Docker Engine、云、CI 或部署操作。下一段实施既有 child entrypoint 内的实际进程采集与共享 live ACK，不扩大业务范围。
