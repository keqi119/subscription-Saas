# Stage 1 主线执行索引

## 2026-09-27 R3 宿主权限边界前向核验

[只读复核](2026-09-27-stage1-r3-host-boundary-review.md)确认 R3 不能仅修逐套件 v2 映射：固定 H1 主机绑定与临时 hosted host、以镜像摘要代替容器 ID、lifecycle 套件自行持有 Docker/provisioner/migration 权限均有实码差距。后续先定界同 H1 父端的委托通道与 lifecycle 操作归属，再冻结 successor/宿主入口；当前仅登记设计前置，未新增协议/权限或运行测试。R2 父命令链继续实施，R3 与阶段 1 不因本核验关闭。

## 2026-09-27 云端 IAM 配置与服务器账号边界

OSS 账号 `1457643390906675` 的官方 CLI OAuth 已完成，固定 GitHub OIDC provider、证据 writer 与 audit-reader 双角色及各自唯一最小策略已创建并逐项 API 读回。[配置记录](2026-09-27-stage1-cloud-iam-configuration.md)保留实际响应、准备失败及权限边界；尚未运行真实 CI/OIDC 交换或对象保管，H2 不因 IAM 配置完成而关闭。服务器 `139.196.227.195` 的实例 metadata 实际归属账号为 `1335332669126231`，与 OSS 不同，已发起独立服务器账号 OAuth 待回调；云盘加密仍 UNKNOWN。R2 父命令执行链继续离线实施，真实 H1/R2/R3/R4 与阶段 1 仍开放。

## 2026-09-27 固定 expected-schema 准入前向登记

隔离分支提交 `9e6829c0` 接通实际 R1/原 baseline/零凭证 CHALLENGE 后的固定 expected 输入、两次 gh 验真、原件保管与独立重开。真实子进程提前退出和失败二进制输出阻断后续 baseline 的两个 Important 已修复并获限定复审 Approved；[验证记录](2026-09-27-stage1-expected-admission-validation.md)保留最终定向 3/3/exit 0、全部中间失败和不同测试字节边界，不声明 28 项矩阵最终整套通过，也未重跑旧业务组。成功后仍停在下一命令请求门槛；完整 R2、真实云身份/H1/H2、R3/R4 与阶段 1 继续开放。服务器 GitHub 可使用已验证的进程内认证路径；Edge 重连仍失败、阿里云 OAuth 待回调。尚未整合或推送候选，后续保留原任务已审 API/Web 修复，仅接入发布链增量。

## 2026-09-27 同作业私有构建输入保管前向登记

隔离分支提交 `d08be582` 接通原 H2、expected-schema producer 与固定 OSS binding，在同 source/run/attempt 完成去重保管、三个独立 attestation、有限支持原件与最后私有总索引。[验证记录](2026-09-27-stage1-same-job-custody-validation.md)保留新增定向 14/14/exit 0、原始失败、workflow 静态检查和独立审查 Approved。旧接口、公共产物清单保持，未重跑旧套件或整合/激活候选。真实云身份、H1、同候选 CI/保管、owner 导入和 R2/R3/R4 仍待完成；下一源码段为现有 R2 固定 expected reader，阶段 1 未关闭。

## 2026-09-27 私有原响应读取与本桶访问状态前向登记

隔离分支 `09bacf94` 补齐既有 OSS binding 的有限 native body/响应字段采集，旧方法合同保持；跨 await key 绑定 Important 经真实 RED、最小修复和独立复审关闭。[验证记录](2026-09-27-stage1-h2-storage-binding-validation.md)区分原定向 3/3、旧受影响 1/1、最终修复 1/1、真实 exit 与既有 Prettier/本地 Node 限制。另用既有项目身份实际读回本桶 BPA=true、policyPublic=false，两项 200，无需云写入，临时 helper 已移除；独立 IAM/OIDC 角色和真实 custody 仍未完成。下一步为同作业有限对象保管/导入与 R2 expected reader；未重跑旧套件，阶段 1 未关闭。

## 2026-09-27 父端零凭证启动链前向登记

隔离分支提交 `2b42e5d5`，原 launcher 接通同一 session 下的 PREPARED、实际 Node 子进程 CHALLENGE/PID/raw、精确 CID 停止与归档边界。[验证记录](2026-09-27-stage1-parent-zero-credential-validation.md)区分修正前 11/11、Windows 2/2 与最终修正定向 5/5，保留行为 RED、运行准备失败、真实 exit 和默认 lint 限制。空 CID 过渡及公共目录 nlink 两项 Important 已修复并通过独立复审；未重复旧套件，未整合候选。可信 expected-schema 缺失仍在命令签发/凭证前停止，真实云配置、完整 R2、R3/R4 和阶段 1 均未关闭。

## 2026-09-27 Runner 启动参数对齐前向登记

隔离分支提交 `0612f986`，为真实 `docker run` 限定增加 attempt CID 文件及固定数据目录 tmpfs 配对，历史单 tmpfs 证据仍兼容。[验证记录](2026-09-27-stage1-runner-argv-alignment-validation.md)保留 RED 2 项、定向 21/21、唯一完整文件 169/169/exit 0 和独立审查 Approved；默认 lint 的 3 个既有诊断未被隐去。未重复业务套件，未整合候选。下一步为父端零凭证实际进程采集与停止归档；真实云身份、可信输入和阶段 1 均继续开放。

## 2026-09-27 expected-schema 固定输入接口对齐前向登记

隔离分支提交 `3feff2e7`，补齐初版生成器与既有 R2 精确 provenance 接口的差距，保留完整进程原件并实现有限逐对象取回；私有参考 Origin 修正 `f2bbbd97/9dec7a8c` 先获 DOC Approved，共享 H3 规则不变。[验证记录](2026-09-27-stage1-expected-schema-producer-validation.md)保留旧源三个真实 RED、最终冻结文件 7/7/exit 0 和独立代码审查 Approved。未整合主候选或执行真实参考库/云保管，阶段 1 继续开放。

## 2026-09-27 H2 收据到固定 consumer 前向登记

隔离分支 test-only 提交 `a1a968c0`，真实 producer/foundation 生成的收据通过既有固定 consumer；旧 `github://` 一致输入在存储写入前拒绝。独立限定审查 Approved，最终 Node22.22.2 新增两例 2/2、actual exit 0，108 个 Linux 执行副本摘要相符；[原始记录](2026-09-27-stage1-h2-internal-custody-validation.md)保留权限和运行准备失败。未重复全套测试，未发现新生产缺陷，真实云保管和阶段 1 仍开放。

## 2026-09-27 H2 私有存储适配层前向登记

隔离分支提交 `356f0fbd`，新增固定 bucket/run 的短期双身份存储适配层，独立读取服务实际 ACL、保留期、加密与原字节。SDK 调试凭据输出和版本 XML 根节点丢失两项 Important 经真实 RED、最小修复及限定复审 Approved。[验证记录](2026-09-27-stage1-h2-storage-binding-validation.md)保留初始 9/9 和最终冻结 11/11、原 scratch 路径修正及本地 Node24 限制。未整合主候选、未启用工作流；真实 IAM/BPA、云端 custody 和阶段 1 仍未完成。

## 2026-09-27 独立 expected-schema producer 前向登记

隔离分支提交 `42bb7ec4`，实现宿主源码核验与固定 Runner 内两套独立参考库生成。唯一清理 Important 已修复并获限定复审 Approved。[验证记录](2026-09-27-stage1-expected-schema-producer-validation.md)区分初始 3/3 与最终修复定向 1/1，保留真实 RED；未重复全套。代码未整合主候选，尚未运行真实参考库或接私有保管、attestation、R2 准入，Task3 和阶段 1 继续开放。

## 2026-09-27 H2 内部 producer 前向登记

隔离分支提交 `bbaf9710`，新增内部构建证据 custody producer，复用既有 proof/receipt 保管并补 material 原字节独立 Get/Head。独立限定审查 Approved；新增文件唯一测试 24/24、登记检查通过，未重复业务或全量门禁。[验证记录](2026-09-27-stage1-h2-internal-custody-validation.md)保留 RED、lint 全局配置修正和 hash 后置记录限制。未接真实 OSS/CI、未整合主候选；H2、expected-schema 和阶段 1 继续开放。

