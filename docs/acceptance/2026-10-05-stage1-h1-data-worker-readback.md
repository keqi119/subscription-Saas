# H1 私有快照数据进程接线核验

日期：2026-10-05。范围：已批准 H1 制作路线中的固定数据进程，尚未执行正式快照制作。

## 已实现

`scripts/release/snapshot-h1-data-worker.mjs` 只接受 root 私有管道中的封闭配置。配置在连接数据库前检查 v2 授权、有效时间、固定仓库和 RSA 公钥指纹；数据库固定为 loopback 上的源库/只读角色和独立临时库/迁移角色。实际连接后再次核对物理数据库指纹、角色及 backend PID。

处理进程使用 UID/GID 65532，与 Runner 的 992/988 分离；工作目录固定 `/work/crypto`，要求 Linux、真实目录、本人所有及 0700。凭据不进入 job、命令行、环境变量或输出；本地 PostgreSQL 工具仅通过私有 passfile 获取口令。

worker 复用现有 source/workspace、19 条脱敏规则、归档扫描和 RSA/AES-GCM 实现。临时数据库客户端关闭后发出绑定本次 run、attempt、backend PID 和随机 nonce 的销毁请求。root 必须实际销毁目标，再发送精确确认并结束输入；worker 确认没有额外数据且收到 EOF 后才能加密。失败或清理不确定不输出 COMPLETE，CLI 以非零退出。

新 worker 和既有 export 入口已纳入 repository contract 文件清单；export 改为直接导入实际依赖，减少固定安装所需的模块闭包。无业务功能或迁移文件变更。

## 验证

- `b20f1c`：5 项私有协议测试通过，包含非法字段、源/目标指纹重合、无销毁确认、跨分片有效输入，以及确认后的延迟额外字节。后者先在 `77dabd` 复现旧实现错误完成，再通过 EOF 门禁修正。
- `6ceb81`：Linux 下既有私有导出/加密组合的 2 项相关测试通过，无跳过。没有重跑完整数据库/应用测试矩阵。
- `a2a1a1`：四个修改的 JavaScript 文件 ESLint 通过。显式补上既有 export 文件的 `node:process` 导入，解决该文件原有 no-undef 诊断。
- 一次有限静态审查，EOF 修补复核后无其他 Critical/Important 项。

H1 实际合成验证 `91463c`：使用两个独立、无外网路由的 PostgreSQL 17.11 集群与 UID 65532 的实际 worker 容器，均施加内存/PID/core 限制。执行代码文件摘要为 `sha256:35c41194d1ee21de17bcd0073574e47a6f1320ac4519bfc976bbdcd363c6b731`；使用本仓库锁定的 20 个运行时依赖包。

实测结果：19 条规则执行完成，源合成手机号未修改；父进程实际确认源会话和目标会话关闭，删除临时目标容器并查无残留后才回传 ACK/EOF。worker 正常退出 0、无 OOM、无 stderr，passfile 已移除。父进程使用临时合成 RSA 私钥解密最终密文，得到的摘要与脱敏归档元数据一致。容器及本次文件全部移除。前一次 `bae597` 也通过，EOF 工序改变后才执行此次必要复验。

独立 SSH `b9fafd` 确认前次探针无容器/目录残留，Staging PostgreSQL 为 running/healthy。探针不读取 Staging、签名密钥卷、GitHub App 凭据或 OSS；这些结果不能作为真实 producer、卷销毁或发布完成证明。

## 剩余收口条件

固定 root controller 与 job 受限交接、JIT 实际路由/终态、正式只读安装闭包、三 job workflow、独立 OSS publisher/custody 身份和真实 producer 尚待接通。随后完成同候选 R2/R3、已授权的两项 Staging 迁移及 R4 验收。

本轮实际迁移预检 `836a75`：仓库 128 项，仅 `20260925090000_stage1_operational_completion_terminal_shape` 和 `20260925091000_stage1_operational_completion_settlement_guard` 待应用；Prisma schema validate 通过。未执行迁移，阶段 1 仍未完成。
