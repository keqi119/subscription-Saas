# Stage 1 加密存储准备与 R2 父命令断点（2026-09-27）

本记录保留当天各次真实断点，以本节最新状态为准。R2 正常 dry-run → apply → verify → replay、UNKNOWN → reconcile 和三类来源读取复用已通过相应定向验证并提交；replay 中断、独立结果核验、真实数据库及最终候选验收仍未完成。没有执行业务迁移、部署、真实候选 CI 或关闭阶段 1。

## 后续实测：R2.3 在结果核验前失败，先处理局部门禁

下文 16:11 UTC 的运行已自然结束。session 48597 实际 host / Node exit 1，0 pass / 1 fail / 0 skip，501,722.875813 ms。首错栈明确定位 `verifyManualHandoff → checkConsumedObservation → launcher` 的 READY 后、首次 dry-run 凭据交付前；错误为 `MANUAL_TIME_INVALID`，尚未进入新增结果核验器，apply 未执行。542 份原件经完整路径、长度、稳定身份及 SHA-256 核对保留，清单摘要 `338ec627332d18b4b0c3d2667f73ee3672f29c662922eccceb764188e1eea624`，秘密标记匹配为 0。未重跑 normal / interrupted 全链。

随后只对旧 replay 原件的独立 ext4 副本做局部读取计时：205 个归档对象单次 graph 为 4,943.159 ms，完整既有 H3-A/B 原件集合重查为 998.623 ms；两者分别实际调用 readPinned 1,025 / 255 次，即每对象五次。相同数据的 bounded-mock 对照为 5,371.000 / 1,603.789 ms；107 次合同校验为 2,203.847 ms，只有一次 registry 建造、76 个 Schema 编译及 106 次缓存命中。结果摘要 `0bf488a27dc6be82cfc24d1fdf34bd935c2130a870d547967ceac5175f77fb26`。这只证明两处单件读取有重复完整检查；不重现原门禁调用频率，也不能据此把超时归因于测试替身或延长有效期。

诊断首轮因缺 `postgres` 依赖在 import 阶段自然 exit 1，未计时；保留失败后补齐已有依赖链接，九个测量阶段全部返回，未调用子进程、数据库或凭据。续跑 shell 的退出码回报变量为空，host exit 1，因此不把此诊断表述为捕获到 Node exit 0。依赖链接可间接引用工作区模块，也不宣称全依赖来自不可变副本。完整结果与日志均已独立复制并核对摘要。

对照来源提取前代码还确认父命令漏掉自己持有的新 admission 文件复查。共享读取器仍检查它自己的文件副本；缺口限于两次首次 pin 之间的同字节 inode 替换，不能描述为完全未验证 admission。现仅恢复原 `opened` 重查循环一行，并在既有测试文件中增加一个定向回归。有效 RED（session 45420）自然 exit 1，实际 swaps=1、fallback=1，证明替换被接受并抵达后续命令准备边界；首次测试 session 9703 因较早的 baseline 重读失败而未触达替换点，内层原因未保留，不计作缺陷复现，原失败日志仍保留。

修复后的唯一 GREEN（session 51478）自然 host / Node exit 0，1 pass / 0 fail / 0 skip，220,675.591183 ms。真实同字节 inode 替换发生一次，共享读取器确实取得新 inode；父命令原 pin 将其拒绝为 `MANUAL_EXPECTED_SCHEMA_ADMISSION_UNKNOWN`，内层 `MANUAL_OPERATION_INPUT_UNAVAILABLE`、cleanupCause `MANUAL_STORAGE_UNVERIFIED`，fallback=0。测试确认两份原字节保留、无 runner-command request、无新增命令凭据读取及 DB 连接，原 index / baseline 不变。241 文件复制和源前后核对闭合；清单 SHA-256 `b5543cd91ec680089043d50a13fb5f9c1af35a059be4b1639b1d61df8aa57c5d`，生产 launcher SHA-256 `9669e276907db1c3d1ba26a507620add198e6c03cb037157acb9aa3e28f5a3d6`。有限差量审查、语法、格式及 diff 检查通过。该修复不解决 handoff 超时；重复读取的最小内部拆分仍只是方案，尚未实施。真实 PG、最终候选构建、R3 双链、两条 Staging 迁移及 R4 验收仍未完成；OSS 续期已解除，商用 KMS 排除。

## 16:11 UTC 历史接续：续期阻塞已解除，R2.3 正例当时仍在验证

此前用户完成的官方 CLI 续期已经用于 OSS 密文上传与完整 1 GiB 独立下载，两进程实际 exit 0 且摘要一致；没有待处理登录问题。本轮没有新云操作，商用 KMS 仍明确排除。异地密文完整回读不等于异机解密恢复，也不等于真实 CI 独立身份验收。

提交 `0225e629` 完成第二处旧 expected-admission 测试修正。native session 69765 自然 host / Node exit 0，1 pass / 0 fail / 0 skip，总计 467,974.306503 ms；保留原二进制失败输出及同一 baseline，后续调用在来源准入完成后的精确 raw 写入边界停止。生产源码没有为此改变，未重跑之前已通过的正例组。

