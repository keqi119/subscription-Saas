# Stage 1 父端零凭证启动链验证

隔离工作树 `stage1-r22-launcher-20260926` 提交 `2b42e5d5ec7c29fe91ca6b02cb20c29579431c03`，父提交 `0612f986f85ece4f8fc39200c8b233ec8d0478aa`。本增量只修改既有 launcher、对应测试与 R2 计划，接通原 `launchManualStage1` 的零凭证启动及失败清理；没有新增业务功能、公开导出、共享 Schema 或 CLI。

原 R1 session 保持打开，沿用实际 target observation、baseline、原 run/operation/key，为新 attempt 保存并独立重开 null-request PREPARED 与真实 argv，再启动固定 `docker run`。CID 来自私有目录内的真实 CLI 文件，父端独立读取并对精确 ID 作非秘密 inspect；真实 Node 子进程测试覆盖 PID、管道、共享 MS2 CHALLENGE 解析和实际 close。固定输出源路径已记入 R2 计划，旧 ref 缺少预留目录时拒绝，不修补 index。

缺少可信 expected-schema reader 时明确停在 `MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED`，未进入 Runner 命令 request/sign/consume、命令凭证交付或命令数据库调用。此边界不否定此前实际 R1 session 与 target-observe 的既定操作。清理独立尝试精确容器 stop/final inspect 和 CLI 收尾；原件保存失败不跳过停止，停止事实不明保持 UNKNOWN，超限流不冒充完整原件。

本轮修复了审查发现的两个 Important：Docker CLI 先建空 CID 再写 ID 时有界等待，以及公共祖先目录正常 nlink 变化导致的误拒绝。私有输入的身份/内容检查保持。另窄化区分空端口映射和继承的未发布 `5432/tcp:null`，仍拒绝实际端口绑定。后者是代码兼容修正：只读基础镜像观察及官方 Engine 源码不等于真实 Runner 容器验收，所选 internal network 还有专门处理。

验证范围与结果：

- 初始 5 次运行准备失败原件保留，不计为行为 RED；随后原入口真实 RED 为旧 `MANUAL_RUNNER_INPUT_REQUIRED` 与目标边界不符，exit 1。
- 修复前的生命周期定向组 11/11、Node 22.22.2，Node/WSL exit 0；两项受影响的 Windows 断言 2/2、exit 0。首次 GREEN 日志缺直接 Node exit 尾标；已启动的不可变脚本补证保留，此后未再重跑该组。
- 审查修正前定向组报告 5 项、pass 1/fail 4（含父级子测试失败汇总），Node/WSL exit 1。最终修正只运行该组，5/5、fail/skipped/cancelled/todo 全 0，Node/WSL exit 0。
- Sol high 独立审查及最小差异复审完成，两个 Important 已解决，复审未见新增 Important/Critical。主控将实际 GREEN、冻结摘要与复审对应后登记；未重跑既有 foundation 169 项、旧 launcher 全文件或业务套件。
- 当前源码/测试语法和 diff 检查通过。限定 ESLint 使用 Node globals，并排除原有未改行的 `no-useless-assignment`；不称默认 ESLint 全绿。

最终 launcher SHA256 `e8aa1e9991bec0a8f6c56c0d621523e5eb1ce90ef1f2c3702bd30d734326d441`，测试 `b584f3857702734b4db9e9b888519eda1cd7077108af003fa33cefd658b058f0`，计划 `8b1280f67f65560b42d2e7bc2de25f7eea27066a7d2804834eda2dec199f3715`。Linux 副本 manifest 与复审摘要相同。原件位于隔离树 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/parent-zero-credential/`，包含所有失败、`20260927-073554-9990432-final-exact-exit.log`、`20260927-074132-0201559-review-red.log`、`20260927-074344-7383931-review-green.log`、两次审查和基础镜像观察。

本段不是完整 R2.2 或阶段 1 验收。Docker native 输出与资源调用在测试中由低层替身提供，未实际运行最终 Runner/参考库/CI/云保管，也未完成 expected-schema admission、后续签发消费/凭证/ACK、R2.3、R2.4、R3 或 R4。代码尚未整合主候选。当前开发轮 preflight 仍是禁用 dotenv/没有 DATABASE_URL 的迁移状态 exit 1（datasource.url required）、Prisma validate exit 0，未重复 preflight 或连接数据库；Staging 两项待迁移尚未执行。

下一段沿用现有 OSS 适配层，补齐独立审计读取的非秘密原响应与固定 expected-schema 导入来源，再接父端 reader；真实 IAM/BPA、加密与备份仍需管理员身份可用后配置和读回。OAuth 尚未完成，没有新的云端变更或部署。
