# 阶段 1 恢复执行记录（2026-09-29）

阶段 1 尚未完成。保持原定范围：不增加业务功能，不采用商用 KMS，不重复已通过且未受改动影响的长测试。

H1 清理证据导入、双副本读回、转发关闭观测及共享端口锁释放已本地提交为 `77364d42`，定向及完整整合通过，失败历史保留。后续 final/snapshot 的 source 匹配和消费入口已实现，短回归通过；完整正向链、final/fresh、最终镜像执行、hosted 工作流接线和真实发布验收仍未完成。

## 当前环境事实

- SSH 只读查询 `506f37`：139.196.227.195 可连接；`subauto-staging-postgres-1` 健康运行，Staging API/Web 停止，其余列出的容器停止。本轮未启动或停止容器。
- 配置定位 `4dbf26` 与脱敏读回 `731ffd`：服务器使用 `/opt/subscription-saas/.env.staging.images`，已有 DATABASE_URL，容器内目标为 `postgres:5432/subscription_saas_staging`。凭据未输出或写入仓库。此前本地缺少 datasource.url，不能据此推断服务器也缺少配置。
- 线上迁移只读核对 `731ffd`、`97db00`：128 项本地迁移中 126 项已应用；线上 127 行记录包含一项已回滚历史记录及其后续成功记录。无未解决失败、无服务器独有迁移、无同名校验和漂移。
- 仅待应用 `20260925090000_stage1_operational_completion_terminal_shape` 与 `20260925091000_stage1_operational_completion_settlement_guard`。仍按原发布顺序，在候选证据齐备后执行；本轮未写数据库。
- 脱敏查询结果保存在忽略目录，SHA-256：`a6fc04fb2aae74c0f16e7fc52542a1c63c9d53fbcbcaa2b70aadd6d0e08692a1`。初次查询受服务器 Python 3.6 不支持 capture_output 参数影响，兼容修正后只读查询成功；未更改服务器 Python。

## 本轮代码范围

在既有 source 终态之后增加独立的负责人签收入口。它只接受当前会话已完成的准确终态摘要，重新核对原件和撤销链，将签收记录写入 archive/backup 并独立读回。完成 source 不会自动签收；历史读取拒绝孤立、重复或缺失副本的签收。此记录代表负责人绑定会话的一次独立动作，不等于独立人类签名，也不证明跨会话读取或阶段 1 验收完成。

API 入口定向测试 RED `1bca05`、GREEN `d2fb45`（1/1）；纯签收构建/校验定向测试先失败后通过（1/1）。有限只读审查未发现阻断问题。仓库合同检查 `fd25c5` 通过：234 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:7a2275800b75314145c2e4838a16696c35c4b7903a6363c9601bbdcf998aab35`。

仅为新增签收与缺失备份拒绝运行一次既有 Linux 集成用例：`4dc3be` 自然退出 0，1 pass / 0 fail / 0 skip（测试体 1,386,828.753669 ms，进程 1,448,595.395569 ms）。七份暂存源码与冻结测试副本一致（`6d802a`）。日志 SHA-256：`2b1efbc4613d4354d58b0e1e1073dd6e11c9df2bd1a8992a29d642fb7df8fa47`。

正向验证覆盖真实私有文件、可信会话的独立 ACK、双副本、历史重读及删除备份后的拒绝，保留原 UNKNOWN 和 43 项锁。host、GitHub、Engine、PG、39-original reader 仍为合成边界。native holder 的新入口验证了前置条件拒绝；完整 runSourceManifest 生产器及其 holder 正向签收尚未在真实 H1 运行，不能据此宣布线上验收通过。

随后抽取共享撤销链检查，为跨会话读取提供默认零写入的内部接口。原会话显式保留既有 checkpoint 创建行为；只读分支在缺失、孤立或回退时拒绝。新增 3 项定向检查通过；接回原会话后，签名后撤销/回退定向用例 `f46c64` 通过（1/1）。当前全部代码的合同检查 `59bd7a` 通过：235 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:ea8673abf21d032d261ece4d92108172bfe7e1cab7c92424795f720c00d6e214`。此抽取由独立定向检查覆盖，不在此前冻结的 ACK 长测试副本内；完整跨会话 source 读取仍待实现。