## 2026-09-27 子进程采集与 ACK 前向登记

R2.2 隔离分支提交 `3710f11a`，子入口接通真实工具进程采集、共享 live ACK、原始结果和有界异常清理，限定独立审查 Approved，无 Important/Critical。[验证记录](2026-09-27-stage1-r22-child-collector-validation.md)区分唯一完整文件 102/102 与最终限域小修的定向 5/5，保留日志覆盖和起始测试字节未冻结的限制；未重复完整文件或业务套件。代码未整合主候选，父端/CLI 仍 STOP，expected 来源、H1/H2 与后续真实门槛仍未完成。

## 2026-09-27 原始 baseline 复用前向登记

R2.2 隔离分支提交 `fd1f8852`，从原始归档及独立读回链复用唯一 baseline；缺失/冲突拒绝且不重新观察。独立审查指出的同 request 双 observation 关联 P1 已修复并通过限定复审。[限定验证记录](2026-09-27-stage1-r22-baseline-reuse-validation.md)保留初始聚焦 15/15、修复反例 RED 与定向 4/4，未重复完整 launcher 或业务套件。代码未整合主候选；父 Runner 仍 STOP，后续 child collector、expected 来源及完整 R2 门槛继续开放。

## 2026-09-27 构建运行链接兼容修复前向登记

Task10 的运行链接格式修复已接回 `ea3f6d6e`、`b7efeccc`：工作流统一生成精确 HTTPS run URL，delivery verifier 闭集兼容原 `github://` 及 HTTPS，proof/material 必须同一表示，手动准入仍严格要求 HTTPS。[限定验证记录](2026-09-27-stage1-build-run-reference-validation.md)保留一次 76/83 夹具失败、稳定版本 83/83，以及独立审查指出混合格式夹具缺口后定向修正的 1/1；最终审查批准，整合字节一致。没有触发 CI、取得 OSS custody 或部署；Task10 整体仍开放。

## 2026-09-27 授权目标观察增量前向登记

R2.2 本地目标观察增量在隔离工作树提交 `900b978bc55d8a4c2e7d399d1ce47764251ad970`：接通真实 R1 session/sign/consume、固定 observer 凭证、只读 SQL 观察、归档独立读回和原始 baseline 保存。独立代码审查及两处旧测试断言的限定复审通过。[原始验证报告](2026-09-27-stage1-r22-target-observe-validation.md)保留单次全文件 **157 tests / 155 pass / 2 fail / exit 1**；21 个新增用例均通过，两个旧计数断言修正后的定向验证 **4/4、exit 0**，没有把原全文件失败改称全绿，也没有重复全文件运行。

该提交只在 R2.2 隔离分支，未整合业务候选。原 baseline 的后续图读取、expected-schema、父子进程收集/交接与 Runner dispatch 尚未完成，R2.2 和阶段 1 仍开放。真实服务器工具及数据库差异见[环境准备记录](2026-09-27-stage1-environment-and-trusted-input-readiness.md)；没有实际执行迁移或部署。

状态：**P0/P1 本地开发准入已完成并通过独立审查。** P1.0 旧目标及 P1.6 新目标均完成精确退役、五文件归档及独立读回，本次新目标停用窗口已结束。P1.1–P1.5 实际证据保持：控制脚本单测 41/41、API 单测 4074/4074、五项主线 fresh suite 104/104；126 条迁移、status、diff、validate 均通过。真实副本、候选全量/双链、固定 Node22 最终制品、供应商、浏览器及 Stage 1 人工验收均未执行。

范围：A/B进件—审核—方案/预约—单次确认—签约归档—主动支付/核销—交付激活—账单/催收—无争议正常结束。

## 2026-09-25 审计后实施前向登记

用户已批准 [审计驱动收口计划](../superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md)，以下登记不改写旧历史状态。

