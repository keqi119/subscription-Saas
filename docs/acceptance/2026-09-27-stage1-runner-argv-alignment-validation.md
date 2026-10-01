# Stage 1 Runner 启动参数对齐验证

隔离工作树 `stage1-r22-launcher-20260926` 提交 `0612f986f85ece4f8fc39200c8b233ec8d0478aa`，父提交 `3feff2e7e6a419583b69a1550149460f57ecba57`。仅修改既有 evidence 校验器、对应测试与 R2 计划；没有新增业务功能、共享 Schema、导出、CLI 或生产文件，未整合发布候选。

现有共享校验器只接受 `docker run`，无法表达父端实际容器 ID 的固定来源，也无法覆盖 Runner 继承的 PostgreSQL 数据目录 VOLUME。本增量保留实际 `run`，仅允许 attempt 派生的 `/tmp/manual-stage1-${request.attemptId}/runner.cid`，且须与原 `/tmp` tmpfs 和精确 `/var/lib/postgresql/data:rw,noexec,nosuid,size=1m` 配对。无 CID 的历史证据仍只接受原单 `/tmp` 规则，其他安全、镜像和网络约束保持。额外、重复或不成对的参数拒绝。

父端必须独立读取真实 CID 并对该容器 inspect；此校验器不证明这些 IO 已完成。计划明确 [Docker CLI](https://github.com/docker/cli/blob/v26.1.3/cli/command/container/create.go) 写入 Engine 返回的 ID，私有目录的 CreateNew 不等于 CLI 文件具备 O_EXCL 保证；停止事实不明仍为 UNKNOWN。

验证通过现有真实 archive assessor，未使用额外导出、源码变换或生产测试开关：

- 原源码 RED：合法新参数组合在 MS1/MS2 各失败一次，2/2 fail，exit 1。
- 定向 GREEN：21/21，exit 0。
- 最终冻结文件仅完整运行一次：169/169，fail/skipped/cancelled/todo 均为 0，exit 0。
- 格式和 diff 检查通过。默认限定 ESLint 仍有 3 个原有、未改动行的诊断；针对这 3 条既有规则的例外检查通过，不称默认 lint 全绿。
- Sol high 独立审查 Approved，无 Important/Critical；审查不自行重跑测试。主控读取完整回归结果后提交。

源码 SHA256 `43dc5f9dffacfc0793e19710e123d8351f0daa842fdb95c29a8d7e88e895b5d1`，测试 `11fa0a0e3725cf90e76f628855dd823cef09bf8931a49d847aba2ed33d3fafc8`；最终测试日志 `390c87b9800c3ab0e60971b0796975ecaf9513e7c49903e6acf0add4c1043747`。提交前仅删除计划中指向忽略 scratch 文件的一句话，源码和测试摘要不变，未重跑回归；最终计划 SHA256 `5adc65cc3a7c6dee8da23bc4de51235874bc5649ab1b115ae81434238a0588a8`。

原始 RED/GREEN、lint、完整日志、冻结摘要、diff、审查与提交读回保留在隔离工作树 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/runner-argv-alignment/`。本轮 preflight 的迁移状态实际 exit 1：禁用 dotenv 且没有 DATABASE_URL，报 datasource.url required，未接触数据库；Prisma validate exit 0。

后续接通原 launcher 的零凭证 PREPARED、真实 CHALLENGE/PID/raw 和准确停止归档；真实 expected-schema 来源未验真时不得进入命令签名或读取命令凭证。H1、真实 H2/expected 输入、R2.2 完整父端、R2.3/R2.4、R3/R4 和阶段 1 均未关闭。管理员 OAuth 尚未完成，没有新的 RAM/加密配置、迁移、CI 或部署动作。