## 后续顺序

1. 签收和关闭会话后的只读入口已在本地集成验证，继续保留真实 H1 验收未完成的状态。
2. H1 清理链的本地整合已通过，接着复用已有 matchingSourceEvidenceDigest，补齐 final/snapshot 消费对 source 的完整匹配检查，再推进 final 执行及 hosted 工作流接线；不增加独立平台或业务功能。
3. 获得合法数据库快照来源确认，完成同一候选的真实 R2/R3 证据。既有 RAM/加密凭据配置已完成，不重建；之前的 RSA 恢复卷不是数据库快照。
4. 应用上述两项 Staging 迁移、恢复对应 API/Web，完成真实 R4 验收。

数据库快照来源问题仍待答复；现有断点也未授权 push、merge 或 workflow dispatch。当前离线工作不依赖这些动作，继续推进。

## 跨会话读取增量

本轮预检 `c8dd75` 为干净的 `8879f03b`；`a11b48` 迁移状态因本地缺少 datasource.url 在连接前退出，`32caf1` Prisma 校验通过。改动仅涉及发布证据读取，未修改业务或线上环境。

共享历史校验按完整档案中的会话分组，复用原件、签名、消费、终态、物理目标记录、source 保管及签收校验，并保留全图孤立记录和 R2 检查。只读入口不创建 OPEN、锁或撤销 checkpoint，不读签名私钥。快照声明在原执行时间重建；现有实时入口仍按当前时间拒绝过期输入。native 入口逐组独立核验固定 H1、构建证明和 GitHub 身份，历史任务允许已结束，返回后仍可检查原件是否变化。

当前证据：新增 API 的缺失入口 RED `2877ea`，GREEN `64b6be`；相关入口防覆盖检查 `fb3a66` 为 3/3。快照事件时间与实时过期检查通过；共享 core 定向 8/8。合同检查 `4daf3e` 为 235 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:ba78b6ad6768c2d5ca544861bb21506509fc6e09255ed4ed8c296f7e47fbed71`；格式检查 `377a7b`、限定源码的未定义/未使用变量与差异检查 `7d41a7` 通过。快照声明抽取已本地提交为 `7c29b99e`。

最终 Linux 整合 `1527d3` 自然退出 0：2 pass / 0 fail / 0 skip，完整 source/历史用例耗时 1,139,894.78711 ms，总进程 1,169,447.709067 ms。它验证原实时 job 门槛、真实私有文件中的 source/ACK/关闭记录、配置过期后的历史读取、无签名密钥读取、证据目录前后不变，以及篡改备份 ACK 后拒绝重读。八份代码/合同文件与冻结副本一致（`10368c`）；日志 SHA-256 为 `fd5e52211764b8085f3bcf7bf72bba9bfb7b8b7de18d42b82ff6d8866f8b8329`。此整合覆盖单个关闭的 fresh source 会话，host/GitHub/Engine/PG 和 39-original reader 为合成边界；不代表真实 H1、完整 native source 生产器或多旧会话接续验收。既有完整快照和数据库长测试未重复运行。

该次提交的剩余边界：只读入口支持按多个历史会话分组，但实时签发仍有全图单会话限制。后续 final 不能直接借只读成功绕过执行授权，必须复用同一校验逻辑接入新会话检查。source 工作区清理及 matching final 仍待接通；上述本地校验不等于真实 H1/R2/R3 或 R4 通过。

## 完整历史接入实时会话（本地验证通过）

预检 `d7a1ee` 为干净的 `c337f266`；`5ca34f` 因本地缺少 datasource.url 在数据库连接前退出，`dab735` Prisma 校验通过。本轮只修改发布基础设施。

旧会话与只读出口现共用完整上下文装载器。旧 source 必须有创建成功、候选执行成功和唯一 ACK；snapshot 分支还必须有完成的消费阶段。当前会话继续独立处理 pending、计数和锁句柄。每次动作重新枚举完整档案，验证旧上下文的原件及固定 H1/H2 来源，然后关闭本次读取对象，避免把前一次读取快照用于合法的新写入。未删除或放宽任何生产环境锁。

新增 Linux 定向检查 `1f114b` 为 3/3、0 skip：已结束 final job 的历史输入在 profile 过期后仍可验证；job 结束时间早于已记录执行时拒绝；两个 API 拒绝调用方权威覆盖。core 原有消费一次、UNKNOWN 不复用及只读缺失终态定向检查 3/3 通过。合同检查 `be623b` 通过，仍为 235 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:7147ad54654066940242604f4425e33f113ebbfd8653b8f8f8693fa84f0f12bb`。格式与限定 Node 源码检查 `5607b2` 通过。

