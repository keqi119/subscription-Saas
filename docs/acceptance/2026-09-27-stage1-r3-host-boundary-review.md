# Stage 1 R3 宿主与执行权限边界复核（2026-09-27）

本次只读复核发布隔离分支 `9e6829c0`，对照 R3 Task 4、minimal decision §§3.2–5 与 security addendum 的 GitHub-hosted Source/Final 要求。没有运行测试、访问数据库或改变部署。本结论不影响正在实施的 R2 固定服务器首阶段。

## 会改变后续实施顺序的事实

| 已有边界                       | 当前实现与影响                                                                                                                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 固定 H1 身份                   | `manual-stage1-trust.mjs` 的 loader 要求实际 hostFingerprint/principal 等于候选仓库的 owner-binding；H2 又核对同 source SHA 的 profile/owner-binding/入口。复制到 GitHub 临时主机不能通过。把临时主机身份写回候选会改变 source，而新作业又分配新主机，不能当成配置遗漏处理。                              |
| 最终测试的容器身份             | `database-test-entrypoint.mjs:307` 将 Runner 镜像摘要的 hex 部分写为 context.containerId，并非 Docker create/inspect 的真实容器 ID。新启动入口必须提供真实容器读回，不能仅对镜像做 inspect。                                                                                                              |
| 逐套件资源                     | 现有 v1 envelope 只有全局 target/source，最终入口覆盖 selector 的独立赋值。两条链各需完整 37 个 required suite；其中 source-target 套件使外层赋值数为 38。串行执行不能满足隔离。                                                                                                                          |
| isolated-postgres-cluster 套件 | `database-lifecycle.postgres.test.mjs:175–435` 自行运行宿主 Docker/psql，持有 provisioner/migration 凭证，生成内部 runId，使用 TLS disable 和仓库下工作目录，另建两个内部 DB。这与最终 Runner 的 runtime-only、真实 run/marker、TLS、加密目录和禁宿主 socket 边界不兼容；外层 38 个赋值不会修复内部操作。 |
| 历史宿主入口                   | `trusted-launch-production-adapters.mjs` 验证旧 v1 attested envelope 后运行 Compose；它不是 R1/H3 新主机授权，也不能接收逐套件 successor。R3 assessor bridge 同样不能代替宿主启动入口。                                                                                                                   |

R3 的 host launch stop 仍真实存在。把 v1 改成 v2、补局部通过用例或引用 ECS 上的 R2 成功原件，均不能关闭这些差距。

补充静态核对：本业务工作树与发布工作树当前均有 128 个 `migration.sql`，而 `database-lifecycle.postgres.test.mjs:372` 仍断言迁移记录数为 126；该套件实际执行当前迁移后会与硬编码数量不符。应在上述 lifecycle 适配时绑定同候选迁移清单并核对成功迁移身份，避免仅将魔数改为下一版数量。本次未执行数据库测试，也未改动迁移或测试实现。

## 后续顺序

1. **先完成同一授权机制的跨主机设计。** 固定 H1 父端继续保管同 owner 私钥和消费台账。静态 hosted 委托策略可由 profile successor 锚定同候选，实际 job/host/DB 事实在运行时独立验真并由同父会话签发/消费；hosted 执行方不持新的授权私钥，不把 GitHub provenance 本身当数据库操作许可。仍须确定 transport 的身份、有限消息、撤销/时限/断线行为及原件读回。当前无正式 transport，不暗建常驻 broker，不把 Actions 日志/公开产物用作秘密通道。
2. **在同一设计中界定 lifecycle 操作归属。** Docker、provision/cleanup、内部两个 DB 与短期高权限凭据由受控宿主操作承担；最终镜像内保留真实 runtime SQL/post-state 断言。仅允许固定场景/转换，不传任意 SQL、Docker argv 或路径，不将 host 的 passed 布尔值作为测试结果。精确 registry/子协议及失败回执须在设计审查中定界。
3. **再冻结逐套件 envelope successor 和消费者。** 在前两项确定的真实身份/授权来源下，绑定完整 suite ID 集合、各 DB/OID/角色/marker/运行身份与私密引用；同步覆盖外层 trusted entrypoint 与最终 database-test entrypoint。保持旧 v1 历史边界，不向旧 adapter 塞新字段。
4. **最后接同候选两条真实链。** H1/H2、各自新 H3、合法快照及加密/容量事实就绪后，执行原计划 source/final、37-ID 等式和 API/Web readiness。只运行已完成改动所需验证，不用局部单测替代真实链，也不提前重复现有 37 套件。

上述是基于实码的设计前置结论，不是完整跨主机实现规格。profile v3、hosted observation/delegation 与封闭 lifecycle registry 均仅为待细化版本方向；没有生成这些 Schema、生产模块或实际授权原件。维持固定签名私钥不进入 CI、唯一授权机制、GitHub-hosted 执行和真实证据要求，不以减少门槛作为收口。

复核原件位于发布隔离工作树 `.superpowers/sdd/2026-09-22-stage1-r3-final-image-dual-chain-plan/r3-host-contract-resolution.md`；既有 `suite-target-map-readonly.md` 保留 37-ID/38-赋值与历史入口映射。本次没有新测试计数，R3 与阶段 1 未完成。
