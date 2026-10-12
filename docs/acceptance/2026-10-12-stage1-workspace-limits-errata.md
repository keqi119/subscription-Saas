# Stage 1：原生工作区格式勘误

续接[准入复用勘误](2026-10-11-stage1-admission-reuse-errata.md)。本轮 RC `38204226514` 的 source-static 成功，source-fresh `114665031289` 失败，其余作业跳过；没有真实负责人 ACK 或 R3 CLOSED。已完成的构建、RAM、签名及归档原件保留，失败 RC 不自动重试。

## 事实与分类

| 问题                              | 证据与分类                                                                                                                                                                                                   | 后续方案及审核要求                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 原生 limits 表头被拒绝            | 隔离 WSL Ubuntu 24.04.4 实际 `/proc/self/limits` 表头为 `Limit … Units     `。解析器要求 `Units` 后立即结束，局部回归在该断言失败。属于代码兼容性瑕疵；原有手写 fixture 省略尾空格，属于测试覆盖缺口。       | 使用原生输出格式；仅容许表头尾部空格/制表符，仍拒绝额外列、启用 swap 或非零 core limit。                                         |
| hosted 首错无法细分               | 实际日志为 `HOSTED_WORKSPACE / ACTIVE / R3_HOSTED_WORKSPACE_CREATE_INVALID`，H1 随后为 `H1_CREATE / ACK_BODY / H1_INPUT_UNAVAILABLE`。未保存 hosted 的内层原始观察结果，不能证明上述解析瑕疵是本轮唯一首因。 | 从首错追踪，不能把下游机器 ACK_BODY 当成人工 ACK 失败；失败诊断必须在局部核查中可区分，不能仅靠再跑长链获取信息。                |
| 历史核对耗时                      | SIGN_HISTORY 在 `04:43:39.896Z–04:49:40.672Z` 成功完成，耗时 360.775 秒；随后才签发短期授权。                                                                                                                | 不把签发前的时间算入签名寿命，不把全部耗时归为重复验签。须依据实际 issuedAt、expiresAt、作业状态及阶段计时判断。                 |
| 探针造成叠加挂载                  | 隔离探针覆盖已有 `/dev/shm`，真实拓扑检查正确拒绝重复受保护挂载。属于测试准备瑕疵，不是已证明的 hosted 环境抖动。                                                                                            | 探针差异应单列。离线移除该行及 swap 行只是合成解析判别，不代表原生或发布验收通过；不修改共享 WSL 挂载/swap。                     |
| 日期展示转换                      | PowerShell 默认 JSON 日期转换改变了展示格式，曾误判 `.000Z` 与 `Z` 的原件差异；直接解析原件后撤销该判断。属于核查工具使用错误。                                                                              | 比较原始字节摘要；字段回读使用 `-DateKind String` 或不转换日期的 JSON 解析器，不凭再次序列化的展示判断原件改变。                 |
| 原生对账脚本混淆协议与注册 schema | `manual-r3-creation-spec.v1` / `manual-r3-job-admission.v1` 是协议版本名，不是 schema registry 条目；对其调用 `validateContract` 确定返回 `CONTRACT_SCHEMA_UNREGISTERED`。属于诊断脚本瑕疵。                 | 在本地真实原件上验证所用入口；固定摘要及协议字段检查与已注册的 operation-record schema 校验分开记录。保留失败原件及清理结果。    |
| 历史状态残留                      | 本轮 H1 已走到消费之后的机器回执处理，但未获得 CLOSED；公钥已清空、固定端口无监听，仍观察到本轮 evidence 账号会话进程。                                                                                      | 先读取本次消费槽、会话、execution 和锁；旧候选的“未消费”或 CLOSED 不能移植。残留进程与台账处置另按本次原件核对，不宣称全局空闲。 |

## 修复与验证范围

生产改动只有 limits 表头正则，增加 `[ \t]*`。解析器回归使用原生尾空格，并验证额外文本仍被拒绝；相邻观察器和创建器 fixture 同步为原生表头格式。既有 core/swap、设备对应、私有目录及资源身份检查保持原义。

新增回归先在原代码失败，修复后解析器 9 项通过；Linux Node 22 的相邻观察器与创建器定向测试 14 项通过、无跳过。同一份隔离采集结果经明确标记的两项输入调整后，修复前解析失败、修复后解析通过；这只证明局部解析修复，不能替代 hosted 原始证据或实际 SOURCE／SNAPSHOT／ACK。

本轮开发前工作区干净，Prisma validate 通过。复用既有服务器 datasource 配置回读，128 个迁移中仍有 `20260925090000_stage1_operational_completion_terminal_shape` 与 `20260925091000_stage1_operational_completion_settlement_guard` 两项待应用；未执行迁移。此补丁不改变业务行为，也不使阶段 1 自动收口。

局部原件保存在工作区 `.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/` 下的 `candidate-4af1e8b-rc-failure-ACTUAL`、`candidate-4af1e8b-sourcefresh-readback-ACTUAL` 和 `candidate-4af1e8b-workspace-local-probe-ROOT_DIAGNOSTIC/capture-once`。后续只推进受影响分段；候选、签名、引用和一次性状态必须按真实绑定重新核对，不能直接重放失败运行。