扩展组合验证 `0acec9`（会话 `9397`）自然退出 0，1 pass / 0 fail / 0 skip；测试体 1,378,366.974033 ms，总进程 1,408,549.927154 ms。用例保留真实私有文件、已关闭 source/ACK、41 个物理目标锁，再模拟后续清理已释放两个共享端口槽，验证新会话签发及消费 UNKNOWN、重复签发拒绝及旧 ACK 副本改动后拒绝。新动作确实重新查询旧 job 的来源；消费后的合法档案写入不会使下一次历史捕获失效。三份改动源码与冻结测试副本一致（`be1909`），日志 SHA-256：`52c5bac0aaf9153d2d51c72042cb4f9cc369e3fd28a0b28d0cc1b88471c42aaf`。

测试中的端口槽释放只是明确标注的前提，不是清理实现或清理验收；host/GitHub/Engine/PG 和 39-original 重建仍为合成边界。新会话从固定 job 读取器取得输入后进入真实 core；本用例不声称完整 native holder 的第二轮执行或新目标完成。下一步在已持有同一 job/资源的 hosted 控制程序中显式完成清理，独立读回验证后由 H1 释放两个共享端口槽，继续保留 41 个旧目标锁原件用于历史验证。阶段 1 仍未完成。

## 持有资源的显式清理（本地定向验证）

本轮预检 `a57a88` 为干净的 `f33d788c`；`8baa1d` 因本地缺少 datasource.url 在连接前失败；`75ef04` Prisma 校验通过。只修改发布清理基础设施，未操作云端或数据库。

hosted control 新增无参数的一次性清理入口，从自己仍持有的创建结果、Engine 子进程、containerd、同一 job 和 PG 资源观测取得身份。它关闭转发，依次停止并读回目标容器、删除并读回容器/网络/卷/镜像，确认 Engine 空闲后停止自有进程，再清理工作区。工作区仅接受进程内保留的原创建结果，复查当前配置、磁盘/密钥/挂载身份后，执行普通卸载和固定 mapper 关闭，逐个删除原密钥、backing file、空挂载目录，并独立观测缺席。不使用递归删除、强制卸载或 prune。部分失败保留已执行前缀；普通 close 不自动删除工作区。

控制程序初始接口 RED `d64087`，首次绿色验证的断言不匹配实际退出对象，修正后 `fbd00e` 为 4/4。只读审查随后发现 HTTP 空闲超时及 SIGKILL 后无界等待：精准回归 `90395c` 为 4 pass / 2 fail，修复后的 Linux `f752ca` 为 6 pass / 0 fail / 0 skip，总计 2,838.237504 ms。请求采用独立 15 秒截止计时器，Engine SIGKILL 后最多再等 2 秒；未确认退出保持 UNKNOWN，不清理工作区。RED/GREEN 日志 SHA-256 分别为 `194a993911ecb7452aa56014ff2c7dda7e2bcec6d6bfa56a58524be03c3fbee5` / `1bcad813ebf129bf9a444c169c94727d126b0792c7275a6ae19f2810c2e63b95`。

工作区初始接口 RED `8f24ba`、9/9 GREEN `bf3b84`；新增命令不退出的定向回归先失败，最终 `ee9757` 为 10/10，总计 13,621.2485 ms。120 秒期限后请求终止，最多再等 2 秒；未确认 close 保留 PID、空退出字段和 INCOMPLETE，不继续删除。该文件的测试由 Windows 上的模块替身模拟 Linux/文件系统/命令；控制测试使用实际 Linux Unix socket 和 Node 子进程替代 Engine。两者均不能证明真实 Docker/LUKS 清理或 H1 验收。工作区最终运行没有单独日志文件，以已返回工具输出为记录。