replay-loss session 90628 则自然 exit 1，0 pass / 1 fail / 0 skip；实际父错误 `MANUAL_TIME_INVALID`。原 AUTHORIZE 和 READY 均存在，但没有 CREDENTIAL_RECEIVED 或 replay 工具事件，预定 SIGKILL 未触发，后续再调用断言也未运行。handoff 在 15:40:28.123Z 到期，父 DISPATCH_CLOSED 为 15:40:50.874Z；未保留确切首错 stack / gate readAt，不能把含清理的时间差当作门禁耗时。1072 份原件已保全，root 独立核对完整路径集合、长度、稳定文件身份及 SHA-256 全部一致，清单摘要 `59672ddc1b83361469f934b631e7b576e39a329e4aeab715cd7ce72abd84cab2`。只读调查定位两处重复单件复核，但没有计时依据，未删检查、延长期限或盲目重跑此用例。

R2.3 工作区已新增固定 selector 的只读结果核验器、两个真实 PostgreSQL 测试入口及其既有合同登记，尚未提交或验收。有限源码审查发现并修复正常 execution checkpoint 名误拒、消费前孤立撤销对象漏查，以及当前 gh 原输出未保管三项；当前验真输出写入完整执行日志并等待写入完成，报告摘要绑定原字节与 capture，Node 错误码与真实进程退出码分开。仅两项 selector / H1 无副作用边界通过，不能据此认定完整核验器正确。

唯一新增 normal 组合正在不可变 Linux 副本 `/home/keqi_119/.cache/r23-result-WYUBu0` 运行，root session 48597；241 路径完整复制摘要和源前后状态闭合，Node 22.22.2，绑定 `result-verifier-frozen02.json`。它复用既有 fixture，只验证 migration NOT_RUN、最终 normal PASS、当前 gh 与只读边界及孤立撤销拒绝，不重跑旧 launcher 故障矩阵；当前尚无终态。apply-interrupted 新组合尚未运行，两真实 PG 入口也未运行。

本轮合同校验实际 exit 0（195 文件、76 Schema、128 迁移、13 命令）。测试发现检查使用独立临时 Git index 纳入新文件，实际 index 保持不变；结果 98 candidates / 39 manifested / 59 excepted / 0 unclassified。两个真实入口的例外明确限定为独立人工最终门禁，不豁免 R2.4；默认 Runner 单测的 `test/*.test.mjs` 不选择 `test/manual/`。本轮开发预检仍是 migrate status 因缺 `datasource.url` exit 1、Prisma validate exit 0，未连接数据库或变更业务逻辑。

当前顺序保持：完成 R2 结果核验及必要异常验证 → 受保护最终候选构建 / H2 → R2 真实 PG 两场景与 R3 合法快照消费、fresh / snapshot 双链 → 发布链对齐 Staging 两条待迁移并恢复服务 → R4 业务实测和签收。阶段 1 未收口。

## 15:28 UTC 接续：期望结构来源读取复用已提交

提交 `49356e8e` 完成第三片私有来源读取复用。既有 expected-schema provenance、reference、OSS 原件及 GitHub 输出检查迁入 `manual-runner-source-inputs.mjs`；launcher 保留实际 GitHub 调用、会话检查、归档和 sidecar 写入。新读取器独立重开固定 admission、实际调用捕获及原始输出，保留自己的字节副本，关闭时清除副本；没有新增公开 CLI、Schema、数据库动作或业务功能。原 H3 主体、expected 来源检查和 GitHub argv / 结果谓词经逐字比对保留。

首个 Linux 定向组实际 7 pass / 1 fail / 0 skip；失败暴露正常归档追加被目录内容 pin 误判。修正仅允许三个固定追加目录的内容属性变化，仍核身份、nlink、完整叶子字节、ACL 和独立重开；admission sidecar 的强 pin 保留。源码及该修正经有限复核 ACCEPT。

必要正例重验另发现旧测试预期已移除的 `MANUAL_RUNNER_REQUEST_INPUT_REQUIRED`，CHALLENGE-only 替身无法回应 READY。保全 527 份非秘密原件后，root 精确停止该替身 child；实际 exit 1 / `MANUAL_FRAME_INCOMPLETE`，明确保留为人为结束的失败，不算自然通过。测试随后在来源验收完成后的第一项 migration raw 写入处设置精确失败切点，保持无新增命令凭证 / DB 连接和无 runner request 的断言，生产源码不变。

修正后的唯一正向用例自然结束：host / Node exit 0，1 pass / 0 fail / 0 skip，总计 501,758.035576 ms。除实际 producer / GitHub 捕获闭合外，还核验返回副本污染、三个固定目录各追加 sibling 后重验通过、原 GitHub stdout 改写后拒绝。冻结副本 237 路径完整哈希闭合；不把前组 7 项通过与本次结果拼成同一冻结版本的 8/8。契约校验 exit 0（192 文件、76 Schema、128 迁移、13 命令），三文件格式和 staged diff 检查通过。

另一处 binary-GitHub 用例存在相同旧断言，修正仅留工作区并单独验证；replay-loss 也仍为独立工作区增量，未混入本提交。原正常链和 UNKNOWN 恢复链未重复运行。定向日志、冻结哈希、原始失败和源码保持比对位于 `runner-second-stage/expected-reader-*`；本轮仍没有真实 PostgreSQL、云操作或发布通过结论。

