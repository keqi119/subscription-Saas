# Stage 1 同作业私有构建输入保管验证

隔离分支提交 `d08be582d6cd488d887ac9ee2e52dc226d813e59`，父提交 `09bacf942d3e11a991e461911e8da513d8148135`。本增量修改既有 H2 producer、两份既有测试、Docker workflow、两个精确生成目录的 ignore 和 Task 10 接口说明，共六文件；未增加业务功能或共享契约。

受保护构建作业现有调用链已在源码中接通：原 H2 producer → 原 expected-schema producer → 同一固定 OSS binding 的有限对象保管。只复用该次调用实际创建成功的 proof，独立读回原字节及元数据，不重复 PUT，也不从对象存在、冲突或未知写入推断成功。旧 H2 收据接口、expected producer 和 storage 方法合同保持。

第一步生成的私有 pending 原件通过步骤输出的 SHA256 绑定后续读回。receipt、provenance、expected.sql 各用现有固定 action 单独 attestation，并在同 source/run/attempt 验真；原 proof gh 验证字节也完整保管。有限 native collector/verification/bundle 支持原件沿同一固定绑定普通 create/Get/Head 保管，避免无限递归。最后才创建并独立读回私有总索引、发布非秘密定位摘要；中途失败保留既有对象，不返回成功定位。

公共 Actions 两份原产物及其读回步骤保持不变，仍报告 authorityCustody=INPUT_REQUIRED。私有收据、expected 原件和保管原件未加入公共产物。生成目录的精确 ignore 解决 workflow 输出导致 expected producer 工作树检查失败的问题，原源码干净检查不放宽。私有中间表不填写未来 owner/profile/批准/导入/CI 成功事实。

验证及限制：

- 新入口缺失 RED、首次组合 1/6 的失败及后续 proof 验证原件反例日志均保留。嵌套 reference raw 的可达集合修正后，组合 6/6；最终新增定向组 14/14、exit 0，覆盖去重、完整集合、独立读回、冲突/未知写入、摘要/run 不符及最后发布顺序。
- 旧测试组、业务套件和已通过的 producer/storage 全文件门禁未重跑。参考进程和存储仍为低层替身，不是实际 Docker/PG/OSS 成功。
- 原 H2 函数、原公共产物/读回块、固定 action 版本、三个独立 subject、workflow 调用顺序/pending SHA、inline Node/Bash 语法检查均 exit 0；workflow YAML/格式和 diff 检查 exit 0。未声明全仓 lint/回归通过。
- Sol high 独立合并审查 Approved，未发现 Critical/Important；八项冻结摘要与提交前后文件相符，工作树干净，未为审查或提交重跑测试。本地主控观察 Node v24.14.0，不冒称最终 Runner Node22 实测。
- 开发轮 preflight 只执行一次：禁用 dotenv/移除命令局部 DATABASE_URL 后 migrate status exit 1，准确错误为 datasource.url required；Prisma validate exit 0。无数据库连接、DDL 或 Staging 两项待迁移执行。

producer SHA256 `98f60e098fac5ac2010543f833d7c30dbb2aef495dbb90aa54612c56c17b60e1`；workflow SHA256 `e925804b5c3f744bc02e823ac301404be9cb0e0894c5308aac5b7c919912ad6c`。完整 diff、失败/成功日志、静态检查、冻结摘要、独立审查和提交证据位于隔离树 `.superpowers/sdd/2026-09-25-stage1-trusted-build-input-preparation-plan/same-job-custody/`。

本提交尚未整合主候选、推送或启动 workflow。真实 IAM/OIDC、H1 加密/密钥/独立备份、同候选参考运行/私有保管/完成 CI、owner 固定导入仍未完成。既有 900 秒 STS 会话不自动刷新，真实运行超时会失败关闭；尚无实际耗时证据。本桶 BPA=true/policyPublic=false 已在上一段真实读回，不再列为未配置；管理员 OAuth 最新检查仍等待回调、无配置文件。

下一段在原 R2 launcher/test 实施 §2.4 的固定 expected-schema admission，复用已有文件/ACL/原件读回与归档；当前零凭证入口仍停在 MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED。后续请求签发/消费/凭证/ACK、R2.3/R2.4 和 R3/R4 继续开放，阶段 1 未关闭。此报告只登记本增量，不把离线代码审查当真实发布验收。