格式、差异和限定 Node 全局变量的源码检查 `c13f40` 通过；第一次通用 ESLint 调用因该目录未配置 Node 全局变量失败，未据此声称全仓 lint 通过。合同检查 `8cdc00` 通过：235 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:577d32e44887d963dcdf5c239baec1334689e3850d15fc6bbb4acf8cd60203b0`。未重复此前 19–51 分钟的历史/source/snapshot 链。

下一步在现有 job 签名和 custody 机制内保存并独立验证清理证据，核对 source/ACK 与转发关闭后只释放两个共享端口槽；41 个旧目标锁原件继续保留。不新增清理授权格式或远程删除服务。合法数据库快照来源、实际同候选 R2/R3、两项 Staging 迁移和 R4 仍待完成。

## 清理证据签名与独立校验（本地验证通过）

资源清理增量已本地提交为 `150a1c1b`。下一轮预检 `e5da6a` 为该提交的干净状态，本地迁移查询仍因缺 datasource.url 在连接前退出；Prisma `98e215` 校验通过。

既有 hosted control 只接受任务私钥，使用内部保存的成功清理记录导出证据，拒绝未完成或调用方替换记录。新增校验复用原始工作区、PG 和创建证据校验器，使用独立签名域绑定原创建字节、operation/spec/job，核对 11 个固定请求、进程实际退出、两个进程缺席、工作区清理命令及最终缺席报告。它证明观测一致性；H1 仍须核对来源目标、source 终态和唯一 ACK、双份保管与转发关闭，之后才可释放两个共享锁。

导出入口有效 RED `f0ec5a`，Linux GREEN `d7aede` 为 6/6、0 skip，总计 2,942.19775 ms；该层使用 codec 替身，覆盖持有记录不可替换和失败不能导出。签名校验器 RED `7682be`，定向 GREEN `489241` 3/3；固定 Docker 版本语义复核发现正常镜像删除还返回数据层摘要，另发现权限 mode 数字的截断边界。两例 RED `964799` 后定向 GREEN `3705c9`，最终校验文件 `21953c` 为 13/13，总计 2,219.0125 ms。随后明确拒绝非字符串 mode，受影响单例 `6730ae` 为 1/1（1,443.7242 ms），未重复全文件。codec 测试为合成数据，只有工具输出，没有独立日志；不代表真实 Docker/LUKS/H1 清理已验收。[固定 Docker 源码](https://raw.githubusercontent.com/moby/moby/v26.1.3/daemon/images/image_delete.go)明确将删除的 layer ChainID 加入响应，发生在 noprune 判断之前。

导出 RED/GREEN 日志 SHA-256：`10e351d0d3e35110ff1e472a3c6e968e78bd0994b3f462602d2d60bafde9eeab` / `28b65618a3b811c6621ffbfc7334a0644984c98af21fd6382d432f658da59435`；两份 control 文件与 Linux 测试副本一致（`367df4`）。当前工作流尚未调用新 hosted holder；这与 H1 清理台账、matching final、合法数据库快照、实际 R2/R3、两项 Staging 迁移和 R4 一并保持未完成。

最终格式、限定 Node 源码与差异检查 `36108c` 通过。合同检查 `71882d` 为 235 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:2baad22bbff67fab28a0b161bdf96079c897f8d9be5d0d5ac0a4bcc5393e701d`。无新增注册 schema、远程操作或业务变更。

## H1 清理证据与关闭边界（当前增量）

预检 `6294f9` 为干净的 `a5e9b126`；本地迁移查询 `659d96` 因缺少 datasource.url 在连接前退出，Prisma `0f24b7` 校验通过。仅修改发布基础设施。

固定导入器预留 cleanup 目录，只接受同一 job 签名、绑定原创建包的清理证据，先保存备份再保存归档；独立读取两个副本并重新验证原创建报告。既有 v3 台账增加严格 cleanup-observation 分支，绑定 source 终态、唯一负责人 ACK、清理原件和 H1 转发关闭观测；四个对象分别取得双份 custody，历史拒绝孤立或缺失副本。转发观测检查固定密钥文件为空、两个端口无监听、专用 UID 无进程；命令超时或未确认退出保留 INCOMPLETE。