- F5 预检修复已提交 `c99a2ce9`，离线 16/16 通过；退款额度独立，不再阻断主线。
- B3 Task3S 单行 oracle 已整合为 `338bad80`，独立干净源码 `05af3223f79b3f166c4271de1fb2400d2b83429c` 上六文件 171/171、唯一 fresh 3/3 通过，custody 独立读回通过、运行目录已回收。[实际证据](2026-09-07-stage1-b3-contract-archive-transition-validation.md)保留两次旧失败和 Node24/真实供应商等限制。
- F4 协议修复聚焦 4/4 通过；完整四文件 248/249，唯一 Prisma 版本探测超时；串行复核中断且没有 close。任务 3 尚未收口。[离线修复记录](2026-09-25-stage1-offline-fixes.md)包含失败、中断和局限。
- F2 取消/拒绝、审核、门户确认与建单权威锁修复已接回本分支，最终代码提交 `9ee850b1`、证据 `b671ba8d`。独立干净 source `23f575edb53d7faa27cbcec1c4807f3ed6da6e48` 上 integrity fresh 19/19、七文件 unit 161/161、tsc/lint 通过；独立评审 ACCEPT，custody 完整回读、运行目录已退役。[F2 实际证据](2026-09-25-stage1-application-authority-validation.md)保留全部 RED、误判与修复历史。
- F1 商业漂移检查与人工重新报价恢复已接回，最终代码 `05c8d99b`、证据 `be2e9d28`。独立干净 source `35353517d3499c5fde22a5525bd8e1ab04133c31` 完整 fresh 31/31、20 文件 unit 324/324，tsc/lint/契约/发现检查通过，custody 读回及最终独立评审 ACCEPT。[F1 证据](2026-09-25-stage1-commercial-plan-validation.md)保留反例、队列时序诊断、两轮重新报价/确认及旧请求重放验证。任务 1 限定 F1/F2 修复闭环；任务 6 的 B1/B2 剩余矩阵及阶段 1 仍未关闭。
- F3 错误金额不写支付单的修复已接回 `0b32fd17`，B5 正向重复派发用例 `a3c1e657`，证据 `3819088c`。独立干净 source `46e8f95aa7ffbc045f7c6a672956f242325ff004` 顺序完成 billing fresh 17/17、maintenance fact fresh 15/15，四文件 unit 64/64、tsc/lint/契约/发现检查通过；两套 custody/readback、退役与独立终审 ACCEPT，Task4 复用当前 pair，没有重复运行。[F3/B5 记录](2026-09-06-stage1-b5-payment-and-billing-validation-record.md)保留真实 RED 与中间实现失败，并明确维护事实业务响应/镜像来源仍为合成边界。任务 2、7 限定收口，不代表真实付款、维护运行或 Stage 1 签字。
- F4 后续完整门禁已关闭：精确字节判定的 Schema 编译复用已整合 `2cd87533`，证据 `98565931`。干净 source `fc1b1806` 原四文件 249/249、exit 0，Schema 回归 17/17，独立代码及原件审查 ACCEPT；旧失败和中断分类不变。[完整门禁记录](2026-09-25-stage1-parser-full-gate-validation.md)绑定实际 source、140 项输入及日志摘要。任务 3 限定收口；R2 实现、最终 Node22 和阶段 1 继续开放。
- B1 续接验证已整合 `2eb520fb`、`40b07747`，证据 `ff64a11e`。独立干净 source `7ad53559` 四文件 unit 112/112、ESLint/API tsc 通过，原 golden-path fresh 1/1，唯一新 receipt 与原始/canonical 摘要读回一致、目标退役、独立终审 ACCEPT。[B1 记录](2026-09-25-stage1-intake-business-wait-validation.md)保留既有 Prettier 基线例外和 fixture 证据边界。限定 B1 关闭；任务 6 的 B2 真实服务矩阵仍开放。
- B2 销售协助进件的门户确认回读缺陷已整合 `f3630d52`，证据 `e6f85b36`：真实 PG 先 31/32 RED，限定一行修复后干净 source `62a7567a` 完整 32/32、exit 0；三文件 unit 84/84、API tsc/ESLint 通过，custody/readback/退役及独立终审 ACCEPT。[限定修复记录](2026-09-25-stage1-sales-assisted-confirmation-validation.md)保留无 Journey 销售进件/其他客户拒绝边界、真实 A/B 路径与 fixture 限制。完整 B2 的竞争和回滚矩阵继续开放。
- B2 完整本地矩阵已整合 `cbbfc58b`、`84abe0aa`，记录 `e24cd92f`。最终干净 source `a92b2f66` 的 integrity fresh 38/38、API tsc/owned ESLint 均通过，custody/readback、退役及独立终审 ACCEPT。[B2 矩阵记录](2026-09-25-stage1-application-order-matrix-validation.md)保留首轮 37/38 夹具前置失败，限定真实预留竞争、独立 revision/hash、并发幂等、合同写后回滚和既有 F1/F2 回归。结合 B1 原 source 的 112/112 unit 和 golden-path 1/1，审计收口计划任务 6 的本地证据范围关闭；不影响旧冻结 Task6，也不替代 B4/B6 或最终候选证据。
- B4/B6与F6本地闭环已整合，记录 `91ec97f8`：实际测试source `0e9d966d` 同源串行五套fresh为激活3/3、恢复29/29、退租90/90、schema14/14、repository59/59，共195/195，无skip/filter/todo/cancel；集成unit178/178、API tsc/owned Lint/Prisma validate通过。真实激活事务、业务提交后ACK恢复、完成审计/回滚、清单与定价重放及两条前向约束兼容已验证；五套report/receipt独立读回、目标退役及代码/正式证据终审ACCEPT。[完整记录](2026-09-25-stage1-activation-and-operational-closure-validation.md)保留各次失败原件、旧Task9原因未知异常及合成存储/签署/归档输入边界。审计任务8本地范围关闭，阶段1整体不关闭；R2.1适配器与共享MS2工具调用schedule组合仍在实施，R2.2/3与真实输入/候选验收继续开放。
- 审计任务10的[可信构建输入准备方案](../superpowers/plans/2026-09-25-stage1-trusted-build-input-preparation-plan.md)已整合 `9aae3dcb`，DOC-only 独立终审 ACCEPT。方案明确 H1 真实身份/五根目录/独立恢复、H2 私密保管与双 attestation、独立同源 expected-schema 的两次复现、原始 Schema/script 保管和准入次序，并登记现有 CI run URL 与 receipt attestation 引用的最小生产兼容修复范围。仅方案完成；实际 H1 文件、批准私密存储、生产修复、可信 CI/固定导入和真实来源验证均未完成，任务10整体仍开放。未因该文档执行密钥、CI、存储、数据库或部署操作。
- 2026-09-26，R2.1与R1 MS2工具调用兼容修复的本地范围已整合：adapter/observer `c30dfc26`、MS2 schedule `0e51aaad`、最终观察ACK封装 `8fa78a4b`，正式记录 `90386a00`。实际干净测试source `ba57efea` 于9月25日完成八文件343/343、exit0，无fail/skip/cancel/todo；9月26日独立复算14输入与日志/close、代码和正式记录终审ACCEPT。原分支Runner/foundation整树及14测试输入与实际测试字节一致，整合后contract/discovery仍176文件/68Schema/13命令/128迁移及95/39/56/0。[本地组合验收](2026-09-26-stage1-r21-offline-integration-validation.md)保留62聚焦、339旧轮、动态观察RED/修复、默认lint及Node24/double边界。仅关闭任务9的R2.1部分；R2.2/3、真实来源/collector、Node22/H3与阶段1仍开放，下一步细化三类固定私有输入后实施R2.2。
- 用户说明服务器端本系统 Docker 当前全部停止。需要线上联调前先核对并恢复本系统容器、验证健康；当前本地测试不依赖线上。
- 2026-09-26，[R3 最终镜像双链方案](../superpowers/plans/2026-09-22-stage1-r3-final-image-dual-chain-plan.md)已整合 `b137f74e`，DOC-only 独立审查 ACCEPT，文件 SHA256 `0a76caf1f8f3504eb715f0001a1d1c233d4ec918be9159aef4dfefd4efd6cf95`。两链各需全部37个 suite，六 batch 只覆盖30个；计划登记最终入口共用 DB、普通卷/明文副本、版本化外层 consumer 和宿主 launcher 缺口，并区分测试 DML 能力与 R2 只读 verify。新宿主 launcher 切片尚未定义，新 host/physical target 的 owner/profile/H3、合法副本和加密边界仍未就绪；仅方案完成，任务12与真实双链继续开放。
- 2026-09-26，[R4 Staging 签字方案](../superpowers/plans/2026-09-22-stage1-r4-staging-signoff-plan.md)已整合 `7a1d8122`，DOC-only 独立审查 ACCEPT，文件 SHA256 `5b6fff2c244dc443790a7046ebd93325dd1c95ab4ff80f448b2abd4f09cb78d0`。方案覆盖停止的本系统 Docker 恢复/健康、A/B及成熟结束样本、五模板、两次非空维护和外部事实恢复边界；按当前服务/UI修正工单、delta、inspection、定价/重新提案、放行/运营完成及完成前导出顺序。实际工单关闭、重新提案及所需终态导出 UI 入口仍须核实，缺失则停止并交接实现。未开展线上恢复、部署、真实付款/签署/通知或浏览器验收，任务13与阶段1仍未关闭。
- 阶段 1 签字、最终 Node22 三镜像、真实渠道/浏览器、snapshot 双链及外部操作仍未完成。
- 2026-09-26，R2.2 三类[固定私有输入定义](../superpowers/plans/2026-09-06-stage1-r2-runner-migrate-verify-plan.md#23-r22-私有输入补充范围2026-09-26doc-only-独立审查通过)已整合 `6adae09c`，DOC-only 独立审查 ACCEPT。新增 expected 来源/两 subject 验真及同请求 expectation 闭合、H3-B 正常与 UNKNOWN 恢复读回、四角色凭证与父子网络映射；R2.3 须独立重验实际 attestation，历史 gh 输出仅作历史证据。无新共享 Schema/export 或生产文件扩围，R2.2 八文件实现继续；实际 producer、身份/凭证、人工权限及来源证明仍未提供，不登记真实准入通过。
- 2026-09-26，后续静态审查确认 R4 两项 Web 代码缺口：[正常退车浏览器修复计划](../superpowers/plans/2026-09-26-stage1-return-browser-gap-plan.md)已整合 `bd577824` 并通过 DOC-only 独立审查。限定补检查工单的受权操作入口，以及正额正式计价新增账单后的提案刷新/原账单重绑；六生产＋六测试文件，不放宽后端 CLOSED、财务 hash 或权限校验。开发前基线 source `5c57416e` 的本地 fresh asset-operations 33/33、保管读回/退役及 skip-dotenv Prisma validate 通过，run `f933a187-a04b-4255-9039-436950c28731`、receipt `72de56cb-9140-4f7a-bb0b-64290112f85f`，报告摘要 `sha256:1ace227dc87b67e0d0de685ea9dbe156675e6c8697216543fe9ba35508eb01a1`；该基线与本分支当时 API/Web 字节一致。当前按该小单元实施，尚未取得修复后完整门禁或浏览器证据；未恢复线上或使用真实外部渠道。

- 2026-09-26，离线实现切片状态已通过 `5e8b44d2` 前向登记。R2 metadata 两窗口修复 `83e91242` 经真实4 RED→4 GREEN、完整72/72与独立复审；归还工单入口 `4568006b` 的Web 65/65、类型/lint及独立审查通过，HTTP/服务组合测试 `acf75c4f` 经静态审查、controller 57/57和lint/格式通过。三者仍位于各自实施分支，尚未整合本候选；完整R2父子执行链、草案刷新单元、修复后同源PG和实际浏览器仍在推进。R2 READY前消费关联复用既有共享接口，不新增协议或授权入口；任何局部通过不替代完整门禁。

- 2026-09-26，断点续接事实经 `0bf3eab1` 前向同步：R2 child 两文件 `73eeaf26` 的91/91与独立限定审查通过，证据止于受控授权/凭证拒绝边界，完整真实父子执行仍未闭合。ExpectedImport 实际私密服务 Get/Head/ACL 格式、固定消费绑定及身份未提供，保持输入未就绪。R4源 `f02af8de` 离线87/87 Web、197/197 API通过，但首轮完整expiry fresh为91/94、exit1并已保管读回/退役；新增fixture调度隔离及人工定价证据集合缺陷正在按已审窄追加修复，首轮失败原件不覆盖。上述实施提交尚未整合本候选，实际浏览器、线上恢复与阶段1签字均未完成。

- 2026-09-26，本地正常退车修复已整合：检查工单入口 `225c9913`、草案刷新 `c6d313fe`、人工定价证据成员修复 `ee549f41` 及相应测试/格式后继；[正式验收](2026-09-26-stage1-return-browser-gap-validation.md)为 `dd078c48`，前向状态 `9163b00e`。实际同源 `a86ed407` 完整PG退租94/94、资产33/33共127/127，API七文件225/225、API类型及14文件lint通过；Web87/87及类型来源、最后纯格式后继准确保留。三轮report/receipt独立重开核验及退役、代码和正式报告终审限定ACCEPT，原91/94与44个bad-port失败不覆盖。整合后API/Web整树与已审提交一致，契约176文件/128迁移/68Schema/13个命令契约、发现95/39/56/0通过。实际浏览器与完整R4仍待，未恢复线上Docker、部署或运行真实渠道。
- 同日，R2 H3-A固定reader `d854a608` 在最终冻结字节上完整parent+CLI109/109、exit0并经限定复审；新增37聚焦与完整109重叠，不累加。合法材料仍止于RESOURCE_INPUT_REQUIRED，真实来源/资源、session/expected/credential/DB与完整R2.2未关闭；该WIP与child切片保留在独立实施分支。新发现的财务审批幂等键接线及WAIVER/WRITE_OFF证据成员风险已形成[独立实施计划](../superpowers/plans/2026-09-26-stage1-financial-approval-evidence-plan.md)并开始TDD；未把该后续单元或阶段1提前记为通过。
- 2026-09-26，财务审批接线 `8c068885`、证据ID并集 `fb9a5df2`、真实PG组合 `84533176` 和[正式验收](2026-09-26-stage1-financial-approval-evidence-validation.md) `5a48c1cf` 已整合。实际干净source `0ca44e6e` 原expiry98/98、asset33/33，共131/131；五文件unit186/186、API类型/三文件lint/diff通过，报告/receipt独立重开校验、七项权限与精确退役及最终独立审查限定ACCEPT。两类型真实双人批准及减免/核销、证据缺项、余额/结算版本漂移、处置重放均验证；原API/Web字节与已审源一致，契约/发现仍176文件/128迁移/68Schema/13命令及95/39/56/0。后续优先细化财务审批未知结果重试（服务器首次时间、稳定key/body/proof、严格读回、上传未知状态），Registration仅列防御改进；R2外部输入、最终双链和真实浏览器/渠道仍开放。本轮未恢复线上Docker或扩大为阶段1完成。
- 同日，审批重试的[五生产/四测试实施计划](../superpowers/plans/2026-09-26-stage1-financial-approval-retry-plan.md) `8f961324` 已经v2独立DOC ACCEPT，保留服务器首次时间与完整payload、严格UI读回及upload-unknown边界，未向HTTP开放回填时间。主控已建立原生产源PG RED与API/UI代码两个独立工作区，依赖/Prisma准备通过，按现有完整expiry取真实反例后再修后端；界面另行TDD。仅启动实施，不把前轮PG131/131或设计接受改称重试实现通过。

- 2026-09-26，财务审批未知结果重试与签署审计顺序修复已精确整合，见[正式验收](2026-09-26-stage1-financial-approval-retry-validation.md)。实际干净执行源 `f82d30e149ded76d958831dfb46f6332fad1e2dc`：API9 607/607、Web2 115/115、完整 expiry112/112 与 asset33/33 共145/145，types/lint/diff全通过。后端核原收据/事实后复用服务器首写时间，前端冻结key/body/proof并严格读回；签署task按完整snapshot唯一因果链校验，拒绝分叉/循环/重复ID。代码、最终原件及报告获独立限定ACCEPT，11文件与已审源一致、报告/receipt/七项权限和精确退役已复核，保留98/102、110/112、111/112及类型/文档格式中间失败。Registration仍低优先级防御项；下一依赖为真实H1/H2/expected-schema输入→完整R2→Node22最终三镜像每链37套→恢复服务器Docker后真实A/B及成熟样本、渠道、维护/恢复与签字。未进行线上联调或关闭整体阶段1。

- 2026-09-27，R2.2 H3资源观察增量 `e7a1b5e1` 已在独立实施分支提交，见[正式限定记录](2026-09-27-stage1-r22-h3-resource-observation-validation.md)。修复独立审查发现的网络/卷驱动秘密输出后，同源完整launcher/child/CLI237/237、exit0，六输入摘要不变，静态/契约/发现通过。固定只读Docker检查与两轮资源读回、原件/index重查已实现，当前仅支持明确本机回环映射；真实Docker CLI只连接合成Engine管道。合法输入仍在target-observe会话前停止，未读取私钥/凭证或连接DB，也未恢复线上环境。此处只前向登记，WIP代码不整合主候选；R2.2/3与实际H1/H2/H3/expected、最终Node22及阶段1仍开放。下一步按既有计划实施授权观察/baseline与父子MS2闭环，不重复财务已收口单元。

- 2026-09-27，用户已指定签名主机 `139.196.227.195`、负责人 `keqi119` 及既有 snapshot bucket，并批准配置缺失基础设施、按发布要求对齐迁移和暂停无关容器。见[环境与可信输入准备记录](2026-09-27-stage1-environment-and-trusted-input-readiness.md)：Staging 数据库已启动且健康，实际 PG17.10；126 个已应用迁移与本地校验和一致，待应用两个 9 月 25 日迁移，无未完成迁移。无关 MVP 五容器经项目/完整 ID 核对后优雅停止，数据卷保留；旧 API/Web 仍停止。未执行 DDL、候选部署或外部渠道操作。Edge 已有人类管理登录，但浏览器工具连接失败；云身份、加密根和独立备份仍待实际配置，不能把主机/bucket 名称记成 H1/H2 通过。离线 R2 授权观察施工继续，阶段 1 未收口。

历史代码基线：Task 5 `1f0b0439`。Task 6 提案保管：`457c0011`，不代表批准。
Task 6/29R/30/I 系列冻结，Task 30 stash 不变。
历史准入入口：[P0/P1 准入实施计划](../superpowers/plans/2026-09-06-stage1-p0-p1-admission-implementation-plan.md)，已关闭，不重跑。当前前向工作按下节及既有[主线/最小发布计划](../superpowers/plans/2026-09-06-stage1-mainline-minimal-release-implementation-plan.md)执行。

## 当前主线与独立退款边界（2026-09-07 前向登记）

本对话用户批准业务验证/定点修复与最小发布入口两线继续推进，主 agent 协调。下表批准版本不是整包实施通过；单项结果仅按实际主控交接登记，不移用 P0/P1 历史计数或 B3 失败记录作为当前候选证明。

| 工作项                      | 已批准版本 / 当前限定状态                                                                                                                             | 下一边界                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| B1 进件与业务等待           | 计划 `9f2165bd`；主控交接：Task 1 已独立审查 Approved，提交 `0e1cbe5c79b4d6e76310a7dca1e3cf8119e88166`，两文件 unit 54/54、目标文件格式检查通过       | Task 2–4 及 fresh 尚未开始；不登记 B1 整体通过                       |
| B3 合同归档                 | Task 3S 计划 `2886d911` 已批准；历史 Task 3R 为 counted `FAILED`，不改判                                                                              | 原指定任务独占施工/唯一 fresh；本索引不派发、不重跑、不新增通过结论  |
| B5 支付与账单               | 计划 `16adab17` 已批准，限定测试/证据                                                                                                                 | 按已有小计划推进；未取得本轮实施通过证据，产品修复须反例与另批       |
| R1 最小发布信任入口         | 计划 `f969b655`；R1.1 因八种 manual 记录/验证器入参字段尚未完整封闭而停止，待人工澄清                                                                 | 未写 R1 代码，不登记完成，不自行扩大接口                             |
| R2 人工 migrate/verify 切片 | 计划 `477fd583`；主控交接：R2.0 两文件提交 `5a16ca8ad6bff6e4e922b1ef739e731bd61ffe56`，独立审查 Approved，主控 focused 8/8、执行者默认 Runner 122/122 | 本机 Node24 结果不是最终镜像实测；R2.4 `NOT_RUN`，不登记 R2 整体通过 |
| B2/B4/B6                    | 下一批                                                                                                                                                | 不在本轮新增计划或提前写验收结论                                     |

退款按既有微信商户平台“退款管理”，通过商户订单号或微信支付订单号关联原交易，独立批准后单次人工原路退款、同单查询及财务复核。退款核验、完成或财务收尾不阻断 Stage 1 实施、候选提升或主线验收签字；`stage1.refund` 保持独立 `must-external-verify`，缺证据仍缺失，不能写成退款/财务通过或 N/A。正常免押、仅测试租金等限制只约束该退款路线，不扩大到全部 A/B 样本或主线付款。

支付继续使用既有微信 API v3；真实付款、回调与核销仍为主线必需证据。不开发退款 API、不配置退款 notify URL、不改支付 callback，不自动转入接口开发。原单关联、独立资金批准、额度、单次提交、UNKNOWN 只查询及财务安全保持；实际资金/隔离事故仍触发主线安全停止，不能用退款独立口径豁免。

**现有实现待对齐：** `scripts/stage1-golden-path-production-preflight.mjs:155-164` 仍无条件要求退款额度并拒绝其高于付款额度。本轮仅文档/登记同步，未改该脚本/测试、未运行总预检；按新范围使用总预检前需用户另行批准窄范围实现对齐，由主控审查执行，不伪填额度、跳过 blocker 或声称运行门禁已改。这是既有预检实现差异，不是退款核验/财务收尾阻断主线。

P0/P1 保留以下历史完成证据，不重跑；合法 snapshot 输入按用户“尚未准备”保持 `INPUT_UNAVAILABLE`，不主动导出或搜索秘密。真实候选、唯一可信 build proof、最终镜像 fresh/snapshot/readiness、通知独立批准、callback 隔离及 B4–B6 仍有各自门槛。Task 6/29R/30/I、cloud/OSS/WORM 继续冻结。以下表格及运行段落均为原 P0/P1 历史登记，不将当前两个单项完成扩成候选或 Stage 1 签字通过。

## P0/P1 初始状态与历史证据

| 项目                                     | 初始状态          | 证据/限制                                                                                                                                                                                                        |
| ---------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本轮执行 SHA、批准引用、日期、stash 指纹 | P0.1 已实际记录   | SHA `645c89277d60d50bbdbba0e8bc6456e42cba5ab1`；本对话用户批准 `645c8927`（P0 可按序执行；P1 技术计划获批；P1.0 实际退役另行授权）；2026-09-06 14:02:33 +08:00；stash `b299ceeed80374d181998f8ef485629beba56b5f` |
| 两项人工决定                             | 口径已对齐        | 非业务验收；`FINAL_PLAN_DECISION`、`DELIVERY_EVIDENCE_DECISION`；车辆分配不另加内部批准                                                                                                                          |
| PG17 身份/迁移状态                       | 本地开发自检通过  | 新 PG170011；126 条迁移全部应用、status 最新；migrate 身份自检，不是独立只读 verify 或候选证明                                                                                                                   |
| Schema validate / 实际 DB diff           | 分别通过          | 源码 validate exit0；受控新库实际 diff exit0/无差异，原件及 checkpoint 分别保留                                                                                                                                  |
| API unit / 五项主线 DB suite             | 本地执行通过      | 303 文件/4074 单测；五套 fresh 共104项，全部执行/通过且 report/custody 读回；非候选全量或 snapshot 证明                                                                                                          |
| 合法副本及读取/使用授权                  | INPUT_UNAVAILABLE | 用户此前确认“尚未准备”；本轮已再次询问受控元数据索引，尚无新材料。未搜索秘密、下载副本或触发导出                                                                                                                 |
| WSL/LUKS/宿主分页/备份排除               | NOT_VERIFIED      | 不等于已允许获取数据                                                                                                                                                                                             |
| 唯一可信 CI build proof                  | NOT_RUN           | R1/A2，不创建本地候选替代                                                                                                                                                                                        |
| 人工 launch authorization                | NOT_IMPLEMENTED   | R1/R2                                                                                                                                                                                                            |
| Admin/Portal 浏览器                      | NOT_RUN           | A1/A3                                                                                                                                                                                                            |
| 电子签/主动支付/通知                     | NOT_RUN           | 外部验证独立登记                                                                                                                                                                                                 |
| 成熟正常结束/两次有效维护                | NOT_RUN           | B5/B6/A1/A3                                                                                                                                                                                                      |
| Stage 1 签字                             | BLOCKED           | 以上实际验收条件未完成                                                                                                                                                                                           |

## P0 静态/单元门禁证据

运行 SHA：`645c89277d60d50bbdbba0e8bc6456e42cba5ab1`。最终门禁运行窗口：2026-09-06 14:13:13–14:13:24 +08:00。

| 命令                                                                                                                                                                                                                   | exit | 结果                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0.2 文档契约 PowerShell 断言                                                                                                                                                                                          |    0 | `P0_DOCUMENT_CONTRACT_PASS`；`stage1LegacyCount=0`，六条 applicability 记录各一次，两项人工决定的五个计数及“两个 ManualTask”证据条目各一次                                     |
| `pnpm release:contracts:verify`                                                                                                                                                                                        |    0 | 159 个 repository contract 文件、59 个 Schema、13 个 command contract、126 条 migration；当前 digest `sha256:6388e7018f81ad6a46d7d53e96f9ec0e8827e86473e95112f0fd79c2d5410b6a` |
| `pnpm release:database-tests:discover`                                                                                                                                                                                 |    0 | `candidateCount=92`、`manifestedCount=36`、`exceptedCount=56`、`unclassifiedCount=0`；这是测试目录分类/适用性发现，不是执行数据库测试                                          |
| `node --test scripts/stage1-golden-path-production-preflight.test.mjs`                                                                                                                                                 |    0 | 14/14 passed，0 failed，0 cancelled，0 skipped，0 todo；这是无外部副作用的单元测试，没有运行同名 production preflight                                                          |
| `pnpm exec prettier --write docs/acceptance/2026-09-06-stage1-mainline-execution-index.md docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md release/contracts/external-validation-applicability.v1.json` |    0 | 三文件格式化完成                                                                                                                                                               |
| `git diff --check`                                                                                                                                                                                                     |    0 | 无输出                                                                                                                                                                         |

repository contract digest 从 HEAD blob 基线 `sha256:f9dc8a91e137aaeebef86fed53af744a3cdbb13cf44a35f5dd07161441f85be5` 变为 `sha256:6388e7018f81ad6a46d7d53e96f9ec0e8827e86473e95112f0fd79c2d5410b6a`。主控按现有 catalog identity/RFC 8785 算法只读复算 159 个 HEAD Git blobs 并逐项对比；只有 `external-validation-applicability.v1.json` 的字节 hash 改变，已排除换行差异。后续候选必须重新生成可信 `build-proof.v1`。

私密原件只记录受控索引和脱敏 digest；不入库原始 URL、凭证、客户/订单标识或合同。

每次运行记录：执行 SHA、命令、时间、精确退出码、测试计数、非秘密目标身份、原件位置/digest、失败阶段、下一责任包。没有输出就保留 NOT_RUN，不根据历史测试数填通过。

## P0.7 只读材料盘点（2026-09-06）

P0 提交后由独立子 agent 盘点，主控只读复核报告并单独合入索引。WSL 已注册 `Ubuntu`、`docker-desktop` 两个 WSL2；专用 `stage1-snapshot-local` 未注册。宿主 `wsl.exe`/`openssl.exe` 存在，宿主 `cryptsetup.exe` 不存在；没有启动发行版或执行 guest 命令，不能据此判断 guest 工具状态。

`.wslconfig` 不存在；有效 swap/guest swap0、per-input LUKS、备份排除仍为 NOT_VERIFIED。宿主自动分页已启用且有活动 pagefile，休眠能力和 crash dump 配置存在；这些观察不证明私密输入保护合规。没有安装、配置、挂载、生成密钥或读取 payload，R3 输入授权未获得。

只读报告原件（本 worktree 相对路径）：`.superpowers/sdd/2026-09-06-stage1-p0-p1-admission-implementation-plan/task-P0-inventory-report.md`；SHA256 `5b5e3fa5d61adb9a2c28fb5f3b640d5805bc0fbde9b61009c81f4a1a15ecb314`。报告记录具体命令和退出码；10 次盘点调用及 2 次辅助调用全部 exit0，包含两次 WSL 输出编码规范化的只读复跑，不是 12 项合规门禁。

P0 主控门禁记录：同目录 `task-P0-controller-verification.md`；SHA256 `0a00f92b0f2e4ba0b5ddab3df781643acfe233f2bd6463c69e52533103c0cb97`。上述本地记录不是可信发布证明。

## P1.0 只读核查与原批准停止点（历史）

运行 SHA：`debc3ad21ba3684022274f198d81c55b6e09c1ac`。2026-09-06 14:18–14:21 +08:00，确认本地 Docker `desktop-linux`/`npipe`，无 ambient DB URL/PG 连接变量或 DOCKER_HOST override；工作树及已用私有路径无重解析点。仅核对本计划精确目标，未调用 migrate、清理入口、目标登记或退役锁。

| 精确目标           | 14:18–14:21 只读结果/当时拟议处置（实际授权及退役见下文）                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 容器               | `8ad87116924cdf709f9c40df94a32bc4a06cd3f832e177523501a6ef724a1ea8`；拟精确删除                                                                                                                                                       |
| 专属 PGDATA volume | `04fe0d650f040d1d5f91d66bf1a58ab31980f6a4165d478112b5f034e356c84e`；实际仅由上述容器引用，拟精确删除                                                                                                                                 |
| runId / 来源 SHA   | `ba53ccd1-5814-4e4a-aa47-2077ea4a9908` / `f8ed944030646bb697c4724e9071b1151e64e5ef`                                                                                                                                                  |
| 数据库 / OID       | `s1dev_f16ae0ba9f509196ff67fb93` / `16387`；只读身份与 record 一致                                                                                                                                                                   |
| 镜像               | `docker.io/library/postgres@sha256:7bade6d532592ca8ce7ee32def7399dad2607c4ea5583839fc4352a095a11ea6`；wrapper 核对实际镜像、marker、角色与 PG17 身份                                                                                 |
| record 字节 SHA256 | `423fd2117c2e819afd84760013617b22d793b10911eca9873fa89faeba27f380`；只读核查前后未变                                                                                                                                                 |
| 原记录迁移头       | `20260901010000_stage1_schema_drift_convergence`；本轮未读取迁移表，不是 migrate status/diff 通过证据                                                                                                                                |
| 当前其他连接       | 2026-09-06 14:21:31–14:21:33 +08:00 通过 verify wrapper 执行计划中的 `BEGIN READ ONLY`/计数/`ROLLBACK`，`other_sessions=0`、exit0；不能替代 owner 停用窗口                                                                           |
| 拟归档的五文件     | `.release-local/controlled-target.v1.json`、`.release-local/secrets/bootstrap.json`、`.release-local/secrets/migrate.json`、`.release-local/secrets/verify.json`、`.release-local/secrets/runtime-test.json`；均存在，未输出凭证内容 |

归档目标依批准计划为本 worktree `.release-local/p1-retirements/` 下新建且不复用的 owner-only UUID 登记目录根部，**没有额外的 `archive/` 子目录**；此处纠正旧索引措辞，不修改批准操作。沿用 CreateNew、逐文件处理和独立读回。归档不是凭证字节销毁；卷中数据库内容删除后，不能靠五文件归档恢复。

以下普通本地会话记录位于 `.release-local/p1-operations/<operationId>/`，`result.json` 绑定 command/stdout/stderr/transcript 的字节 hash。主控独立读回 hash/身份、确认 owner-only ACL；不是新的 execution proof Schema。

| operationId / 步骤                                                                                  | exit / 状态                                                                                                             | result.json SHA256                                                 |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `a8b22a36-9148-4dbd-aa6a-1acb825ef462` / 临时只读容器核查                                           | 1 / FAILED：主控临时命令误写标签键；尚未执行数据库观察。失败原件保留，不改判成功                                        | `15a25d448913eeefcd4d25cb3a0167e965043f411f04c4749694e6a774298323` |
| `f6bd17c9-900b-4b6e-adfa-bcbceb7c484c` / 标签键修正后的独立只读核查                                 | 0 / 已核对：按既有入口的 `subscription-s1-controlled.run-id` 对照实际标签，仅修正临时只读命令，不改仓库/容器/原失败记录 | `ea609e44e859999e5b679ac32b97789b26e40f84904c6aea63988a2c9ffc2140` |
| `05732551-8025-40c1-a57d-cb55fb421ca4` / `with-controlled-target.mjs --profile verify` 只读连接计数 | 0 / 已观察：既有 wrapper 先核验真实身份，随后运行计划 P1.0 原样 SQL；无业务行或迁移表读取                               | `374f1335379a55cb908a5527b3ccb9449302abaece0278069a8e2c51c8d3c843` |

上述历史停止点已由本对话用户明确确认解除：旧目标仅含可丢弃开发数据、无保留需求，所有消费者及 record 写入者暂停至归档读回结束，并批准删除列明精确容器及专属卷、归档五文件。没有沿用批准前观察作为删除门禁。

## P1.0 实际退役与独立读回

执行 SHA：`debd50d6904b58169cf83b1da27d6e738651024d`。2026-09-06 17:03 +08:00，批准后的新 operation `44f8bb27-a28f-47b0-8d0a-de720edc7f68` 原样执行计划中的 `P1.0-pre-retirement-and-exact-cleanup`：固定锁/record guard、精确身份/卷专属性/路径核验、fresh `other_sessions=0`，gate PASS，退役 COMPLETE/COMPLETE、exit0，readback VERIFIED。

精确旧容器及卷均已删除，固定 record/secrets 源路径均不存在。五文件直接归档至 `.release-local/p1-retirements/518ae6aa-c3a4-4a99-81d1-950f87478cc0/`；目录还有初始 record 和 registration 两份原件，不是额外移动的文件。五文件均 owner-only ACL，归档 record hash 仍为 `423fd2117c2e819afd84760013617b22d793b10911eca9873fa89faeba27f380`。主控和独立 reviewer 分别复算 hash、核对 ACL、源路径和 Docker 实际缺失；未读取四份 secret 内容。

| 原件                                                | SHA256                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| registration UUID 目录的 `target-registration.json` | `4d0e68be110b2df41365e26acf1f5957f9be752aacfd6e0a36fa0a8f4feebf34` |
| operation 目录的 `result.json`                      | `daf3a8d09716506da1abf180aec4ebb5c769f8c9d37d32df991d6ce3a8c10d0a` |
| `pre-retirement.json`                               | `3cae12237a3d891d8dfe52f1080a4326306a78339200fc49ac7f7cd427e113a5` |
| `retirement-result.json`                            | `b00f98364e0cb82c1e3f110cce5f77e6de8d73c10c54ca5e48dfb6c85d78f3ad` |
| `retirement-readback.json`                          | `fa762731aa1929970669e551419d1644e5d5c26320b4a61bf19f1108b229ef56` |

两次调度失败也保留：第一次误将尚待批准 helper 创建的 `p1-retirements` 根作为必需现存路径（`P1_REQUIRED_PATH_MISSING`）；第二次 fenced-block 选择器错误（`P1_BRIEF_BLOCK_SELECTION_FAILED`），均 exit1、发生在 registration/退役 operation/删除之前。主控逐次只读确认旧资产完整；改为静态核验的单次调用后才生成上述唯一实际退役 operation。没有把失败改判成功或重试 UNKNOWN 删除；正式计划、脚本未修改。

本地 SDD 记录根为 `.superpowers/sdd/2026-09-06-stage1-p0-p1-admission-implementation-plan/`：`task-P1-retirement-report.md` 保留上述历史；独立 `task-P1-retirement-review.md` 结论 CLEARLY APPROVED，SHA256 `6173c56bc616ffddbd081d7ab689f94ec6084dd253477487855cfb2ff87a884b`。均为普通本地记录，不是可信发布证明。

## P1.1–P1.5 本地合成库开发基线

执行 SHA 同上。P1.0 独立通过后，依据用户对 `645c8927` P1 技术计划的批准执行；没有借用旧目标窗口作为新回收批准。实测 Node24.14.0、pnpm11.4.0、PowerShell7.6.4、Docker29.5.3，本机 `desktop-linux`/`npipe`，无 ambient DB URL/PG 或 DOCKER_HOST override。无真实副本、业务客户数据或外部服务调用。

以下 15 个 operation 的目录均为本 worktree `.release-local/p1-operations/<operationId>/`；每个 `result.json` 绑定同目录 command/stdout/stderr/session 四份原件字节 hash。最终主控逐一核对 15 个 operation、60 个日志 hash、source/argv/exit，均通过。

| operationId                            | 实际命令                                                                                                                                                                                                   | exit / 结果                        | result.json SHA256                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `bdc80486-c74b-47fa-97e8-0792f76215dc` | `node --test scripts/release/bootstrap-controlled-postgres.test.mjs scripts/release/database-test-launcher-cli.test.mjs`                                                                                   | 0；41/41，fail/cancel/skip/todo0   | `8ea8a558e1de4ce110b3ea0426be1cc8d2d6fcf85f039709f81013465f940f19` |
| `e98bfdb1-6079-4fe7-b0aa-40dcb8ab9497` | `node scripts/release/bootstrap-controlled-postgres.mjs --output .release-local/controlled-target.v1.json`                                                                                                 | 0；新空库，锁内立即登记专属卷      | `719bde6e54a2e97ef7977fbd4ddf1229cb6fe23421c9813935da57f3e037e409` |
| `250c630a-419b-4fa6-badb-d8e35409307d` | `node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma`                                       | 0；126条全部应用                   | `4825dfa0a34f18ac883fd9be8832684440b253155bebba8239dbf8937e4e2abe` |
| `00e4e521-c6a2-4a8c-a02c-1c0bc356bc85` | `node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma`                                       | 0；最新                            | `8881d3d873cc1d7263484727de24bd14fd963ebda8208ce7d3c95250ad2aa321` |
| `cc2c8102-a6d2-46e1-b4fc-e4267a17a719` | `node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | 0；无差异，随后立即保存 checkpoint | `a672c100567eff5aa09f064eefb00d44a6e4eb48a40f87dc3e3827fb38a6487a` |
| `b49c0761-f681-402a-9628-89e59644a41b` | `node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:validate`                                                                                                                 | 0；源码 Schema 有效                | `ca046156e17c09ae8ac90e4fd16ab3097385cc6b528e6e3400a8db5e58bf6228` |
| `2cc64a04-77fd-4a4b-a485-5a46229efafe` | `pnpm --filter @subscription-saas/shared build`                                                                                                                                                            | 0                                  | `7f0c3d6d9fe4875c5910778fd71cde8e1a4e7e9e2946192c1dd2492fdde61fe9` |
| `9053c75e-5f15-4dfe-a26c-7cb010fb7c4f` | `node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:generate`                                                                                                                 | 0                                  | `425bdab526626f890bfe5e746795f279661c718b2ef2f4b30390bff60bb4c641` |
| `d70ebe05-4c57-4659-9ce4-47ed0a0ec20c` | `node scripts/release/with-controlled-target.mjs --profile verify -- pnpm --filter @subscription-saas/api test:unit`                                                                                       | 0；303文件/4074测试全部通过        | `d5aef82c16c2b0d20efc355f8b24c643d9ef63e1bd051b2e166b2cb4d5647f06` |
| `9e352e16-c63d-4dbd-b6c8-099e97d8c060` | `pnpm release:database-tests:discover`                                                                                                                                                                     | 0；92候选/36纳管/56例外/0未分类    | `392c460ca9789d5d44dc0dadc2fa6c56bd2a4b64c6731c9597bd7fe80ac38740` |
| `2a31f810-d1bc-44ad-8d35-9753354e2bde` | `node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-golden-path.postgres --chain fresh`                                                                                       | 0；1/1                             | `2794b721d3ec6a7a9162d81b943fbfa9633ae2585ee52fa2da3f646b41efaf42` |
| `94d973bc-20bc-4eba-9d10-518498277b47` | `node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-integrity.postgres --chain fresh`                                                                                         | 0；10/10                           | `9f1a12e55adb7383c6a599bc906ff7ebb5c3537807cdc654439382cf9d154bf4` |
| `1e0b1e41-6b6b-4450-aa96-a328bd2c2836` | `node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-failure-recovery.postgres --chain fresh`                                                                                  | 0；5/5                             | `0bf710f5bcb1061161fd221007778db51185ebde713d41af09445fef5081d540` |
| `ed3761d9-3d25-44f1-868c-c1e342a6354c` | `node scripts/release/run-database-suite.mjs --suite-id api.billing-automation.postgres --chain fresh`                                                                                                     | 0；8/8                             | `f3908e6b431face7fe70fec13e3da3d2ce9c6874a4982e9772de618e1e2c7c62` |
| `654c605d-df0c-47e7-bab6-61db6a274a84` | `node scripts/release/run-database-suite.mjs --suite-id api.subscription-expiry-return.postgres --chain fresh`                                                                                             | 0；80/80                           | `88e98317fcea5dca882d5c6d288bf525e482c4c2a85c292c4a34e97f6782d9ba` |

API 单测实际输出 303/303 文件、4074/4074 passed；该 reporter 没有单列 cancelled 数，未补造计数。五套数据库报告分别满足 `collected=selected=executed=passed>0`，failed/skipped/todo/filtered/cancelled 全为0，共104项；各用独立数据库及 runtime-equivalent 身份，不从 wrapper 借 URL。按原循环逐套执行并读回后才推进下一套，未重试或手工清理。

### 五套 report/custody 精确引用

下表报告 digest 均加前缀 `sha256:`；原始规范化报告路径为 `.release-local/evidence/evidence/<digest>.json`，receipt 路径为 `.release-local/evidence/receipts/<receiptId>.json`。`readback.json` 位于上表同套 operation 目录，实际 readback 均 VERIFIED。主控已复算报告与 receipt 字节 hash；raw stdout、canonical report、receipt 和 readback 是不同原件，不互相冒充。

| 套件             | readback.json SHA256                                               | 报告 digest（不含前缀）                                            | receiptId / receipt 字节 SHA256                                                                             |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| golden-path      | `fc173944f2b4ee53e503e606657d123abdf9148684ff7eeccbcb2eaf7c27c453` | `8e0020fcccacefd0495fe24b6da7d9e56eba6a1a3f6f654310078310771799b6` | `4c446342-0cbe-4961-a38b-7dc61d7318d4` / `f92735d5c6824e210d291487340ab12d9f4b0e202c54c5c2220fe466dfa1f5f9` |
| integrity        | `267abd43b6551a26f05d598668ae9a3724ae81c89fd47d5dd1b2f561ae8d7924` | `e9fe87e15b688f165b3afaf7b293ce4d1b2e50a2a828d492dfb7a56312067469` | `0afa05d5-2a45-45af-a929-f23bb7bc28c3` / `6e580288d131b776e7ae12b4508a43e39b00b06802e1a0c7bc9f0d64ee962106` |
| failure-recovery | `072afd50f0a9d4caccd2bbede826db8216024fc96e01fd014a395198fc518a08` | `2e062deb131bd4cbed413b021ba000440c1087dfee3cadf9fc6691ac70b118e1` | `5aed9a6d-af80-4613-abbe-8219ffd0f6cb` / `d14858b482db3e5a86b23c959a22405bc6ff3b5b2d40777e81fe0fd29474bc78` |
| billing          | `605bc0c80aab48af3b9747693cd706d5c73f561d363d9b377c91ba057daefbdb` | `ba3d5a5ce075955f664412e9a8d1f8c65ce738b35cf34cffc117e3bfc266bd89` | `2440df20-a60d-4686-aa9e-f8a3bcdfe0d8` / `8d0291aac3d632a75d7750e43d68f50366b1fc1c610cc2591bb8e4ef9165d544` |
| expiry-return    | `3916ee676eed7fa8086537a8d5010b8206c80466b6f35a812a3eaf53d479fff2` | `b1b8d44c42a00dcf5582ab27d12684190fbbabd5c2423cb59bb2ff52e1cc7666` | `2bf1abaa-08a8-4c5c-9b61-e48b9a6acb70` / `fe3bbad69f3058783386fce25a77652857b31968c5ed0cb0f5eba5f90dfc6c1b` |

限制：suite 内迁移/Schema/PG版本观察未单独持久化原始日志，成功测试日志原件也不由 suite CLI 保证；不从摘要补造这些证明。上述本机普通文件及 local-controlled-nonpromotable custody 不宣称不可篡改权威存储。测试用确定性 provider 不是供应商联通证明；本轮只有五项 fresh 开发基线，不是全量 fresh/snapshot 最终 Runner 验收。

### P1.6 新目标清单与原停用窗口停止点（历史）

| 新目标/证据          | 退役前登记身份                                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| container            | `797a4d2e27f756cb863b37480ac2c610cc8412be70355642e240cba0a1ad7aec`                                                                                                                                                                  |
| 专属 volume          | `c444341da882fd083e9f9cd179081a837c04f97b9ace4f4005cef285ce2a596a`                                                                                                                                                                  |
| run / database / OID | `261aeedf-70df-42e4-9ec4-f6dbd4152934` / `s1dev_2039832846a3d34ff332c081` / `16387`                                                                                                                                                 |
| 实际 PG / image      | `170011` / `docker.io/library/postgres@sha256:7bade6d532592ca8ce7ee32def7399dad2607c4ea5583839fc4352a095a11ea6`                                                                                                                     |
| registration         | `.release-local/p1-retirements/71bd3bf5-144f-4b06-b36b-835390d1376f/target-registration.json`；SHA256 `7760e2f104bb2df5e9b6edc64719b75054a2c728748c7e6e2c5ecad93eca38ac`                                                            |
| 初始 record          | 同 registration 目录 `record-initial.json`；SHA256 `a31d3ef677cdbe9373e0506f24e3c3e5db179f4910556f046342813a02996274`；初始 migrationHead 为 null                                                                                   |
| 最终 checkpoint      | `.release-local/p1-operations/cc2c8102-a6d2-46e1-b4fc-e4267a17a719/record-checkpoint.json`；SHA256 `c2e078c73f4cc838b192239fc974753ef23f52ea82bc5351ee2c792603e19fc8`                                                               |
| 最终 record          | checkpoint 同目录 `record-after-migrate.json`；SHA256 `abc658ff01e89eefb4337b3fe155c2373dd83b9fe86eb757e42e8dc9f72b35c9`，与退役前及归档后的 controlled record 一致；migrationHead `20260901010000_stage1_schema_drift_convergence` |
| 五文件归档           | 原 `.release-local/controlled-target.v1.json` 及 `.release-local/secrets/{bootstrap,migrate,verify,runtime-test}.json` 已在 P1.6 移至上述新 registration UUID 根部；固定源路径已消失，未覆盖原件                                    |

新 target 的 container/run/database/volume 全部与旧 target 不同；迁移后稳定身份不变，仅允许 migrationHead 演进。diff 后立即在锁内保存最终 checkpoint，后续无 migrate profile；本轮 deploy/status/diff 使用迁移角色自检，validate 仅校验源码，均不冒充独立只读 verify。

**原停止点已解除：** 用户对 `645c8927` 的批准覆盖新合成目标完整技术生命周期；本次又明确确认本清单所有消费者及 record 写入者已暂停，窗口覆盖至归档独立读回结束。使用的是本次新目标确认，不是旧 P1.0 窗口。此前保留新目标等待授权的记录不改判为提前执行。

SDD 完整执行报告 `task-P1-baseline-report.md` SHA256 `d2f63749c7553190a96f6db6c1eb5f2825b4968a816f1c155b8150aefc317ade`；独立审查 `task-P1-baseline-review.md` SHA256 `88ab39f349dddc6ec3ffa3eb49e1319b0b9ae1767c5e70ede41ec957143b5b95`。P1.1–P1.5 测试未重跑：其执行 SHA 仍为 `debd50d6904b58169cf83b1da27d6e738651024d`，不因后续文档提交改写原件。

### P1.6 实际退役与最终读回

执行 SHA：`17a12b07bd848b5bd0a6d9e775d55c8f89371562`。2026-09-06 19:09:22–19:09:28 +08:00，唯一新 operation `0894d206-604b-4307-9fd4-4f71b8f3a953` 执行批准计划原样 `P1.6-pre-retirement-and-exact-cleanup`。checkpoint/registration/final record 绑定通过，固定锁及 record guard 内重新观察 `other_sessions=0`；gate PASS，retirement COMPLETE/COMPLETE，exit0，readback VERIFIED。没有再次创建 registration、bootstrap、迁移或重跑测试。

上述精确新容器和专属卷已删除。五文件直接移至 `.release-local/p1-retirements/71bd3bf5-144f-4b06-b36b-835390d1376f/`，加上原有 `record-initial.json`、`target-registration.json` 共七文件；五份归档均 owner-only ACL，固定 record 和 secrets 源路径不存在。主控独立复算四个日志 hash、gate/result/readback 链、最终 record/checkpoint 绑定，并核对本机 Docker 实际缺失及归档 ACL，全部通过。未读取四份 secret 内容。归档不是密码学销毁或数据库备份；已删除卷中的开发数据不能靠这五个文件恢复。

| 本次 operation 原件        | SHA256                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `result.json`              | `60ae63f2301e220e8406276d18147817bcb2e460a2f74eb838c7e3518495d7d1` |
| `pre-retirement.json`      | `c5eb89f50b5e4a0f6de806cd109c1e5064dc6cc0c511810294d9ca25213f7ed9` |
| `retirement-result.json`   | `14d28a21d1ba663ac7f4e0a1e8815e1c63b9ce180ec70876ea075a0bd27965c6` |
| `retirement-readback.json` | `01e45b83fa529a1200d288fe373e6c1b51247b50aaa67c1a6bc75c82444f6b7b` |

准备期另有静态检查失败：主控过宽的 Markdown block 前缀匹配失败，主控/执行者各一次 PowerShell 展示命令解析失败，均发生在任何 helper、数据库连接和实际退役 operation 之前；原记录保留在 SDD ledger/report。修正只读检查后，原样操作块和单次调用经双方静态解析/摘要核对才执行。没有实际退役失败、UNKNOWN 或删除重试。

本次 SDD 执行报告 `task-P1-6-report.md` SHA256 `cb904513677d5921f92001912347c7c21abeae20dae021e176dfb8e250af96ff`；独立终审 `task-P1-6-review.md` SHA256 `6406d41c9496b984013a7dc9a9d023afef4ba6de795e34b2f75bd49fe2c11d1c`。独立审查者实际读回上述原件、ACL、精确 Docker 目标缺失及索引，结论 **APPROVED：P1.6 与完整 P0/P1 本地开发准入关闭**，无新增阻断项。主控亦独立通过，并再次核对此前 15 个 operation/60 个日志摘要不变。停用窗口至该独立读回完成后结束。

当时收尾记录（历史；后续批准与当前范围见前向登记）：本次仅修改执行索引；无产品代码、迁移文件、Runner、工作流、RBAC、stash 变化，未 push/PR/部署。下一步只申请 B1/B3/B5 与 R1/R2 小计划审批，不自动施工。Task 6、29R/30、真实副本、Staging、外部施工继续冻结，当前不能进入 Stage 1 人工验收。
