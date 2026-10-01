# R2.2 Runner 子进程采集限定验证

状态：限定独立审查 Approved，无 Important/Critical，已提交 `3710f11ab4051b87452af9fd57ea940240ea5663`。基线为 R2.2 隔离工作树的 `fd1f88526fb98d40f0e15679137a99728c2bf5a7`。仅修改 `apps/release-runner/src/manual-entrypoint.mjs` 及其既有测试，提交后工作树 clean；未整合主业务候选，R2.2 和阶段 1 继续开放。

已有固定 profile、真实 nonce、MS2 AUTHORIZE/TargetContext、签名交接及单凭证校验之后，子入口接入真实 connector/runtime/领域 adapter。私有采集器在共享 live ACK 校验后才 spawn，采集实际 PID、原始 Buffer、close/signal；按现有帧协议逐项交接，OBSERVATION 与最终 DISPATCH_CLOSED 获 ACK 后发送 ACK_RECEIVED 和唯一原始 RESULT。保留原领域结果快照，不回填未来父进程 close 或改写 observation。

断管阻止后续 SQL 和工具启动，已在途 SQL 不倒推取消。工具先接收 SIGTERM，1 秒后仍未结束则 SIGKILL；3 秒仍无真实 close 时按不完整退出，不制造 CLOSED/成功。事件时间表示首次编码记录时刻，进程退出事实来自实际回调；不宣称它是 OS 内核的精确退出时间。凭证不进入公开父帧、摘要或归档，清理受控凭证引用和缓冲区。

| 验证               | 实际结果与边界                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 初始 RED           | 1 fail，旧 `MANUAL_EVIDENCE_INPUT_REQUIRED`，DB/query/spawn 均 0；初始包装未独立保留 Node exit，不能推定 wrapper exit 等于测试 exit |
| 正例与边界         | genuine dry-run 正例 1/1；10 个关键边界 10/10、exit 0                                                                               |
| 唯一完整受影响文件 | 102/102、exit 0，105130.5074 ms；对应终止边界小修之前的生产源码                                                                     |
| 终止边界反例       | 1 pass / 1 fail、exit 1；事务中途断管已通过，SIGTERM 无效后的强杀计数原为 0                                                         |
| 最终定向验证       | 5/5、exit 0，32573.652 ms；正例、spawn 后断管、观察中断管、强杀与缺 close；未重复完整文件                                           |
| 最终静态检查       | 两文件格式、Node syntax、diff、既有 scoped Node ESLint 全部 exit 0                                                                  |

计数有重叠，不相加。测试使用真实 kernel/codec/connector/runtime/adapter、受控真实 Node 子进程、双向管道，以及临时父存储 create-only/独立重开后的 ACK。PG 最底层、固定 profile/迁移目录映射和固定工具执行边缘为离线替身；不证明真实 DB、Prisma Engine、Docker、宿主持久化或生产来源。没有运行 launcher/CLI 全套、R1/R2 全套、业务套件或访问线上环境。

证据限制如实保留：初始未编号的 `child-collector-green.log` 被 11 次正例尝试覆盖，10 份中间日志未保留；已知失败包括排队事件时间、Windows 固定路径比较、测试工具换行、空迁移夹具和旧测试超时，工具记录仍有对应输出，不重建为“原始日志”。完整文件运行期间生产源码稳定，但测试文件加载后追加了反馈案例；起始测试文件完整字节/hash 未保留，故不宣称最终全文件已通过。最终五项的运行前 hash 与冻结源码一致。

冻结 SHA-256：source `64ea83945a311b9b01123722b2e6b8100ee8d2a3a4a31024b4d5aec311ef311c`；test `badebeabfc61482ae23c6e1f629e4f469af27d2acf387525b266512117cf9c11`；两文件 diff `6f53b456ccc71d89838dd73b9e25c2ec0d7a5c578dcc9bfb31073c7f31b69851`。命令、保留日志、hash 清单和详细报告位于 R2.2 工作树 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/child-collector-*`。

主控独立重算提交前清单 20 项摘要全部一致，并读取实际测试日志。独立 reviewer 核冻结源码、共享接口及测试父存储读回后批准；复审和提交均未重跑测试。记录缺失与最终全文件未复跑的边界不因审查通过而抹去。

父 launcher/CLI 仍 STOP。下一依赖为父端真实持久化与 Runner 交接、独立 expected-schema 来源准入及 R2.3/真实门槛；当前不开放业务发布。