正常 close 重新核验后仅释放两个原共享端口锁，保留 41 个原目标锁及初始 UNKNOWN 消费记录。审查发现外层复核失败仍可能走正常关闭，已补只能降低权限的 closeIncomplete：消费后保留两槽，不能沿用此前的清理成功记录释放锁。历史 CI 结束时间同时覆盖执行和 hosted 清理，使用独立 latestCleanupAt 字段，不将清理冒充执行。

验证记录：

- 新导入 API 的有效 RED `9bf31f`，GREEN `9410cc`；Linux 定向 `188e2e` 为 4/4、零跳过（总计 63,985.352546 ms），覆盖固定目录准备、真实签名导入、复制隔离、重复导入拒绝、备份篡改拒绝及 CI 结束时间边界。日志 SHA-256：`0e7c22660aef7d23f96ad6cc49ff8954863fd6da475943f51edb41435374d560`。
- core 新分支 5/5；保守关闭 RED `f621ee`、GREEN `bc61a0` 为 2/2、零跳过。原件/锁是实际测试文件，外部环境为合成边界。
- 转发观察 6/6；身份字段的数值 mode/负 inode 精准回归先失败，受影响单例 `efbdde` 通过。共享 cleanup 夹具抽取后签名校验文件 `e43fa3` 为 13/13；未新增测试矩阵。
- 外层复核失败的 Linux 定向 `ed4367` 为 1/1、零跳过，确认只调用保守关闭；此例用 core 替身专门控制复核失败点，不宣称完整 core 清理已通过。日志 SHA-256：`68db13ce86a1c91ceabc431b34c8d92cb36694e1729f633df6eb168d2021d37e`。
- 格式 `a22c07`、修正命令全局变量传参后的限定源码检查 `4d6160` 通过；后者保留既有两个未使用导入的例外，不代表全仓 lint。合同 `d82dd1` 通过：235 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:e9cefbce844099bcc569322e09c03cc242045fd484398a0d70e7c9840656da01`。

新增 source→ACK→实际签名 cleanup→共享槽释放整合 `65833` 已自然退出 1（`15114c`），测试体 997,899.556703 ms、进程 1,099,790.625342 ms。失败发生在 source 原件检查，尚未到 cleanup：新加的所有 v3 custody 均须有 JSON 对象的检查，错误拒绝原有 raw/<digest>.bin 证据。失败日志保存在 `.superpowers/h1-cleanup-integrated-red.log`，此整合不算通过。该冻结副本早于 closeIncomplete 修正；修正由独立失败定向覆盖。没有修改 H1、OSS、Staging 数据库或容器。

针对整合失败，已仅移除过宽的 JSON 主体要求，保留原 source 原始证据链检查。短回归 RED `c18b83` 精确复现原失败；GREEN `a60b26` 为 2/2、零跳过，同时确认三种新增清理原件的孤立记录仍被拒绝。没有扩大 pending 放行范围。

另外修正正常关闭的回调传参：直接传入结束函数会把上一个操作的返回记录误当作“保留锁”选项。RED `18b8dc` 后改为显式无参数调用；正确文件脚本采集的 `b97ae7` 为 1/1、零跳过、实际退出 0，验证正常与复核失败两种分支（总计 39,977.322448 ms）。此前两次内联脚本的参数捕获异常已保留，不能声称其包装进程退出正常。

修正后合同 `813907` 通过：235 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:47cddabeda20452d17bfad751730e8975547627141cbd3a025dbab29ecc9a734`；限定源码检查 `832e31` 通过。唯一重跑为受上述失败影响的清理整合 `52645`，未重跑其他长链。

清理整合最终结果 `926e0c`：自然退出 0，1 pass / 0 fail / 0 skip，测试体 948724.602681 ms、进程 972933.063548 ms。日志 SHA-256 为 `1e6ec8138341d9de2fc548933874dbee9d64f62f7e46ef55d56c38a5d909c699`；正常关闭回调回归日志为 `4cbf4511b9fcad538454b3411ad4e5ef9eacbea075f54008a2ac2ea7d87b980d`。整合使用真实私有文件、签名、核心会话和本地转发关闭观察，验证清理的八份保管记录、双副本、CLOSED 以及共享锁从 43 减为 41，原 UNKNOWN 保留。外部主机、GitHub、Engine、PG 和 source 原件生产边界为合成输入；未证明完整 native source 生产器/holder 正向完成，也不等于真实 H1 或阶段 1 验收。

