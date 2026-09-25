# Stage 1 离线预检与协议修复记录

日期：2026-09-25。执行依据为用户批准的 [审计驱动收口计划](../superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md)任务 3、4。Node `v24.14.0`，Windows 本地；不是 Node22 最终镜像、真实渠道或发布验收。

## F5：退款额度退出主线预检

提交：`c99a2ce968e93a38257c1adc1b73fdd01d48772e`。

只修改 `scripts/stage1-golden-path-production-preflight.mjs` 与对应测试。主线不再要求退款额度或退款额度不超过付款额度；付款额度、专用资产、payer、真实渠道、通知及禁用代扣检查保持。

执行 `node --test scripts/stage1-golden-path-production-preflight.test.mjs`：新增测试先出现 RED（14 pass / 2 fail），删除过期的退款阻断后 GREEN（16 pass / 0 fail，exit 0）。独立只读审查接受。没有运行真实 preflight CLI。

## F4：收到 LF 的短帧头必须立即拒绝

只修改 `packages/release-foundation/src/manual-runner-evidence.mjs` 和对应测试。在短协议前缀分支要求 `headerEnd < 0`；不改变协议版本、权限、尺寸或错误码。

新增四项聚焦测试覆盖双向 LF 非法头、未收到 LF 的真实前缀，以及 MS1/MS2 原始 interrupted apply 的完整归档恢复。畸形尾部在 ACK_RECEIVED 后、CLOSED stdout 和最终 process 原件之前注入，raw/process/execution 摘要均绑定实际尾部。

聚焦命令：

```powershell
node --test --test-name-pattern="short protocol headers" packages/release-foundation/test/manual-runner-evidence.test.mjs
```

RED：1 pass / 3 fail，两个完整归档反例实际错误返回 `SUCCEEDED`。GREEN：4 pass / 0 fail，exit 0；两个归档均为 `INTERRUPTED_UNKNOWN`、原数据库结果 `unknown`、原因 `MANUAL_FRAME_INVALID`。独立审查接受代码和 fixture 绑定。

### 完整门禁仍未收口

首次完整命令（四个原文件，无过滤）：

```powershell
node --test packages/release-foundation/test/manual-runner-evidence.test.mjs packages/release-foundation/test/manual-stage1-session.test.mjs packages/release-foundation/test/manual-stage1-contracts.test.mjs packages/release-foundation/test/execution-state-machine.test.mjs
```

- 开始 `2026-09-24T16:45:16.918Z`，actual close `2026-09-24T20:47:04.359Z`。
- 249 tests / 248 pass / 1 fail；cancelled/skipped/todo 均 0，exit 1，signal/spawnError 均 null。
- 唯一失败：`installed Prisma complete version Report is read with no DB credentials or project config`，30 秒的 `execFileSync(prisma --version)` 超时 `ETIMEDOUT`。新反例和其他兼容测试通过。
- stdout 24614 bytes，SHA-256 `63078edf9abf2a5004f7e51e29d9590a31278b93aab005656a0522a0ba00972e`；stderr 0 bytes，SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- 启动时 source `c36d9e33dc865f6e65356a0520cf46c830919261` 加本次未提交的两文件补丁，六个记录输入的前后 SHA-256 完全一致。不能称它是该提交本身的原样测试。

隔离复核第一次仍为相同超时。额外只读诊断使用同一已安装 CLI、临时无项目目录和明确非秘密环境，异步进程成功返回完整版本报告；此后原测试单独复测 1/1、exit 0（总计 45.62 秒，包括后续 fixture 判断）。未改 30 秒限制或生产代码；根因仍未确定，不能据此把完整失败轮改判通过。

随后四文件 `--test-concurrency=1` 的完整串行复核于 `2026-09-24T21:07:26.415Z` 启动。线程中断后检查：PID `21704` 不存在、没有 actual-close 原件，部分 stdout 最后停在 legacy v1 apply 测试；只记 `INCOMPLETE_NO_CLOSE`，不推断剩余计数或退出码。观察时间 `2026-09-25T03:17:21.4075349Z`，部分 stdout SHA-256 `0ec03bf7592fabba41c9787e9975061900edbf08bc315de860fad66830cdd3bb`。当前不继续盲目重跑长门禁。

**结论：** F4 的已知反例已修复并通过聚焦验证；任务 3 的完整门禁未关闭，R2 不得借此登记完整兼容通过。

## 原件保管与后续

原 checkout：`D:/Projects/auto-subscription-platform/.worktrees/stage1-s1-execution-infrastructure-20260903`。

辅助原件目录：`.superpowers/sdd/2026-09-22-stage1-audit-driven-closure-plan/`，保留 `preflight-red.log`、`preflight-green.log`、`parser-red.log`、`parser-green.log`、`parser-full.launch.json`、`parser-full.stdout.log`、`parser-full.stderr.log`、`parser-full.actual-close.json`、两个 Prisma 单独复核日志和诊断日志。`serial-gate/` 保存第二轮 launch、部分 raw 和 `interruption-observation.json`，没有伪造 close。

后续先推进独立的 P1 真实服务反例及限域修复。协议门禁须在说明版本探测的运行条件后再作有针对性的完整验证；历史失败和中断记录均保留。B3 的独立 3/3 fresh 结果见 [Task3S 记录](2026-09-07-stage1-b3-contract-archive-transition-validation.md)，不能替代 P1 或协议门禁。