## 最新状态：正常链与 UNKNOWN 恢复通过，真实发布仍开放

提交 `aee01e39` 包含已实际验证的 R2 正常链及 H3 原件门禁。第八次正常用例自然结束，host / Node exit 0，1 pass / 0 fail / 0 skip；同一 ref 的四个阶段均完成，实际 launches=4、credentialReads=15、observerConnections=1。七个拒绝场景均保留 launches=2、credentialReads=9、observerConnections=1，没有新增启动或凭证读取。1194 份原件的完整集合、长度和 SHA-256 已由 root 独立核对，有限源码复核 ACCEPT。该测试使用真实 Node 子进程、协议帧和保管路径，但 PostgreSQL / CLI 边界为受控替身，不能计为线上迁移或真实 H3 验收。

提交时逐字节核对并只入库已测的冻结源码、冻结测试；当时未运行的 UNKNOWN/reconcile 与 replay-loss 测试单独保留为工作区改动。后续 UNKNOWN/reconcile 定向 RED 自然 exit 1，实际 dry/apply 均成功、计数 2/9/1，准确暴露“固定中断场景仍返回 apply 成功”，不是前置配置失败；857 份原件保留。父端固定中断、保留 UNKNOWN 与工具 committed 两种事实、仅进入 readonly reconcile 的最小修复后续已通过，见下文提交 `c9664429`。replay-loss 尚无实际通过结果；不重复已通过的正常链或旧容量矩阵。R2.2 整体门禁、独立结果 verifier、期望结构来源读取复用和真实 PostgreSQL 两阶段入口仍开放。

提交 `620857ff` 修正了 PostgreSQL 17 快照导出对 DEFERRABLE 的错误前提，保留 REPEATABLE READ、只读事务、snapshot ID 和来源指纹检查；脱敏策略仅明确支持已核实的 Staging 与候选两个迁移 head。现有 snapshot-export 测试 20/20 通过。真实 SSH 只读检查确认 Staging 已完成 126 条迁移、无活动失败项，候选有 128 条；两个待应用迁移仍为 `20260925090000_stage1_operational_completion_terminal_shape` 与 `20260925091000_stage1_operational_completion_settlement_guard`。本轮没有执行导出或 DDL/DML。本地 migrate status 仍因缺少 `datasource.url` 返回 1，不能将只读远端检查写成本地命令通过。

提交 `775a489b` 仅增加 R3 三阶段消费请求及签名绑定的闭合校验，原 contracts 测试 76/76 通过、有限复核 ACCEPT；仓库合同校验实际 exit 0，189 个文件、74 份 Schema。prebuild 不依赖未来构建或当前 attempt 的 producer；v1 不变，v2 纯校验不授予执行权限，现有生产 session 继续拒绝消费请求。真实 scope / destination / allocation 原件读取、session 接线、H1 密钥释放和认证后远端恢复仍未实现。