## 最终快照消费匹配（代码已接通，完整正向验证待完成）

预检 `9b1f26` 为干净的 `77364d42`，本地 migrate status 因 datasource.url 缺失在连接前退出；`cc41aa` Prisma 校验通过。未修改业务逻辑、线上服务或数据库。

复用已有 v3 request / v2 allocation 的 matchingSourceEvidenceDigest，明确指向 source 成功执行记录；创建阶段仍只负责准备资源，前序保持 null。核心完整回放所有旧上下文后，统一检查唯一 source 终态、ACK、已验证清理及 CLOSED，关闭时间须早于 final 消费分配；核对同候选、源码、清单、CI attempt 和独立实际目标。新零参数重查入口在下载、解密、复制、恢复、临时文件清理、消费完成及对外 recheck 的明确边界复核，不为每次底层 Engine 读取重复全图验证。重查失败保留已消费锁和 UNKNOWN。

双方各自验证用途授权。授权索引绑定各自实际 destination/job，不能要求 source 提前知道 final 目标；因此比较同一 metadata、bundle、加密 envelope、密文以及精确 OSS 对象版本，允许两阶段使用不同权限索引。这不扩大 source 授权，也不改变既有 schema。source 持久化快照结果字段和摘要保持兼容，final 结果明确绑定 final phase。

验证：core 新入口 RED `08f431` → GREEN `f92f81`（3/3、0 skip），追加消费后守卫 `daee33`（1/1、0 skip）；native 包装入口 RED `20f3e9` → GREEN `11f522`（1/1、0 skip，自然退出 0）；纯结果文件 `f92af3` 为 4/4。native 用例对 core 使用 mock，core 短用例未达到完整 source→final 匹配正向条件，不能据此宣布链路验收通过。未新增大型模拟框架或重复旧的 50 分钟恢复矩阵。

合同检查 `0952e1` 通过，仍为 235 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:c165139aa15fafc4620b3045c77555b91a4cb3055fdeed4abde896f2c9830b19`；限定源码检查 `40f2cf`、格式和差异检查 `fdc68e` 通过。后续仍需 final/fresh 匹配、最终候选执行/清理、受控工作流接线及一次实际候选完整验证，再推进 Staging 两项迁移和 R4。

有限独立静态审查未发现阻断问题，核对了 selector 捕获、分阶段前后重查、失败保锁、完整历史后统一匹配和 source 历史字段兼容；该审查不补足未执行的正向链。

## 最终候选执行契约（本地验证通过，尚未启用执行）

预检 `b52f8c` 为干净的 `437089ec`；本地迁移查询仍因缺 datasource.url 在连接前退出，Prisma 校验 `1db929` 通过。现有 v5 请求、v5 签名授权及 v2 分配增加互斥 final 分支：必须使用 final 执行能力并绑定 matchingSourceEvidenceDigest；source 字段和签名语义不变，继续禁止该字段。final 准备前驱仍须是本会话成功创建（fresh）或消费（snapshot），不能用 source 记录替代。完整 source 原件匹配由后续 core 接线负责，本切片不启用 final 执行。

短用例 RED `64b06e` → GREEN `b15589`；受影响契约测试文件 `c00780` 为 95/95，12,681.0248 ms。格式 `351885`、限定源码 lint 与差异检查 `131d4f` 通过。合同检查 `bc3b53` 通过：235 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:ab92770132121db844c1cf81d2a543589254c7cc856e89c3bd95debc38715403`。未重跑长链、操作云端或变更业务代码；阶段 1 仍未完成。

## 最终候选历史匹配与测试目标分配（本地增量）

