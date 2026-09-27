# Stage 1 固定 expected-schema 准入验证

隔离分支提交 `9e6829c01463384da0ca9ddc9e52a5ca1f126fcc`，父提交 `d08be582d6cd488d887ac9ee2e52dc226d813e59`。本增量仅修改既有 launcher、对应测试及 R2 §2.4 说明；没有增加业务功能、共享 Schema、公开接口或生产文件。

实际入口现已接通 R1 已验构建与原始 baseline、零凭证 Runner 的真实 CHALLENGE、固定 expected 输入、同源两次 reference/私有 OSS 原响应闭包，以及两个顺序 gh 验真进程。原件路径、ACL、身份、proof/material、源码及本次 allocation 在关键步骤重新核对；使用既有 schema-expectation 与保管接口，CreateNew 写入并独立重开该 allocation 的 admission。保留期从服务端 Last-Modified 的原始 storedAt 加 Locked210 重算，原始 90 日起点没有改为当前时间。

准入成功后仍明确停在 `MANUAL_RUNNER_REQUEST_INPUT_REQUIRED`；本段没有实现或执行后续命令签发、消费、凭证交付、ACK、H3-B 或完整 R2。既有 target-observe 的授权和观察连接合法保留，验证断言只要求没有新增命令阶段权限、凭证或数据库工作。

独立审查发现并关闭两处 Important：

- CHALLENGE 后 Runner 已退出，但原存活检查只看 stream failure，仍可能接受 admission。真实退出反例先 RED，修复后在准入重查中同时核实际 close/exit/signal，保留原失败和 UNKNOWN。
- 失败 gh 的非 UTF-8 原件进入共享文本 raw 图，阻断后续原 baseline 重读；失败进程的 PID/close 等事实此前也未持久保管。修复复用该 allocation 既有私有输出目录的六个固定文件，先 CreateNew、独立重开完整受限输出或真实截断前缀及过程 capture；两条流均合法 UTF-8 才进入共享文本图。没有删除失败原件、筛除历史、重建 baseline 或放宽 R1/assessor。capture 不是验真、批准或成功准入权威。

验证及实际限制：

- 旧入口真实 RED、两次运行准备失败、所有中间失败与实际退出码保留。首次矩阵在正例和前 16 个拒绝用例通过后发生测试框架 mock 历史内存累计，实际 exit 1；低层诊断后仅限制新夹具的历史保留，没有提高生产堆上限。
- 首次续跑为 17 tests / 12 pass / 5 fail、exit 1，暴露上述二进制归档问题；当时 parent-stream 的宽泛错误断言未证明到达目标检查点，不计其覆盖。后续限定修复组为 8 tests / 6 pass / 2 fail、exit 1，其中唯一叶失败为测试预期错误码与真实 ASCII-header 拒绝码不符；另外四个此前未到达的检查点已有实际 PID、注入或第二次重开证据。
- 最终冻结字节的定向验证为 3 tests / 3 pass / 0 fail，Node 与 WSL 实际 exit 0。连续用例证明：真实无效 gh 输出被拒绝并私有保留后，同一 index/baseline 可以成功准入，原失败字节仍在；同时核六个固定 capture 文件、封闭形状、实际 PID/close/原字节与独立重开。先前不同源码字节上的通过按各自 manifest 保留，不宣称原 28 项矩阵在最终字节上整套通过。
- Linux Node v22.22.2 的私有执行副本与冻结摘要对应；Runner 和 gh transport 是真实 Node 子进程，reference/OSS/attestation 内容仍为有限低层合成响应，不能当作真实 Docker、PG、云端密码学验真或 CI 证据。
- 最终 scoped ESLint、三文件 Prettier、两文件语法及 diff 检查实际 exit 0。原 lint 错误保留；命令仍仅豁免既有 observer cleanup 的 no-useless-assignment 诊断，并显式提供 Node globals，不声称默认全仓 lint 通过。本地静态 Node v24.14.0 与功能验证 Node22 的来源分开记录。
- 独立限定复审 Approved，两个 Important 已关闭；未因冻结、审查或提交重复旧业务/完整测试组。首次 sidecar 身份尚未建立即失败时可能保留不可解析空 partial，仍拒绝成功，作为 Minor 记录。
- 本开发轮 preflight 仅执行一次：禁用 dotenv/移除命令局部 DATABASE_URL 后 migrate status exit 1（datasource.url required），Prisma validate exit 0；没有数据库连接、DDL、迁移或部署。

最终 SHA256：launcher `8adb729bb382a844fa08d89834dcec3eddb910f7f148977f11fb53c3349dbcc1`；test `c36162869ee79b0a17b47a67c622c3bd5cdf6cb39dae882874ebe13a93193b00`；R2 plan `4ebd9f021256b59797e418da51af07dfd80ce21e4a62cab0823d8d0f0e9a38ef`。完整 diff、两代冻结、执行副本摘要、失败/成功日志、实现报告和独立审查位于隔离树 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/expected-reader/`。

本提交尚未整合主候选或推送。R2 隔离分支与原任务的 API/Web 有 21 个历史差异，后续须保留原任务已审业务修复，仅整合发布链增量。原任务业务树仍与 `f82d30e149ded76d958831dfb46f6332fad1e2dc` 一致。

[环境记录](2026-09-27-stage1-environment-and-trusted-input-readiness.md)另保留服务器 GitHub 旧认证 401，以及利用本机 keqi119 现有认证经 SSH 仅入进程内存后成功的实际检查；未落盘或改旧配置。Edge 重连仍失败，阿里云 CLI OAuth 仍待回调，云管理身份、独立 IAM、H1 加密/备份尚未完成。下一步继续原计划的请求/消费/handoff/凭证/ACK、R2.3/R2.4、同候选 R3 每链 37 套及真实 R4；阶段 1 未收口。