提交 `48ac0b8e` 后续补齐 H1 既有密钥创建/恢复公件的固定读取：shared 22/22、Linux native 10/10 通过，有限复核 ACCEPT。源码子集在指定主机部署后，682 文件经另一次独立 SSH 全量读回匹配；生产读取器实际核验原公件成功，未读私钥或放行消费，事后独立确认卷关闭及 swap 恢复。最新仓库合同校验为 191 文件、76 份 Schema，exit 0。详情见[非商用公件读取实测](2026-09-27-stage1-noncommercial-snapshot-key-custody.md#1317-utc-后续生产公件读取器实际读回)；该进展不关闭 scope、目的地或 R3 双链门禁。

官方 CLI 续期已成功用于新 RSA 恢复卷密文的 OSS 上传和完整 1 GiB 回读，当前没有等待续期的阻塞，详见[非商用密钥保管实测](2026-09-27-stage1-noncommercial-snapshot-key-custody.md)。仅证明同主机独立加密卷恢复及异地密文完整回读；异机解密恢复、真实 CI 独立 writer / audit-reader 身份验证仍未完成。商用 KMS 不在实施范围内。

13:49 UTC 接续补齐 H1 专用原生转发配置，使用两个固定回环端口、非 root 转发账号及仅 root 可连接的精确防火墙规则；一次临时维护 key 的 Docker 只读实测通过，额外端口、会话和非 root 访问被拒绝。独立 SSH 确认临时 key/连接/目录清除、授权文件为空，原 root 访问正常。首次候选配置因 OpenSSH 8.0p1 不支持一项 Match 指令失败，正式配置尚未写入；保留原件后完成有限接续。详见[通道配置与实际边界](2026-09-27-stage1-r3-remote-engine-feasibility.md#1349-utc-接续h1-原生通道配置与有限实测)。此项不等于 hosted 加密目标或真实消费完成，防火墙重启后须重新核验。

R2 第一次修复验证实际 0 pass / 1 fail：原 apply 已唯一记录 UNKNOWN，两个 child 自然 exit 0；失败来自新增测试未同步 Node builtin named exports，导致落盘后的故障注入未被调用。只补一行测试同步，生产源码保持不变；同组第二次重验已自然结束并通过，两个历史失败均保留。本轮 Prisma validate exit 0，migrate status 仍因 `datasource.url` 缺失 exit 1，未连接数据库或修改业务代码。

提交 `72c91da1` 完成 R2.3 第一片 H3-A 来源复用：新增私有 `manual-runner-source-inputs.mjs`，21 个既有 SQL、权限、路径和原件检查函数逐字迁移，launcher 保留 owner、实时资源观察、R1 原件刷新、会话及全部执行责任。新增直接读取用例先真实失败，再与三个现有拒绝/准入用例组成有限验证；Windows 和 Linux Node 22.22.2 各 4 pass / 0 fail / 0 skip，Linux 237 个复制文件的完整摘要和前后状态闭合。输入在首个 await 前固定，返回字节副本与内部重查分离，关闭或原件被替换后拒绝继续使用，读取过程不取得执行权。有限源码复核 ACCEPT，语法/格式/diff 检查通过；最终仓库合同校验 exit 0、192 文件、76 Schema、128 迁移。仅这五个文件的 H3-A 增量入库，当时仍运行的 UNKNOWN/reconcile 改动与未运行 replay-loss 保留为未提交工作；后续进展见下文，不能把此项计为 R2.2 或真实 PostgreSQL 通过。

提交 `c9664429` 完成已测 UNKNOWN/reconcile 切片。原 session 70449 自然 host / Node exit 0，1 pass / 0 fail / 0 skip，实际 launches / credentialReads / observerConnections 为 3 / 12 / 1；落盘后故障注入实际发生一次。原 apply `f83dc431…ce7bf` 保持 `INTERRUPTED_UNKNOWN`，包含完整 result 和 closed process 引用；后续仅同一身份的 readonly reconcile `59eb60c2…d8464` 成功，未升级原执行记录。1028 份原件的完整集合、长度、稳定文件身份和 SHA-256 经 root 独立核验，清单 SHA-256 为 `88cddb9b317a9853b6ac78f74d63340420038c8cd1902472940b3d1680a1f6a3`；秘密扫描为 0。实测绑定冻结源码 `47debc05…dc772` / 测试 `9a94e548…87181`；有限复核确认三处生产改动和该用例逐字保留，提交时只组合已接受的 H3-A 提取并排除未运行 replay-loss。该 GREEN 仍使用受控 PostgreSQL / CLI 边界，不代表真实 PG 或整个 R2.2 通过。

提交 `ba36f738` 完成 H3-B 来源复用：同一私有模块复用固定两件 B 原件、原权限清单、grant/revoke/退出来源和已归档 final-inspect；父命令保留实际 credential 文件状态/ACL、上游重查、归档写入和执行。无参 `recheckArchived` 独立重开完整两件原件，返回副本不影响内部重查。三个权限 helper 和原 H3-A 模块正文逐字核对通过。直接用例先因入口缺失真实 RED；Windows 首次通过后，清理未用导出时误删正文校验项，Linux 首次实际 1 pass / 1 fail；保留失败日志并恢复原文后，最终 Windows 1 pass、Linux A/B 两例 2 pass，均 0 fail / 0 skip / exit 0。Linux 237 文件复制摘要及前后状态闭合，最终模块 SHA-256 为 `fa17d17d95f2a0da817b55099772576ce2283dc5cbd7a21b31b18fac83c1a760`，有限源码复核 ACCEPT；格式、diff 和仓库合同校验通过（192 文件、76 Schema、128 迁移）。仅三文件已测提取增量入库，replay-loss 仍独立保留；未重跑整条正常链，expected-schema 读取及结果 verifier 尚待实现。

阶段 1 后续先完成 R2 异常恢复、结果核验入口和必要用例，并接通合法快照消费及固定远端执行；再对冻结候选执行受保护构建 / H2，完成依赖这些可信输入的 R2 真实数据库验收与 R3 fresh / snapshot 双链；按发布链对齐两条迁移并恢复 API / Web；最后执行 R4 A/B 主线、签约支付回调、激活、到期收口和维护恢复的真实验收与签收。后文较早断点中的“仍等待登录”“H3-B 未接通”等描述仅为历史事实，不能作为当前状态。

## 07:00 UTC 后续：同 ref 历史交接与 H3 原件合同

候选 `99ff3c0d` 已提交同 ref 原迁移历史重开和 H3-B 缺件停止增量。实际 RED 为 Node/host 1、0 pass / 1 fail；修正后唯一对应 GREEN 为 Node/host 0、1 pass / 0 fail、537,301.359 ms。用例先完成真实 Node 子进程的 dry/apply，再调用同一 ref；第二次调用前后 launches=2、credentialReads=9、父 observer DB 连接=1，原 baseline 和两个原请求均保留。PostgreSQL/Docker 仍为受控替身，不是实际数据库验收。独立复核两源码及复制清单一致，并逐件核对 1,710 份保留原件长度/hash 无差异，有限 ACCEPT；未重复旧容量或中断矩阵。

当前 H3-B 即使存在仍安全拒绝，尚未实现正向放行。下一片必须在任何新命令前拒绝额外已消费迁移历史，保留并重开 UNKNOWN 已有 result，再完成 H3-B 原生权限、原 writer 退出及 provision 撤权/退出来源核对。verify/replay/reconcile、独立结果 verifier 和真实 PG 两阶段仍开放，不能将上述单例计为完整 R2.2 通过。

合同补充已在 `cc098de3` 经有限复核后并入既有 R2 plan §2.1/§2.5.1：H3-A 私有 v2 显式记录批准角色名与创建后 OID；六种固定 SQL 原件与既有 RawRef 闭合，包含实际连接身份、完整权限清单、跨库 provision 会话及真实 grant/revoke 前后顺序。H1 获批 profile 不变，不新增公共接口、自动权限服务或测试文件。下一片只在既有 launcher/test 内实施。

保留原件位于当前候选 `runner-second-stage/` scratch 的 `history-missing-h3b-{red,green}.log`、`first-gate-{frozen,results,originals-hashes}.json` 和 `first-gate-review.md`。GitHub 只读复核确认远端 main 仍为 `f8ed9440`，受保护环境仅允许 main，审查人为 keqi119；没有 push、合并、触发 CI 或修改环境。当前不需要用户补充操作。

## 06:19 UTC 后续：首阶段父流程与中断保管

本轮 10 文件修正提交为 `c7cfed2b05c4c86b19f19357ca4733ce7ba54b66`，独立有限审查 ACCEPT。隔离整合候选从业务/H1 分支 `c2cd59d6` 建立，先以 `9521f6d3` 合入已提交发布基线，再整合此修正；逐文件核对 10 个冻结摘要相同。API/Web 与 H1 两份获批公件相对原分支无差异，repository contract 的 181 项恰为两分支并集。R2 plan 保留两侧新增约束及 READY 澄清，旧输入缺口明确标为历史。新目录通过离线 frozen-lockfile 安装（忽略安装脚本）；Prisma validate exit 0，migration status exit 1，具体为未提供 datasource.url。预检禁用 dotenv 且清空该子进程 DATABASE_URL，没有连接数据库，也未把此失败报作迁移通过。

受控真实 Node 管道的完整 dry-run → apply 用例实际 Node/host exit 0，1 pass / 0 fail。两个 child 均自然 exit 0；dry-run 执行 2 个工具，apply 执行 11 个工具。apply 完整 stdout 为 1,143,875 bytes，两次独立工具输出各 402,009 bytes，最大帧 537,765 bytes；归档、独立重开、共享 assessor 和 session 收尾通过。此处使用 PostgreSQL double 和受控工具输出，不是线上迁移、真实 reference DB 或最终镜像验收。

本增量限定 MS2 完整 stdout 及经协议/身份绑定的 prefix raw 为 2 MiB；单帧、单工具、普通 raw、stdin、stderr 和 MS1 的原限额保留。另修复实际结果时间采样倒序、多个归档写入与目录一致性检查互相干扰，以及工具终态缺失时错误声明整体关闭的问题。时间缺陷的 RETURNED/THREW 两个直接用例均有真实 RED → GREEN。

首个中断用例实际 exit 1：UNKNOWN 和真实进程退出已保存，但第二次调用新增一个零凭证 child，启动数 3 不等于预期 2。该失败和原件保留；当时第二次调用的完整计量未保管，不倒推其实际工具/凭证计数。随后在可信 session 打开后、原观察/attempt/child 启动前补仅用于拒绝的已消费迁移历史检查；共享 sign/consume 最终历史裁决保持。只重跑原中断用例，实际 Node/host exit 0、1 pass / 0 fail、274,178.663 ms：原 apply 被 SIGKILL 后保持 INTERRUPTED_UNKNOWN，result/finishedAt 为 null，真实 parent CLOSED 保留，缺失的工具终态未伪造；第二次调用前后 launches 均为 2、credentialReads 均为 9。

相关真实日志为发布工作树 runner-command scratch 中的 `capacity-parent-full-after-archive-fix.log`、`capacity-parent-apply-loss.log`、`capacity-parent-apply-loss-after-stop.log`。最新中断运行源冻结于 `stage1-stop-frozen-source-hashes.json`；正例在其后的 STOP-only 修正之前运行，没有为了该拒绝门重复正例。第二次调用的原件和实际前后计数另存 `apply-loss-reinvocation-*`，没有覆盖失败目录。

剩余工作为同 ref 的 H3-B 原件门禁和 verify/replay/reconcile 父端分发、独立结果 verifier 与真实 PG 两阶段入口、最终候选受保护 CI/H2、真实迁移对齐、R3 同候选双链及 R4 真实验收。当前入口仍拒绝已有已消费迁移历史再次进入首阶段，不能据此声称恢复或第二阶段已实现；本轮没有重跑旧业务测试。

## 04:26 UTC 后续：精确批准与实际主机 loader

用户明确批准 profile digest `sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541`；收到确认后记录时间为 `04:08:59.000Z`。批准原件摘要为 `sha256:2558d9ba079dd5456780a45e2b94ddac501419d9fbfa325d7f7db4f3169bece1`。服务器 CreateNew 写入加密 archive 并独立重开，然后生成 binding、保存 profile 副本，再写实时 `04:14:07.359Z` 的 GENESIS 至 journal/archive/backup 及固定 sequence 0 槽。GENESIS 摘要 `sha256:d822434b9c8696b68bb653418a513f43f0bbeb0f2a6ad6c1b22e8f07d65bbbcd`；没有使用先前本地 payload 中未落地的草拟 GENESIS。

实际初始化 exit 0；本机随后使用生产 encoder/Schema 验证返回 canonical 字节、digest 和批准/binding 逐项等式，exit 0。公开 profile、binding 与两项 manifest 引用已提交到原工作树 `d198b813a27a0d21c711ed841ed0c9e2adcafebc`，完整 repository contract 178 项读回一致，digest `sha256:c10ff7672bdbfa7d587e5063843365766c9a530fd7601bca35e32c5681f68391`。这次配置预检仍为 schema validate 0 / migration status 1（dotenv 禁用、无 datasource.url、未连接 DB）。

为运行真实 H1 loader，仅转移该提交的 H1 源码、所需 contracts 及现有六个纯 JS 依赖，672 个文件全部逐字节读回匹配；包 438,604 bytes，SHA256 `2a80da06f9fbaf43110826d1fcfbce1a00797182aecfb0735034b0babdfa2375`。不是完整发布 checkout、镜像构建或 CI。服务器 `/opt/stage1-h1-loader-d198b813` 中的原始 `loadFixedManualProfile` 于 `04:22:56.075Z` 实际 exit 0：批准、真实主机/principal、五根权限以及 profile/binding/GENESIS 的 10 项独立读回匹配；无私钥读取、无 DB 连接，会话凭据根为空。事后独立 SSH 确认两映射/挂载关闭、underlay 空、临时 core 设置已移除，两个原 swap 已恢复。

初始 1 GiB OSS 密文仍完整保留。另将本次新增公开状态及实际校验证据作为 `approved-public-state.tar.gz` 存到同一 `h1-recovery/v1/20260927-4a424369-01d6-4ba5-825a-d86fb30140ad/` 前缀的新对象，未覆盖密文。该补充包 4,750 bytes，SHA256 `77a44e6f98c64b629ca368d6d028fd9437cfafc0e888627f0f5d431fdde2ae5c`；上传及独立 Head/ACL/Get 均 exit 0，private/AES256，完整下载摘要一致。它不包含私钥、解锁材料或凭据；仍未验证异机解密恢复。

独立只读审查确认本轮 H1 身份/批准、加密五根、GENESIS、同主机独立卷恢复及生产 loader 均有实际依据，无新增阻断 Important。最终候选同源重验、异机恢复及整体 H1/H2/H3 发布验收仍开放，不将源码子集检查或 OSS 可下载等同于完整发布通过。原件为 cloud scratch 的 `h1-explicit-owner-approval-receipt.json`、`h1-initialize-state-result.json`、`h1-initialization-independent-validation.json`、`h1-public-configuration-validation.json`、`h1-loader-source-readback.json`、`h1-verify-loader-result.json`、`h1-public-state-backup-{manifest,upload,readback}.json` 与 `h1-actual-configuration-review.md`。

R2 上一个小批的固定最多 8 项 `allSettled` 复核已独立接受，无新增 Critical/Important；有效 RED 1、同一用例 GREEN 0。新单次计时保持全部检查计数，输入循环 9.695 → 8.653 秒，但总窗口 15.727 → 15.678 秒，未证明整体过期问题已解决。诊断仍为编码凭据前固定停止 exit 1，0 凭据/DB/工具，不是全链正例。当前唯一代码写入者进入已明确的 MS2 总流 2 MiB 四路径修正，仅做相关容量/边界验证；该改动尚未验收，未重跑旧业务套件。

## 03:40 UTC 后续：真实密钥与有限耗时修复

实际密钥操作 exit 0：`03:39:03.374Z` 在主卷生成 Ed25519，主文件为 `/var/lib/stage1-volumes/main/key/signing-ed25519.pk8.pem`，备份为独立 recovery 卷的 `backup/bootstrap/signing-ed25519.pk8.pem`。两份均 CreateNew、uid 0 / 0600、fsync 并独立重开验证；私钥未离开服务器或输出到日志。负责人为 `keqi119`，执行 principal 为 POSIX uid 0。

公钥 SPKI DER 指纹为 `sha256:7146f2e00f4a8e70183a64f3e8c7ebfa8e66926f60d18442e3d5ac4a09e408ef`。主卷关闭后，仅重开独立备份卷，在另一个 Node 进程读取备份，验证原挑战签名并签署不同的恢复挑战，`03:39:04.902Z` 完成。主控随后仅用公钥独立验证两份签名、同一指纹及不同挑战，exit 0。原件为 `h1-key-recovery-result.json` 和 `h1-key-public-signature-verification.json`；原初始化/密钥生成脚本不得重跑。

操作后两个卷均卸载、映射关闭、底层目录为空，swap 恢复，临时 coredump 设置移除。此为**同主机独立加密卷恢复**；两卷仍共享物理盘，尚未验证异机恢复，Windows DPAPI 当前用户依赖仍在。GENESIS、具体 profile/批准/owner binding/sidecar 和真实 loader 尚未完成，H1 继续开放。下文“空卷、尚无签名密钥”是此前断点，已由本节推进，不作为当前状态。

R2 只做了一次停止在首个真实 dry credential 发送边界前的计时诊断：实际 exit 1 / `MANUAL_DIAGNOSTIC_BOUNDARY`，0 credential 写入、0 DB 连接、0 工具，未进入 apply；不是成功正例。本次 receipt 签发至边界 15.727 秒，三次 admitted recheck 中 232 个 held inputs 和 4 个 checkout pins 的循环累计 9.695 秒，约占窗口六成。git、catalog 和 custody 实测均非主项；此前 47.136 秒超时原件仍保留，不能被这次未过期诊断抹去。

当前最小修复仅针对这些彼此独立 item recheck 的固定最多 8 项批次：每项内部检查顺序不变，所有已启动项 settled 后才能返回或拒绝；仍保留最新撤销/session/receipt 检查及 30 秒期限。实现和定向验证由唯一代码写入者进行，尚未声明通过。此次开发预检中 schema validate exit 0，migration status 因未提供 `datasource.url` exit 1，未连接数据库、未改业务逻辑。

容量前向裁决现已明确写入 [R1](../superpowers/plans/2026-09-06-stage1-r1-manual-trust-and-authorization-plan.md#2026-09-27-ms2-原始总输出的有限前向修正) 和 [R2](../superpowers/plans/2026-09-06-stage1-r2-runner-migrate-verify-plan.md#2026-09-27-ms2-真实规模运输修正)：只允许 MS2 完整 stdout／经绑定验证的 stdout-prefix raw 为 2 MiB，其余角色及 MS1 保持原 1 MiB。该生产容量改动与实际完整运输验证尚未开始。

## 云账号和实际存储

### 04:05 UTC 后续：OSS 独立密文副本已回读

在 recovery 卷关闭、mountpoint 为空的状态下，按已知 LUKS2 UUID `867c622b-e066-4a9a-88eb-766a4f27528c` 校验源身份，经 SSH 二进制流导出 1,073,741,824 bytes 到 Windows 当前用户私密目录。源文件前后身份/尺寸/时间戳不变，完整 SHA256 为 `f3e9d46ff6a761362aba65f0ef3d1f174e676de428182bdea5d85ee158007ea1`；本机独立读回相同。导出未解锁卷、读取私钥或搬运解锁材料。

复用既有 `stage1-keqi119` 官方 OAuth，以 `forbid-overwrite=true`、private、AES256 上传至指定桶 `subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai` 的新对象 `h1-recovery/v1/20260927-4a424369-01d6-4ba5-825a-d86fb30140ad/recovery.luks`，实际 exit 0。首次本地进程启动因未规范化的可执行文件路径失败，未发出 OSS 请求；该失败原件保留，随后以已解析绝对路径接续，没有覆盖或重试已有对象。

六项独立云端读回均 exit 0：对象长度准确、SSE AES256；对象和桶 ACL 均 private、owner `1457643390906675`；WORM 状态 Locked、210 日，桶默认 AES256，versioning 响应无 Status 元素。随后从 OSS 另行下载到新的私密文件，实际 exit 0，完整长度与 SHA256 均与服务器导出一致。没有修改桶策略、锁、H2 角色或现有对象。

这证明异地密文对象已保管且可完整取回，**尚不是异机解密/签名恢复**。已完成的密钥恢复仍是上述同主机独立加密卷验证，Windows DPAPI 当前用户恢复依赖仍在。两份本机密文副本保留在 `C:/Users/keqi_119/AppData/Local/Stage1CiphertextBackups/20260927-4a424369-01d6-4ba5-825a-d86fb30140ad`；不把该副本当已批准 profile/发布凭据。

上述运维原件在同一 cloud scratch 的 `h1-ciphertext-export-result.json`、`h1-ciphertext-upload-result.json`（首次启动失败）、`h1-ciphertext-upload-resume-result.json`、六个 `h1-ciphertext-{api}.json`、`h1-ciphertext-download-result.json`。本次 [H1 profile 具体草案](./2026-09-27-stage1-h1-profile-approval-proposal.md)已通过 Schema 和 canonical digest 校验；仍待精确 owner 确认，未生成批准原件/sidecar/GENESIS。

第二次官方 CLI OAuth 正常完成，但 `stage1-ecs-keqi119` 的实际 STS 仍为 OSS 账号 `1457643390906675`，不等于服务器所属账号 `1335332669126231`。用户明确无法登录后者／由其他账号代管，因此停止重发登录要求，使用已获授权的 SSH 配置主机级加密。云盘底层加密仍 UNKNOWN；本次不冒称已取得 ECS 管理权限。

`139.196.227.195` 已安装发行版 `cryptsetup 2.3.7`。两个新建容器各为 1,073,741,824 bytes，实际分配各 1,073,745,920 bytes；没有格式化已有磁盘、删除旧数据或改动系统分区。

| 用途   | 密文文件                                   | LUKS UUID                              | 卷内私密目录                                                    |
| ------ | ------------------------------------------ | -------------------------------------- | --------------------------------------------------------------- |
| 主卷   | `/var/lib/stage1-ciphertext/main.luks`     | `97c61d0d-fa2c-42bb-9ba7-66f8724bc29b` | `/var/lib/stage1-volumes/main/{key,journal,archive,credential}` |
| 备份卷 | `/var/lib/stage1-ciphertext/recovery.luks` | `867c622b-e066-4a9a-88eb-766a4f27528c` | `/var/lib/stage1-volumes/recovery/backup`                       |

实际 header 为 LUKS2 / AES-XTS 512-bit / Argon2id 128 MiB、单线程。各卷使用独立随机解锁材料；Windows 当前用户 DPAPI 保护文件位于 `C:/Users/keqi_119/AppData/Local/Stage1VaultKeys`，目录及两个实际文件均核对当前 SID 所有权与唯一访问规则。秘密只经已核 SSH 主机的标准输入传入，未置于 argv、环境、脚本、仓库或日志；受保护文件不得删除或被新生成的材料覆盖。

主机在秘密操作前停用实际两个 swap 文件，读回合并后的 coredump 配置 `Storage=none / ProcessSizeMax=0`，秘密 worker 使用 core limit 0；操作后 worker 退出、卷卸载、映射关闭，再恢复原 swap 和临时 core 设置。两个卷均实际重新解锁、以 `nosuid,nodev,noexec` 挂载并读回五根 uid 0 / 0700，最后关闭。独立事后读回确认：没有残留 mapper，底层 mountpoint 为空，临时 core drop-in 已移除，原 swap 已恢复，密文文件 uid 0 / 0600。最后观察根盘空闲 9,909,067,776 bytes；没有把相较前次探测的空闲变化归因于本次清理。

首次操作退出 1：主卷已成功格式化，但该版本不支持 `luksDump --dump-json-metadata`。保留主卷、解锁材料及原始失败；读回精确 UUID 后使用新接续脚本，只为无文件系统的已知主卷建立 ext4，并新建备份卷，未重做主卷加密或更换密钥。接续退出 0；实际重开、挂载、关闭和事后读回均有原件。

**H1 尚未完成。** 当前五根为空，尚无 Ed25519 签名密钥、GENESIS、签名密钥备份恢复、profile/批准/sidecar。此次只验证卷能重新解锁，不是同公钥恢复演练。两卷仍在同一物理盘，不能据此声称主机丢失可恢复；后续按已批准范围安排私有密文副本及恢复读回，并明确 Windows DPAPI 恢复依赖。卷默认关闭，不自动解锁；任何后续秘密操作须重新实施同一内存/转储保护。现有容量不代表 R3 数据快照容量已满足。

运维原件位于发布工作树 `.superpowers/sdd/2026-09-25-stage1-trusted-build-input-preparation-plan/cloud-setup-20260927/`：`ecs-oauth-completed-account-mismatch.json`、`host-luks-prerequisite-probe.json`、`h1-empty-volumes-setup-result.json`、`h1-volume-failure-readback.json`、`h1-empty-volumes-resume-result.json`、`h1-empty-volumes-final-readback.json`。原 setup 和 resume 脚本分别保留，不再次运行初始化脚本。

## R2 真实失败及下一步

发布工作树基线为 `9e6829c01463384da0ca9ddc9e52a5ca1f126fcc`。三个父命令实现/测试文件为冻结未提交 WIP；独立只读审查没有发现有充分依据的新增 Critical/Important，但 verdict 为 **No / 不可视为可发布**，因为真实正例仍失败且容量合同未解决。

最新唯一正例 actual Node/host exit 1，1 test / 0 pass / 1 fail，`MANUAL_TIME_INVALID`。dry-run handoff 原件从 `03:14:28.543Z` 到 `03:14:58.543Z` 有效，实际拒绝事件为 `03:15:15.679Z`：凭据前已过期，0 DB 连接、0 工具，未进入 apply。移除两次冗余全图校验后仍失败；保留 AUTHORIZE 及 CREDENTIAL 两个真实发送边界的最新 session/消费/撤销检查。停止盲目重跑完整链，先定位 guard/档案读回的耗时；不延长 30 秒或回填时钟。此前曾执行 dry 2 / apply 11 个工具但共享验收失败的原件也保留，不能拼接成一次成功。

实际本地 Prisma 7.8 `from-empty → to-schema` 离线 SQL 为 402,009 bytes，SHA256 `7a066863c903c3e48d5d2d23903ba3e269db2067e79db9c671d5daa996ce01da`。两份完整 base64 为 1,072,024 bytes，仅 SQL 即比旧完整 stdout 1 MiB 上限多 23,448 bytes。此前 462,831 bytes 是 schema 源文件，不能用于该推算。离线文件不是独立 reference DB 或 admitted expected 原件；实际 datasource introspection 字节尚未取得。

独立容量审查建议仅对 MS2 完整 stdout／经绑定验证的 prefix raw 明确有限 2 MiB 例外，JSON、单帧、单工具 raw、stdin、stderr、普通 raw 及 MS1 保持原限制。尚未修改规范或生产限额，须先形成精确前向变更，再用真实规模离线负载验证完整运输/独立重开；不省略第二轮工具或原件，不泛化放大所有输入。

三文件语法、格式、diff 检查通过；默认 mjs lint globals 配置及已有一处无用赋值诊断保留，未冒称全仓 lint 通过。新增负向矩阵、完整 R2、H3-B、R3 双链与 R4 真实验收均未完成，未重复旧业务测试。详细日志、冻结 SHA256、审查与尺寸原件在 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/runner-command/`。