契约已提交为 `4981b1e6`。预检 `9e67e0` 工作区干净，本地迁移查询仍因 datasource.url 缺失在连接前退出；Prisma `d0ca1e` 通过。完整历史校验现在为 fresh 和 snapshot 构建 source 事实，final 候选签发、消费及重查共用同候选、同链、同 CI attempt、已签收清理关闭且物理目标独立的匹配规则。snapshot 候选还须保留自身已成功 consumer 的 source 摘要。final 仍保留初始 UNKNOWN，明确拒绝使用 source 成功终态或完成方法。

内部 final 清单绑定复用既有 source 逻辑，保持全部测试套件的原命令、文件、独立数据库和生命周期预留目标。额外应用数据库仍通过完整计划校验，但不作为测试套件目标。此处是分配逻辑，尚未修复旧 final Runner 入口的单库执行路径。

匹配规则 RED `978fb4`（2 fail）→ GREEN `83151d`（4/4、0 skip、36.4 秒）；增强规则及真实 core 的 final 创建消费后拒绝 source 方法、保持 UNKNOWN 检查 `306816`（3/3、0 skip、20.7 秒）。纯比较用例不验证历史原件认证；真实 core 用例也没有完成 final 候选链。final 清单用例缺导出 RED 后，相关四个纯计划/绑定用例 4/4，通过格式检查；子 agent 未保存这些工具编号，未补造编号。

合同检查 `99db67` 为 236 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:7d0fb18dce5808b48cb66a0365836130d7cb62eaad54f796a089b57ec3506f50`。限定 lint 初次遗漏 Node 的 structuredClone 全局声明，补齐检查配置后 `a4e1c9` 通过；格式和差异检查 `4bc37f` 通过。有限独立静态审查未发现此次绑定的阻断问题。未搭建新的大型模拟链、重跑旧长测试或操作云端。

剩余重点为 final Runner 分套件入口与生命周期接线、真实 final 终态及清理、受控工作流和同候选完整 R2/R3 验证；合法快照来源仍待确认。随后才能对齐 Staging 两项迁移、恢复 API/Web 并完成 R4。以上本地增量不代表阶段 1 收口。

## 最终 Runner v2 输入（校验完成，执行仍未开放）

前一增量已提交为 `41359050`。本轮预检 `4c3c12` 工作区干净，迁移状态仍在连接前因本地 datasource.url 缺失退出，Prisma `6dfebc` 通过。新增严格 v2 envelope，保留 v1；内外入口按明确版本分派。内部校验器重建完整 final 目标计划与套件选择，核对清单全集、target/source 拓扑、角色、marker、物理锁、独立凭据摘要及固定运行时引用，并从镜像内固定位置核对 discovery 摘要。生命周期只接受两条预留信息，不接收未创建的 OID 或成功声明。H1 原件认证和实际镜像/容器观测仍由后续执行接线负责，这个纯一致性校验器不赋予权限。

v2 校验通过后明确返回最终执行器尚不可用的错误，在读取凭据或接触数据库前停止；直接调用旧执行器的 v2 请求也被拒绝。尚未实现最终镜像迁移、生命周期通道及终态，不能将这一步计为 final 测试通过。

schema RED `a83787` → GREEN `8d448a`（2/2）；语义及两层入口 RED `5d6b32`（各 2 fail）→ GREEN `4091ec`（各 2/2）。相关三个入口测试文件 `8cb62e` 为 14/14，3,590.506 ms，含旧 v1 回归。独立审查发现共享 registry 关闭 format 校验，v2 UUID 仅写 format 会放行错误 ID；回归 RED `e4ef64` 后，仅 v2 增加 UUID pattern，GREEN `f611a9` 及最终语义文件 `eefba3`（3/3）通过。v1 和 registry 行为不变。

合同清单检查先发现新增文件排序及显式入口表漏项（`168037` / `7ab0e1`），已修正；最终 `8ff6e0` 通过：238 文件、86 schemas、128 migrations、13 commands，摘要 `sha256:878d88d2622ce463070f7a597e7a4aef5038d81b8318502cc3d6c6117d3df7c3`。测试发现 `2bc1d3` 为 99 candidates、39 manifested、60 excepted、0 unclassified；限定源码 lint `f476c5`、最终格式及差异检查 `0c4f00` 通过。未运行数据库长链或操作线上环境。下一实施点仍是最终镜像执行与生命周期接线，阶段 1 未完成。
