# 阶段 1 收口状态（2026-09-28）

阶段 1 尚未完成。当前主要差距集中在发布执行与真实验收；本轮没有增加业务功能，没有引入商用 KMS，也没有改动线上数据库。

## 当前接续状态

R3 同会话认证解密入口已实现：固定读取既有 RSA 密钥前核对当前 LUKS 主卷、swap/core 防护、发布身份与公钥原件；复用既有 AES-GCM 解密，并对发布后实际持有的明文文件再次计算摘要。无参数入口仅允许已消费、已下载的 source/snapshot 会话调用一次，保留 UNKNOWN 和锁，不生成恢复成功记录。公钥读取 12 项、参数捕获 2 项、解密模块最终 7 项定向检查通过；原生拒绝入口检查自然退出 0、1/1，限定审查完成。OS/云端响应仍为合成边界，不代表真实恢复。详细原始失败和证据范围见 [认证解密计划](../superpowers/plans/2026-09-28-stage1-r3-authenticated-plaintext.md)。

尚未实际挂载 H1、读取真实私钥或恢复数据库。云端同一次 OAuth 续期和来源性质问题继续待答，没有新增批准请求；独立 reader 配置、远端复制与恢复、同候选双链及 R4 真实验收仍未完成。合同与发现登记已通过，未增加业务功能或测试矩阵。

## 前一下载增量

R3 同会话密文下载已接通。无参数 `fetchSnapshot()` 只在 source/snapshot 已消费的会话内执行一次，使用固定独立 RAM 角色的短期凭据，核对当前 OSS 元数据与完整密文摘要，保留私有读回、原消费 UNKNOWN 及锁；不会生成恢复成功记录。读取器 6/6、最终下载模块 11/11 通过，有限审查发现的 SDK 原始响应形状与回读流关闭缺陷已修正并复审。合同、发现登记和格式检查通过。

单个 Linux 会话整合自然退出 0，1/1、0 skip，测试体 855,753.608757 ms。该冻结副本使用修正前的下载模块；最终三项 helper 文件的修改由 11/11 定向回归覆盖，另外仅修改合同发现登记，原生 wrapper/reader/输入 fixture 与整合副本字节相同。测试使用真实私有文件、密文字节、会话及 TCP，SDK/GitHub/Engine/PG 为合成响应，不是真实 OSS/数据库验收。具体失败、修正和范围见 [下载接线计划](../superpowers/plans/2026-09-28-stage1-r3-native-snapshot-fetch.md)。

实际云端仍未配置 snapshot reader：CLI 的 RAM 查询返回 `invalid_grant`，同一次 OAuth 续期问题待答；Edge 工具连接仍失败。H1 两个加密卷当前卸载、swap 已恢复，尚无 bootstrap 凭据。本地既有两份 DPAPI unlock 文件及单用户 ACL 已核对，没有解密或写入未挂载目录。本轮无云端、服务器或数据库写入；来源性质问题继续待答。认证解密、数据库恢复、同候选双链和 R4 真实验收尚未完成。

## 前一增量状态

R3 输入读取器已补齐历史生产者加密原件的固定读取：envelope 引用的授权文件必须存在、符合本地密钥 v2 合同，并与 envelope/context/key fingerprint 对应；持有期间继续核对文件身份和字节。返回冻结的解密参数，沿用既有 RSA/AES-GCM 实现，不增加授权服务或 schema。6/6 定向用例通过，包含真实加密/认证解密合成字节；合同与登记校验通过。当前尚无同会话私钥释放、实际 OSS 下载或数据库恢复成绩。详细失败与最终验证见 [本轮计划](../superpowers/plans/2026-09-28-stage1-r3-payload-originals.md)。

本轮盘点也确认，此前 1 GiB OSS 下载校验对象为 RSA 密钥恢复 LUKS 卷，不是合法数据库快照；独立 snapshot reader 身份及实际合法输入仍未建立。既有来源性质问题继续待答，不重复申请已批准的 Docker、迁移或非商用方案。接下来补实际读取身份和同会话认证恢复，最终仍需同候选双链与 R4 真实验收。

R3 source 快照消费接线已实现，最终定向整合复验通过。`consumeSnapshot({inputReference})` 从同一创建会话派生精确目的地、候选和前序，通过固定输入读取器核对 permission 原件及主体，再沿用永久一次性槽、读回和 UNKNOWN 执行记录。创建最初 UNKNOWN、SUCCEEDED、保管原件和全部锁均保留。

本步没有读取密文、释放解密私钥或执行 restore；final 消费在匹配 source 执行证明读取器补齐前继续拒绝。后续是实际认证恢复、lifecycle 执行和清理、hosted 接线及真实验收。当前无需再次批准 Docker、迁移或非商用方案。

输入读取器 4/4、既有 R3 会话 7/7、API 输入检查 1/1 通过；小型参数边界修正后的针对性回归也通过。有限独立审查无阻断项。第一次整合因复用的 fresh 夹具被消费入口正确拒绝，改为 snapshot 夹具后，最终 Linux 整合自然退出 0、1/1、0 skip、844,187.787811 ms；271 项源码与运行副本一致。该结果使用真实私有 Linux 文件、会话与 TCP，GitHub/Engine/PG 和 SQL helper 为合成载体，不是真实 hosted/数据库验收。完整证据记录见 [本轮计划](../superpowers/plans/2026-09-28-stage1-r3-source-consumer.md)。

## 已完成增量记录（各项保留当时边界）

- R3 同会话创建完成记录已接通：原生 `completeCreation()` 无参数且仅一次，前后核对当前资源；会话独立重放已归档的 hosted/PG/数据库原件，核对消费、撤销和精确锁集合，追加指向原 UNKNOWN 的 SUCCEEDED execution 及四条实际 archive/backup custody。完成记录保存 journal/archive/backup，并在后续重查中读回。原 UNKNOWN 和已消费锁仍保留，未授予 snapshot-consumer 或清理权限。最终代码的单个 Linux 定向复验自然退出 0，1/1、0 skip、527,434.613643 ms；269 项源码与冻结副本一致。该结果为合成整合，非真实 hosted/PG/CI 验收。
- 有限审查确认并修正 R2/R3 共用归档的两处兼容问题：旧 R2 校验器不认识 R3 destination/observations，且不接受二进制 Docker 流作为 UTF-8 原件。现在仅排除独立重放确认的 R3 对象与执行流摘要，无关原件继续拒绝。短回归先 RED 后 GREEN；既有未决/已 reconcile 的 R2 历史用例通过。没有新业务功能、数据库 suite、例外、云端写入或商用 KMS。
- R3 目的地原件已接入同一创建句柄：无参、仅一次的 `recordDestination()` 重新读取实际 PG 两端身份和数据库事实，绑定原 UNKNOWN/session、job/workspace、完整 manifest 初始目标及物理/namespace 锁。PG resource/exec 与 SELECT 原件可重解析，目的地及观察对象分别保存 archive/加密 backup 并持续比对；普通关闭保留 UNKNOWN 与锁。返回仍为 `DESTINATION_OBSERVED`，创建成功、custody/consumer/cleanup 及实际 workflow 尚未接通。
- 本轮纯 helper 5/5 通过，单个 Linux 整合 1/1、0 skip、341,391.7058 ms，自然退出 0；有限独立审查通过。native 复用既有 SQL helper 替身验证接线，全量 SQL 重放由纯用例覆盖；GitHub/Engine/PG 为合成响应，不能登记为真实 CI/数据库验收。没有增加业务功能、数据库 suite 或例外，没有线上写入和服务启停。
- R3 hosted 证据已接通导出、H1 固定目录排他导入、加密备份读回和同会话 Engine 对照。观察子目录在持有 job 原件前保留，避免自身写入破坏父目录身份；导入失败保留部分原件并拒绝覆盖。返回仍为非准入观察，原 UNKNOWN 和已消费锁保留，没有生成创建成功或快照消费权限。
- 有限审查发现原件摘要不足以核实 containerd 声明事实，已抽出采集端与导入端共用的解析器，核对 PID/父进程/starttime、配置和监听归属。有效签名但父 PID 矛盾的回归先失败后通过；纯校验 8/8，Linux 联合 16/16、0 skip、148,698.816965 ms，独立复核通过。这是原生文件/socket 加合成 hosted 原件验证，不是实际 CI/LUKS/PG 成绩；实际交付、destination、SUCCEEDED/consumer/cleanup 和 workflow 仍待完成。
- R3 hosted 控制端已补入运行中 managed containerd 的只读观察：父 PID/starttime、实际配置、数据/状态路径、Unix listener 与 PID 持有的 socket 对照，并把实际 mount 的 dev/ino 绑定到 creator 的 active 原件。每次 PG 转发前重新核实；漂移关闭转发，失败保留 UNKNOWN 和工作区。定向 Linux 10/10、0 skip 通过（`r3-containerd-control-green02.log`，3,328.36227 ms）；进程/socket 为真实测试载体，containerd/PG/文件拓扑为夹具，不是实际 hosted 成绩。目的地原件、同会话成功/消费/清理和 workflow 仍待接通。
- 初始 R3 目标锁已接入原 H1 会话：先持有两个固定通道槽，再按实际 Engine/system identifier/OID/marker 排序获取库锁，并保留 lifecycle 两个固定库名的 namespace 锁。原生入口使用自身观察，锁后再次读回数据库；碰撞、替换和部分失败均拒绝，普通关闭保留 UNKNOWN 与锁文件。该实现不授予快照消费权限，生命周期动态锁和实际清理仍待完成。
- 本轮继续接通 R3 数据库集合创建：H1 固定读取链传递已验证 manifest；`provisionDatabases()` 使用已观察的同一 PG，仅允许一次、无调用方覆盖。覆盖 35 个普通库和 clean-acceptance 双库（37 库），final 再加独立应用库；逐句创建与权限/OID/marker 读回已实现。密码在原 H1 私有目录保管，不进入诊断；失败保留部分资源与 UNKNOWN。当前为代码接线，尚未真实创建这组目标。
- lifecycle 两库仅列为无 OID 的 reservation，必须由该 suite 在受控执行期完成真实创建、回收和 sibling 隔离断言。生命周期实际身份扩展、创建成功/消费/清理原件图、实际 hosted/runtime 接线仍待补齐，不能把本次 `DATABASES_OBSERVED` 当作发布准入。
- 有限审查补齐两处：角色 membership 的两个方向均须为零；首个数据库凭据或 SQL 变更前持久保存完整计划和原 marker 时间。定向原生测试还定位到自身创建目录使既有凭据 pin 失效，已改为先完成目录/文件准备再固定句柄，未放宽文件身份检查。测试结论与失败原件见下文。
- R3 创建入口已增加一次性的 `provisionPostgres()`：在原创建消费之后，以固定 PG17 镜像、内部网络和加密目录内的命名卷创建目标，经固定 H1 通道与同 CID 内部 TLS 查询交叉核对集群身份。密码通过单成员私有 tar 交付，不归档请求内容。当前只返回观察事实；成功创建、完整目标集合、消费和清理结果尚未接通，UNKNOWN 与已消费锁仍保留。
- hosted 原控制进程现提供固定 `127.0.0.1:55441` TCP 转发，每次连接前重新核对本操作 Engine/CID/网络/卷，仅连接实际 PG 地址的 5432 端口。内部网络不使用 Docker 端口发布。启动前后拒绝系统 containerd socket，实际 hosted job 的默认服务停用和加密 containerd 路径读回仍待接线；没有改变 H1 系统服务。
- 本轮服务器维护实测已取得 PG17.11 的 TLSv1.3 查询原件及集群标识，但探针总状态仍为 INCOMPLETE/exit 1：`inet_server_addr()::text` 带 `/32`，比较器要求裸 IP。根审查发现生产查询同样受影响，已改成 `host(inet_server_addr())`，两端共同使用该查询。维护原件不追记为 PASS，不再重复整套维护；具体失败、清理读回和定向回归见下文。
- 尚未执行真实 hosted/LUKS/同候选数据库链，没有恢复 API/Web 或应用待迁移；阶段 1 仍未收口。接下来优先闭合 R3 目标集合、结果图与消费/清理，再生成最终候选及真实验收，避免源码继续变化时重复构建。
- 同一地址格式缺陷也存在于 R2 H3 原件 SQL：它与目标裸 IP 严格比较，已同步改成 `host(inet_server_addr())` 并对齐既有合成 SQL。未更改身份比较条件，没有重跑 normal/interrupted/replay 长链。

## 此前接续记录

- 本轮已接通创建启动路径的生产入口：H1 复用固定 job/session，取得双锁后安装该 job 的受限 SSH 公钥；分配/签名/持久消费后才发送唯一创建 POST。hosted 单次控制入口完成 202 和旧连接关闭后，调用加密工作区 creator 并启动加密目录内的独立 classic overlay2 Engine。H1 通过固定通道读取实际 Engine 事实；202 不是创建成功，UNKNOWN 与已消费双锁仍保留。CLI/workflow 尚未启用，PG 目的地、成功/consumer/cleanup 结果图仍未闭合，不能据此声明真实 hosted 双链通过。
- H1 受限公钥仅在两个当前 PID/scope 原件锁、实际 sshd 和完整首条防火墙规则均匹配时安装，关闭只撤回未漂移的自有 key，不声称已有 SSH 连接终止。一次真实 H1 只读检查确认有效 SSH 配置和两条首位规则，未改服务器配置。启动测试已复现并修正 202 到 Engine 交接期间的空 409；最终定向结果见本页证据定位。
- 本轮定向验证：H1 原生合成整合 4/4（104,549.831935 ms），hosted 控制端 4/4（8,913.616205 ms），均自然退出 0、0 skip。前者复用原 H1/H2 夹具及真实 Linux 文件/TCP HTTP，后者使用真实 Unix HTTP/Node 子进程；GitHub、SSH 配置和危险创建/daemon 行为按用例替身，不能合并称为真实 CI/LUKS/PG 成绩。合同检查为 210 文件、83 schemas、128 migrations、13 commands；登记检查为 98 candidates / 39 manifested / 59 excepted / 0 unclassified，未增数据库 suite 或例外。
- R3 hosted 工作区创建原语已实现并登记：复用固定规范/job/profile 与 v4 签名，核实实际 job 环境、机器、无 swap/core、tmpfs 和完整 absent 拓扑后，仅执行本 UUID 的固定 LUKS/ext4 创建命令；挂载后收紧实际根目录权限并读取 active 原件。失败保留部分资源和原始诊断，不启动 Engine、不恢复数据库、不声明创建目标成功。合成定向最终 4 个顶层用例、6 个通过计数（4,226.7193 ms），语法/格式检查通过；其中 final caller/signer 混同先复现再修正。上述控制入口现已补入，仍未执行真实 hosted LUKS 创建。
- 本轮已用实际 H1/OpenSSH/Docker 验证创建前的通信交接：同一 SSH 连接和 55440 监听先访问临时 HTTP socket，旧 listener 关闭后由独立空 daemon 绑定同一路径，转发与直接读取的 Engine ID 一致。维护进程均正常退出 0，独立 SSH 确认临时 key、进程、socket 和固定端口监听均无残留，原 Engine ID/容器数/镜像数未变。该实测仅为无业务载荷的原生通道验证，不是 hosted、LUKS、PG 或候选验收；详见 [通路实测](2026-09-27-stage1-r3-remote-engine-feasibility.md)。
- 上一片已接通 R3 创建会话固定入口：由已验证规范/job/H1/H2 派生 scope，再使用原 H1 签名钥、v2 撤销链和一次消费台账。独占 55440/55441 双槽；返回消费判定前落盘唯一消费记录、读回及 UNKNOWN execution。已消费或关闭出错时保留锁，job 结束后仍可关闭本地句柄。旧 R2 未解历史继续阻断，原 apply UNKNOWN 经 reconcile 核实后保留原件并允许继续。核心 4/4、Linux 整合 7/7（0 skip，28,435.500243 ms）通过，有限独立审查通过。当前只接通 target-create 授权边界，不能记录成功创建或授予 snapshot-consumer；尚未执行真实资源创建、恢复或清理。
- R2 apply-interrupted `68888` 已自然结束，host/Node exit 1，0 pass / 1 fail / 0 skip，644,033.312586 ms。失败准确落在已结束 UNKNOWN 的备份被移走后仍未拒绝（`Missing expected rejection`）；871 份保全文件自一致检查通过，原失败未覆盖。
- 已将结果核验器的 Runner 备份条件从仅 `SUCCEEDED` 改为 `SUCCEEDED` 或 `finishedAt !== null`；pending UNKNOWN 仍不要求不存在的备份。唯一重验 `43338` 已自然结束，host/Node exit 0，1 pass / 0 fail / 0 skip，1,685,953.300037 ms；原 apply UNKNOWN 保留，reconcile 成功后最终核验为 `PASS`，计数 4/4/3/0/1/0，report digest `sha256:d8733a89675b1bbf9519ceb75d8392e4bf0d2b2a72d04a0e28d5d8d414b4f124`。1,046 份保全文件自一致检查通过。这是合成 native 组合，不是实际 PG/CI 成绩；没有再跑 normal 或旧故障矩阵。
- R3 固定目标策略、schema 与 manifest 登记已补齐，并经一次有限独立审查。它引用已批准 H1 profile，限定既有 source/final workflow、hosted 身份、固定两条通道与加密 Engine 目录。定向契约用例 1/1 通过，全部 schema 编译用例 1/1 通过；未接线 runtime、签发创建/消费能力或建立远端目标。具体顺序见 [R3 目标策略切片](../superpowers/specs/2026-09-28-stage1-r3-target-policy-slice.zh-CN.md)。
- R3 固定策略读取入口现已接入既有 H1/H2 校验，保留原件句柄并在重读中核对主机、profile、源码和构建绑定；没有签发能力。首次 native 测试 1 pass / 2 fail，定位到既有数据库策略 catalog 与 schema 不一致；保留 catalog 后，将 schema 修成两个互斥的现有策略分支，定向回归先 RED 后 GREEN（1/1）。读取器第二次 native 测试自然 exit 0，3 pass / 0 fail / 0 skip，5,400.665206 ms。它仍不证明实际 hosted 目标、创建/消费会话、解密或恢复通过。
- R3 创建 request/auth v4 及纯签名绑定已补齐，沿用同一 Ed25519 签名域；绑定计划、job、候选和分支，不要求尚未生成的目的地事实，也不授予消费或生产 decision。两个新增用例先 RED 后 GREEN；整个原合同文件首次 80 pass / 1 fail（导出清单漏更新），修正后 81 pass / 0 fail / 0 skip，7,372.7318 ms；有限只读审查通过。实际 session/台账分支和创建执行仍未接线。
- R3 创建规范固定读取器已完成：按 UUID 从既有私有 archive 读 canonical 原件，核对 H1、同一 H2/策略、派生路径、容量与时窗，保持原件句柄供重读；不读取私钥或 payload。API 用例先 RED 后 GREEN，3 个 native 定向用例自然 exit 0，3 pass / 0 fail / 0 skip，9,680.947632 ms；有限只读审查通过。实际运行 job 的准入原件、创建会话及资源执行仍未完成，不能将此结果视为目标准入。
- R3 当前 job 固定读取入口已接入声明签名与原生 GitHub run/job API 校验，区分 final 的 reusable signer 与 caller，绑定展开 job、chain、公钥指纹和 runner；重查会拒绝已终止作业。API 用例先 RED 后 GREEN，native 4 pass / 0 fail / 0 skip，19,066.888217 ms；有限只读审查通过。此处 GH 响应为合成夹具；声明生产器、实际 hosted workflow、manual 会话及创建/消费执行仍未接线。
- R3 会话/消费/执行/保管记录 v3 与尝试分配 v2 已补齐，父判定显式接受创建 v4 和消费 v3，并继续使用原 v2 撤销链。消费只接受同一 snapshot 会话的成功创建前序，目的地摘要必须匹配；创建不接受尚不存在的目的地或输入。父合同测试有效 RED 为 82 pass / 7 fail，完成后 89 pass / 0 fail / 0 skip；分配定向用例有效 RED 后 2/2 通过。有限独立只读审查通过，未扩展 MS2 协议。此处仍是合同层，native session、完整原件图、资源锁与实际创建/消费尚未接线。
- R3 加密工作区只读观察入口已补齐，按固定 UUID 路径采集 mount/mapper/loop/backing 和 LUKS2 原始输出，保留真实进程 close，检查 tmpfs key 路径及观察前后的文件身份；不读取 key/backing 内容。absent 分支要求成功读取完整拓扑和明确 ENOENT，不把错误当清理完成。解析器先 RED 后 6/6 GREEN；Linux 采集边界 4/4、0 skip、3,011.010016 ms；有限只读审查通过。实际内核/文件元数据为合成夹具、子进程为真实 Node，不能当作 LUKS 或 hosted CI 验收。当前仍缺同 job 原件保管/验真、Engine/PG 两端映射、完整 destination/cleanup 图和会话接线。
- R3 工作区原件的同 job 签名绑定与固定读取器已补齐：复用已验证 job 的临时公钥，从固定私有路径持有报告、绑定和摘要寻址原件，重建观察事实，并在 recheck 中复核当前 job/H1/H2 和原件。纯校验 5/5 通过；Linux 定向读取 4/4、0 skip、13,675.138794 ms，有限只读审查通过。文件 mode 超范围截断问题先复现再修正。测试中的 GitHub、LUKS 拓扑及报告均为合成原件，不是实际 hosted 执行；仍缺 producer/workflow、Engine/PG 完整目标图、创建/消费会话和清理执行。absent 也要求原 job 尚在运行，不授予锁释放。
- R2 replay 失联定向进程 `63867` 已自然结束，host/Node exit 0，1 pass / 0 fail / 0 skip，2,202,765.847824 ms。三个正常子进程 exit 0/null，replay 子进程 PID 29913 实际 close 为 null/SIGKILL；原 apply 保持 SUCCEEDED，replay 保留唯一 INTERRUPTED_UNKNOWN，finishedAt/resultDigest/processEvidenceDigest 均为 null。再次调用拒绝，launches 4、credentialReads 15、observerConnections 1 均未增加；分配和请求数也保持。1,132 份保全文件（含 12 公件及 Git bundle）自一致检查通过。此前失败仍保留，未重启或重复 normal/interrupted 长链。R2 结果核验器、真实 PG 入口和合成组合代码现已可提交收口；真实 PG17 与最终 CI 验收仍未完成。
- 本轮本地 migration status 仍因缺少 `datasource.url` 自然退出 1；schema validate 自然退出 0。没有连接或更改线上数据库。

## 已取得的证据（保留各次失败与修正）

- 官方 CLI 续期已在此前用于 OSS 密文上传和完整 1 GiB 回读，两个进程退出码均为 0，摘要一致；当前没有待处理的续期请求。该事实不等于异机解密恢复完成。
- normal 组合测试 `51368` 自然退出 1。保存原件确认 observe、dry-run、apply 均为 `SUCCEEDED`，两个 Runner 子进程退出 0；首次独立结果核验失败，后续 verify/replay 尚未运行。
- 测试夹具的 `execFile` 分支错误地读取原始 `f.gh`；仅两处改为已传入的 `gh`。最小真实进程复现先出现 `expectedSpawn` 未定义，再通过（1 pass / 0 fail / 0 skip，实际 PID 82343、close 0/null）。生产执行规则未因此改变。
- 复用已保留的原始档案，进一步定位核验器误要求 target-observe 执行件具有 backup。现有 target-observe 只生成 archive 读回；Runner 成功执行件才在此检查 backup。修正后，同档案只读核验实际通过（1 pass / 0 fail / 0 skip，68,507.134551 ms），返回 `NOT_RUN`、计数 `expected=5 / consumed=3 / succeeded=3 / failed=0 / interrupted=0 / unresolved=0`。两次当前证明校验具有真实进程退出记录；867 个恢复文件前后摘要一致，未恢复私钥、凭证或重造签名记录。
- 完整 normal 重验 `7809` 已自然结束，host/Node exit 1，0 pass/1 fail/0 skip，2,560,020.847688 ms。observe、dry-run、apply、verify 原执行件均为 `SUCCEEDED`；迁移后独立核验返回 `NOT_RUN`、计数 5/3/3/0/0/0。replay 在 READY 后最后凭据释放检查发生 `MANUAL_TIME_INVALID`，最终独立核验尚未到达，不能称 normal 通过。
- replay 的原 receipt 为 `18:26:49.654Z` 签发、`18:27:19.654Z` 到期，DISPATCH_CLOSED 为 `18:27:24.165Z`（清理端点，不等于精确失败时刻）。实际子进程 PID 86172 exit 1，记录的连接/工具/query 均为 0；replay 保留 `INTERRUPTED_UNKNOWN`，原 apply 成功记录未改写。1,086 个保留文件（含 12 项公件和原 Git bundle）自一致检查通过；原临时 fixture 已清理，此检查不宣称源目录仍可逐项比较。
- 对同批原件的只读组件测量：session 整图读取约 1,691.808 ms、launcher 整图读取约 2,012.996 ms，两者读取相同 205 对象/660,697 bytes。205 份副本前后摘要不变、外部 effect 为 0。这不是原完整窗口计时，不能据此归因、延长有效期或删除最终检查。首轮在 import 阶段因缺已有 `postgres` 依赖 exit 1，未测量；保留失败后补入已锁定依赖的精确副本，测量自然 exit 0。尚未再跑 normal、apply-interrupted 或旧故障矩阵。
- R3 最小 consumer 合同已补齐前向 request/auth v3：只有 source/final，候选只引用一个 `buildProofDigest`，输入绑定固定 selector 和 index 原始字节摘要；final 另绑定既存 source 证据。定向 RED 后，原合同测试文件 79/79 通过（0 fail/skip），仓库合同校验通过（197 文件、78 schemas、128 migrations）。旧 v2 schema 字节不变；生产 session 仍拒绝 v3，此结果不授予读取、解密或恢复权限。
- 新定向 receipt 用例在准备阶段暴露 H1 路径误判：真实 `/tmp` 公共祖先目录的 nlink 从 59 变成 60，使未变化的私有原件被拒绝。只对既有 `contents=false` 且两侧均为目录的祖先比较允许 nlink 波动；dev/ino/mode/uid/gid、私有目录完整比较、叶文件 nlink=1 和独立重读均保留。直接 H1 回归先出现 1 pass/1 fail，修复后与既有私有根目录替换拒绝用例一起 2/2 通过（0 skip，3,276.926508 ms）。未通过改变生产器临时目录规避该问题；receipt 用例的早期准备失败不算有效边界验证。
- 已将三项与 receipt 无关的交付准备检查原样移到 sign/consume 前，保留原 30 秒期限、首次新鲜消费检查、READY 后资源与输入检查，以及 secret pin 后最终检查。定向篡改在实际 receipt 写入时改变 Docker 目标身份：旧顺序的有效 RED 未到 READY；新顺序实际收到 1 个 READY 后拒绝 `MANUAL_H3_RESOURCE_MISMATCH`，凭据交付/连接/工具/query 均为 0，原消费 receipt 与唯一 UNKNOWN 执行件保留。新用例自然 exit 0，1 pass/0 fail/0 skip，163,115.184884 ms；实际子进程 PID 96622 exit 1/null 是预期拒绝。此结果只证明该边界仍有效，不证明完整 normal 已通过或原 replay 超时已消除。
- R3 已从现有元数据校验中抽取共享 `verifySnapshotMetadataDeclarations`，可核对声明关系而不读取 dump；原 `verifySnapshotMetadata` 仍在原校验顺序中强制核对 dump 摘要。新增用例先因缺少函数得到有效 RED；随后新声明检查与既有过期/合同漂移/迁移头/dump 漂移用例合计 3/3 通过（0 skip，3,183.8588 ms）。只读声明入口不代表密文字节已读回、来源权限已核实或消费已获准；固定私有 index/raw 读取器及实际消费接线仍未完成。

本轮离线预检：Prisma schema validate 退出 0；migrate status 在子进程未设置数据库 URL 的条件下退出 1，错误为 `The datasource.url property is required in your Prisma config file when using prisma migrate status.` 此命令没有连接数据库，不能据此推断服务器当前迁移状态。修改文件语法、Prettier 和 diff 检查通过。

R3 固定私有原件读取器现已实现：`readR3SnapshotInput({repoRoot,inputReference,now})` 在 Linux 固定 H1 身份下读取 UUID index 和摘要寻址的原件，复用既有路径/ACL/句柄重读、元数据、封装和 custody 校验。它核对来源/用途声明、扫描及指纹、原生 OSS 上传/Head/Get 的对象关系与时间、私有 ACL、保留期及版本；返回冻结事实与 `recheck/close`。Get 的密文正文引用只校对声明，未打开正文；原生 XML 解析从现有 expected-schema 读取器原样抽取共享，未新增云客户端或授权服务。

该读取器的三个定向 Linux 用例自然退出 0：3 pass / 0 fail / 0 skip，14,334.682782 ms；245 项复制源码摘要一致。用例覆盖完整合成图、过期/错源/非零扫描/错版本/错误上传响应/非独立读者/过早读回/缺原件，以及重读过期和原件篡改。随后入口类型检查发现 selector 对象可触发隐式 `toString`；用有效绝对路径复现 RED 后，加上字符串与纯 Date 检查，该单一定向入口用例通过（1/0/0）。这不构成真实来源授权、当前 OSS 下载、认证解密、恢复或 R3 消费会话验收；生产 session 的 v3 接线仍待完成。

本轮仓库合同校验通过：当前工作树 198 文件、78 schemas、128 migrations、13 commands；其中包含尚未提交的 R2 工作，不能当作最终候选证据。

R2 normal 重验 `75700` 已自然结束，host/Node exit 0：1 pass / 0 fail / 0 skip，测试体 2,867,459.915912 ms。最终独立核验返回 `PASS`、计数 `expected=5 / consumed=5 / succeeded=5 / failed=0 / interrupted=0 / unresolved=0`，report digest 为 `sha256:a4f6c1ac4fcff9ad1e744eb710ea474e33a993c11daae99ba255d613be214717`；四个 Runner 子进程（563/630/1887/2155）均 exit 0/null。replay 原执行件为 `SUCCEEDED`，本次没有重现先前交付超时。原 `7809` 失败仍保留；不从本次合成结果推断真实 PG17、CI 或线上验收通过。

本次 normal 保全的 1,175 文件（含 12 公件及 Git bundle）自一致校验通过；原临时 fixture 已清理，未声称仍可与临时源目录比较。随后只启动 apply-interrupted 的单一组合 `68888`，冻结 244 项源码（包含新登记的 R3 读取器）；生产核验器仍只检查成功 Runner 的备份，待定向 RED 后再修正已结束 UNKNOWN/FAILED 的备份要求。没有并行重跑另一条长链。

## 剩余收口顺序

| 顺序 | 尚未完成的工作                                                        | 完成依据                                                                               |
| ---- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | R3 剩余生产接线：认证恢复/final 消费/清理、lifecycle 及 hosted job    | 复用已接通的目的地和创建完成图；37 suites 实际目标齐全；按实际 job 核验存储及通道      |
| 2    | 最终候选的受保护 CI 构建与 H2 证据读回                                | 同一源码、API/Web/Runner 镜像及独立保管身份的真实原件                                  |
| 3    | R2 两个独立 PG17 目标的 migration、权限读回、verification / reconcile | normal 和 apply-interrupted 各自的真实 operationRef、目标身份与结果；原 UNKNOWN 不改写 |
| 4    | R3 合法快照认证恢复及同候选 fresh / snapshot 双链                     | 合法来源、消费权限、独立保管读回齐全；两条 37-suite/API-Web 链真实执行                 |
| 5    | Staging 迁移对齐和服务恢复                                            | 发布链应用待迁移、读回实际状态；API/Web 健康及关键路径通过                             |
| 6    | R4 A/B 申请、签约、支付回调、激活、终态及恢复验收与签收               | 实际业务结果和审计记录、维护/恢复证据、负责人签收                                      |

2026-09-28 02:28（北京时间）经既有 SSH 身份只读核对：Staging PostgreSQL 正常，API/Web 及其余容器停止。数据库 `subscription_saas_staging` 的 PG 版本为 170010，迁移表共 127 行，其中 126 条完成、1 条历史 rolled-back、0 条活动失败；126 条已完成迁移的 checksum 全部与当前工作树匹配，无 remote-only 或 checksum 漂移。候选仍有 128 条，待应用的仍是 `20260925090000_stage1_operational_completion_terminal_shape` 和 `20260925091000_stage1_operational_completion_settlement_guard`。SQL 在只读事务内执行，没有应用迁移或读取业务行。

当前 manifest 有 37 suites，既有 batches 仅分配 30 个不同 suiteId；补齐 R3 目标映射时须覆盖剩余 7 个及 lifecycle 内部目标，不能以现有 batch 列表当作完整验收集合。无需新增业务 suite 或另起授权平台。

R3 路线已按当前收口决策纠正：此前拟做的 prebuild 读取器不属于本期必要路径，草稿已停止，尚未写入生产代码或执行测试。[最小发布决策](../superpowers/specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md)明确延期构建前私有快照依赖；本期构建沿用唯一 `build-proof.v1`，提升前完成合法 snapshot 链。

当前未接线的 `manual-runner-request.v2` 强制要求旧 bundle/dispatch/RC workflow，非商用 producer 授权 v2 也带有同类依赖。不能为适配这些字段恢复已延期平台或填写替代值。consumer v3 已完成纯合同层面的纠正，保留 v2 历史解释；固定合法快照原件读取器、创建会话、初始 Engine/PG/数据库集合和创建完成记录已实现。source 同会话持久消费已实现但尚未认证恢复；下一段补全恢复、匹配 source 证明的 final 消费、lifecycle 动态执行、清理结果及实际 hosted 入口。实际权限来源、对象版本、独立保管读回、目的地和消费会话仍须闭合，不能用测试原件替代。只有确需新 producer 时才对齐它的前向授权；已有合法密文不因消费合同更新被强制重生产。

R3 原件读取器复用现有 owner/profile/scope 及 manual 撤销台账。此前 memo 将外部 controller/current-status 服务、第二 checkpoint 和独立 grant 体系推导为统一前置条件，现已撤回；来源确有第三方许可限制时才按其真实原件处理。具体来源、用途、对象版本和存储读回是仍需核对的事实，不以此重复申请用户已授权的实施操作。

负责人、主机、Docker 恢复和无关容器暂停、迁移对齐及非商用方案的既有授权继续有效。当前无需用户重新登录或重复批准这些事项。

## 证据定位

- Source 消费接续：缺 API RED `4a7e7d`/`7da4f7`，错误 fresh 夹具的 native01 `e26f4b`/`8ba781` 均保留。最终 `r3-consumer-native02.log`（`2d6810`/`a6cf06`）自然 exit 0、1/1、0 skip、844,187.787811 ms；副本 `/root/.cache/r3-consumer-yfNknX` 对应 `20260928-065812-165061035-copy.sha256`，271 文件与源码一致（`a06d77`）。读取器 4/4（`5cd140`），参数边界修正后定向 1/1（`ab5a67`），原生 API 1/1（`c40d0b`），helper 报告现有会话 7/7；只读审查无阻断。最终合同 `0ee066` 为 218/83/128/13，digest `sha256:3fee60f8de55859e8f94a90e7ebbbcc7585911b2806ba6d38c97917aecda1065`；登记 `68dd1b` 为 99/39/60/0。本轮预检 `9fca32` migrate status 因空连接 URL 退出 1，Prisma validation `3b5a86` 退出 0；未连接业务库。
- 创建完成：缺入口 RED `8594ec`（`r3-completion-red01.log`）；准备轮 native01 因并行编辑在源码复制哈希比较处拒绝，未运行测试；native02 为修正审查前的 1/1 通过。两处混合历史兼容修正后，最终 `r3-completion-native03.log`（`2a0db8`）自然 exit 0、1/1、0 skip、527,434.613643 ms；269 项副本 `/root/.cache/r3-completion-5SxkBf` 对应 `20260928-052043-764618553-copy.sha256`，与最终源码一致（`d95beb`）。核心 7/7（`c50ed3`）；原件筛选短回归 `0ecfc8` RED → `5976d4` GREEN；旧 R2 历史定向 `070b36` 为 1/1。合同 `504b47` 为 218/83/128/13，digest `sha256:42b604da6f9a2a80064eeb3a4a85eb9e753b605ea3b1b82bc9f858f28118a289`；登记 `2d527f` 为 99/39/60/0。预检 `aba01b` migrate status 缺 datasource.url、exit 1；`362903` Prisma validate exit 0，无数据库连接。限制与有限审查修正见 [本轮计划](../superpowers/plans/2026-09-28-stage1-r3-creation-completion.md)。
- 目的地记录：`r3-destination-native01.log`（`d68683`）为唯一受影响 Linux 整合，host/Node exit 0、1/1、0 skip；269 项源码副本 `/root/.cache/r3-destination-1WH00J` 绑定 `20260928-043938-474339759-copy.sha256`。纯 helper 缺入口 RED `869b54`，GREEN `352b01` 为 5/5、1,367.7161 ms。合同首次 `dda5eb` 为登记漏项 `CONTRACT_FILE_SET_DRIFT`，修正既有 catalog 后 `f6a559` 为 218/83/128/13，repository digest `sha256:cd45f29ba45e4130a384a03806880b2d12b1204c1ad81b2fae61116b44c5cef9`；该登记修正晚于 native 冻结，目的地实现字节未变。登记 `861441` 为 99/39/60/0，格式/语法/diff `2c2a7d` 通过。预检 `b005fa` 缺 datasource.url、exit 1；`c9b98c` Prisma validate exit 0，无数据库连接。
- hosted 原件交接：Linux `r3-evidence-native02.log`（终端 `ebcfeb`）自然 exit 0，16/16、0 skip；私有副本 `/root/.cache/r3-evidence-T2k2Aq` 的 268 项源码对应 `20260928-042033-526981653-copy.sha256`。首次 `r3-evidence-native01.log`（`493855`）为副本缺依赖，7 pass / 1 fail，H1 文件未进入测试；保留该失败。修复原件一致性的 package RED `b90a45` 为 7/8，GREEN `bcca5e` 为 8/8；此后相关代码仅格式化。最终合同 `3209a5`：217 文件、83 schemas、128 migrations、13 commands，digest `sha256:abe771e857b90823df9d32f9484d09de1b3e3c6fa1caa0c05143adab59751bf5`；登记 `9d8c8e` 为 99/39/60/0。语法、格式及 diff 检查通过；本轮预检为 migration status 缺 datasource.url（`a5de54`，exit 1）、Prisma validate 通过（`e75cf6`），无业务库连接。
- 目标锁接线：helper/session 定向 9/9、0 skip、6,992.2068 ms（`53ae97`），日志 `r3-target-lock-session-green01.log`；此前缺方法的 RED 保留在 `r3-target-lock-session-red.log`。唯一 Linux 原生用例 `r3-target-locks-native01.log` 正常 exit 0（`e01d04`），1/1、0 skip、205,229.78784 ms，验证保留 41 个锁文件。私有副本 `/root/.cache/r3-target-locks-a3B2mo` 的 261 项源码绑定 `20260928-032310-074403845-copy.sha256`；Engine/PG/GitHub 和 SQL helper 为合成响应，不是真实数据库成绩。有限只读审查未发现阻断。
- 本轮目标锁合同校验 `ec03a7`：214 文件、83 schemas、128 migrations、13 commands，摘要 `sha256:2014b06d274c8790e1ebb3e27664c039b67a01421ac03eedfa5e1746a3df9437`。暂存区 discovery `9db43b`：99/39/60/0，未新增 schema、suite 或例外；语法与格式检查通过。本轮 migrate status 仍因未提供 datasource.url 退出 1（`179486`），Prisma validate 退出 0（`3bcd6a`），没有业务库写入。
- 数据库集合 helper：双向角色授权回归先 RED（2 pass / 1 fail，`03c8ea`），修复后 `r3-database-targets-membership-green.log` 为 3/3、0 skip、1,331.3963 ms（`b072bc`）。覆盖全部目标规划、逐句 SQL、角色权限、身份漂移与部分失败保留；SQL 使用模拟响应，不是真实 PG 成绩。
- 原生接线：`r3-database-targets-native01.log` 保留 132,709.559941 ms 的失败；`native02` 为 107,858.457508 ms、0/1，安全阶段诊断定位到新增凭据目录破坏旧 pin。修正准备/固定顺序后 `native03` 正常 exit 0（`005dfa`），1/1、0 skip、182,498.126631 ms，私有副本 `/root/.cache/r3-database-targets-xoMG3k` 的 260 项源码对应 `20260928-030457-619529185-copy.sha256`。Linux 文件与 TCP 为原生，Engine/PG/GitHub 和 SQL helper 为合成夹具；不能充当真实 hosted 或同候选双链证据。
- 本次合同校验 `a69d4b`：213 文件、83 schemas、128 migrations、13 commands，摘要 `sha256:059c40ad8be83a14fb1b8be0bfb182a592cfa98ee54f6c23a9a9a00358a6e694`。暂存区 discovery `a9b07d`：99 candidates、39 manifested、60 excepted、0 unclassified；未增加 suite 或例外。定向语法、格式与 diff 检查通过；预检仍为缺少 datasource.url（`06d6aa`）和 Prisma validate 通过（`deb27f`），本次未连接业务库。
- PG 创建定向验证：初始 `r3-postgres-launch-red01.log` 为 3 pass / 1 fail（缺少创建方法）；`green01` 为真实 OOM/SIGABRT、exit 1，494,306.442212 ms，保留私有副本和已取得的两端身份原件，不记为通过。精简重复远端重查但保留完整 Engine 交互前后检查，并清理测试重复 mock 调用历史后，`green02` 自然 exit 0，1/1、139,570.032649 ms。随后真实维护暴露地址格式问题，修正 SQL 与两端断言后的唯一 `r3-postgres-launch-green03.log` 自然 exit 0（终端 `652cfa`），1/1、0 skip、138,365.856627 ms；259 项源码副本 `/root/.cache/r3-postgres-launch-fuxKvN` 对应 `20260928-004044-680720111-copy.sha256`。后续仅格式化纯观察模块/测试，不更改语义。Engine、PG、GitHub 身份使用合成夹具，Linux 文件/TCP 为原生，不能登记为真实 PG/CI 成绩。
- hosted relay 与纯观察用例：`r3-hosted-relay-green01.log` 为 9 pass / 1 fail，固定测试 peer 5432 冲突；只将测试 peer 改为临时端口并保留生产 5432 约束后，`r3-hosted-relay-green02.log` 自然 exit 0（`1a5d36`），10/10、0 skip、2,855.528472 ms，261 项源码对应 `20260928-003114-220515847-copy.sha256`。实际 Node/Unix/TCP 配合合成资源，未重复旧 R2 长链。有限独立代码审查未发现可证实阻断；随后 root 根据真实 PG 输出另外修正地址 SQL。
- 维护 probe05 与失败前序详见 [通路实测](2026-09-27-stage1-r3-remote-engine-feasibility.md)。补充现有 PG17.10 的只读格式查询 `r3-pg17-inet-format-readonly02.stdout.log` 自然 exit 0，输出 `170010|172.17.0.2/32|172.17.0.2|t`，stderr 为空；末列证明采用本地 socket，因此比较的是显式 inet 值，不伪称实际 TCP server_addr。首试因未指定现有自定义角色而连接失败（exit 2），原件保留。
- 本轮发现登记初检 `f7ed9c` 报 1 项未分类；`r3-postgres-discovery-before.json` 确认是新纯观察测试的文件名触发 postgres 规则。明确登记其无 I/O 的 source-contract 例外后，`9ea6da` 自然 exit 0：99 candidates / 39 manifested / 60 excepted / 0 unclassified。未增减任何业务数据库 suite，不豁免真实 R3 门槛。本轮预检 `3f28f8` 的 migrate status 因缺 datasource.url 退出 1，`38ad6a` Prisma validate 退出 0；本地预检没有连接数据库。
- R2 同类 SQL 修正：首次定向 H3-A/B 直接在 `/mnt/d` 运行，在 build fixture 阶段报 `TRUSTED_BUILD_UNAVAILABLE`（原工具 `02625c` / `1599e0`，未保存独立 stdout），未到 SQL。复用现成 Linux 私有复制流程后，`r2-h3-address-native01.log` 自然 exit 0（`26d88d`），2/2、0 skip、12,319.040385 ms；259 项源码副本 `/root/.cache/r2-h3-address-bRo07l` 对应 `20260928-022922-821501795-copy.sha256`。这里只证明固定读取器及合成原件一致，实际 R2 两个 PG17 目标验收仍待完成。
- 最终代码合同检查 `244fce` 自然 exit 0：212 文件、83 schemas、128 migrations、13 commands，repository digest `sha256:c6cdc83d024030349ad06e0104f50ff4268583a5b9ce89c932963deccbca87ee`。代码语法/diff 检查 `eb132b` 通过，R2 两处补丁格式/语法检查 `6210f1` 通过；没有 push、merge 或 CI dispatch。
- 创建控制与 H1 接线：`r3-target-create-native05.log`（终端 chunk `902f56`）4/4，copy `/root/.cache/r3-target-create-Ua0Um3` 的 258 项源文件按 `20260927-233858-312816521-copy.sha256` 核对；`r3-hosted-creation-control-green02.log`（`39faa6`）4/4，原始 stdout 均直接捕获。此前 `r3-target-create-native01.log` 为 wrapper 换行准备失败，`native02` 为复制依赖/测试钩子失败，`native03` 为防火墙规范化 mock 未对齐；`native04`（`6d537a`）3 pass / 1 fail 是实际 409 交接 RED，修复后完成唯一最终轮。hosted 初始缺模块 RED 位于 `r3-hosted-creation-control-red01.log`；到期 RED `r3-hosted-creation-control-expiry-red02.log` 是旧实现 12 秒 timeout，不能记作断言失败。H1 实际只读原件为 `r3-h1-forward-transport-readonly01.log`。仓库合同 `59ac87` 和登记 `7609f5` 自然退出 0，repository digest `sha256:7372180ee648d3728a152365b8ee89acffa98ffa7a6ff3f0fe8dab48c4729379`；格式/语法/staged diff 检查 `176e72` 退出 0。本轮预检 `a7b069` 的 migrate status 因缺 datasource.url 退出 1，`3b6c2d` Prisma validate 退出 0；未连接线上数据库、未重复 R2 长链、未 push/merge/dispatch。
- Hosted 创建原语：最终工具原始输出 chunk `abf6ad` 自然退出 0（6/6），final caller/signer 有效 RED `b7769c`、定向 GREEN `67a9e9`，初始缺模块 RED 为 `2ffc19`。对应 `r3-hosted-workspace-create-{green01,final-red-b7769c,module-red-2ffc19}.log` 是可见工具输出转存，未直接捕获原 stdout 字节，仅作 partial 归档；原 chunk 保留，没有为归档重复测试。仓库合同检查 `4cc2f5` 自然退出 0：208 文件、83 schemas、128 migrations、13 commands，repository digest `sha256:e76b1659099f71c61ad17547cc565513b01d940e0f02a611b5aeec53d3a07c55`；包含新测试的 staged-index 登记检查 `eecd71` 为 98 candidates / 39 manifested / 59 excepted / 0 unclassified，没有新增数据库 suite 或例外。预检 `570d1d` 因缺 datasource.url 退出 1，`bbdd9a` Prisma validate 退出 0；未连接线上数据库。通道真实维护原件另见上面的通路核查，不能与合成创建测试合并宣称 hosted 验收通过。
- R3 创建会话：核心原始输出 `r3-creation-session-core-green01.log` 保留旧 allocation v1 无 sessionRecordDigest 的兼容失败，修正后的 `r3-creation-session-core-green02.log` 为 4/4。入口 RED 位于工作树 `scratch/r3-creation-session-entry-red01.log`。唯一 Linux 整合 `r3-creation-session-native01.log`（进程 2871，终端 chunk `b7ea3d`）host/Node 自然退出 0，7/7；copy `/home/keqi_119/.cache/r3-creation-session-l3M29F`，255 项源码按 `20260927-224636-101696654-copy.sha256` 核对。实际 Linux 文件系统/Git 配合合成 GitHub 与资源报告，不是真实 hosted 创建。合同检查 `eff4bd` 退出 0：207 文件、83 schemas、128 migrations、13 commands，repository digest `sha256:f1b7cf6bdc2b8a937865030d7bd9094fd141d3490c1faf74833e9e5132fd99e5`；数据库测试登记检查 `62ba6e` 为 98 candidates / 39 manifested / 59 excepted / 0 unclassified。当前预检 `f04fc9` 因缺 datasource.url 退出 1，`9ddcf0` Prisma validate 退出 0；未连接线上数据库，未重复 R2 长链。
  隐藏工作目录为 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/runner-second-stage/`：

- 原失败与保全：`result-verifier-native02.log`、`result-verifier-native02-preserved-check.json`。
- 最小夹具复现：`native-gh-closure-red.log`、`native-gh-closure-green.log`。
- 同档案核验 RED/GREEN：`normal02-readonly-verifier01.log`、`normal02-readonly-verifier02.log`，后者 report digest 为 `sha256:d81e1a5fa1f2747837b04c691bcf3ed0232d713c8402a641d64210b7818ed6f3`。
- normal 终态及原件：`result-verifier-frozen04.json`、`result-verifier-native03.log`、`result-verifier-native03-preserved-check.json`、`normal03-original-timing.json`；该核验进程已结束。
- 只读组件计时：`native03-receipt-await-chain-memo.md`、`normal03-graph-cost-result02.json`（原失败为 `normal03-graph-cost-result.json`）；不包含实际 session/凭据交付。
- 服务器迁移只读原件与比较：`staging-migrations-readonly-20260928.json`、`staging-migrations-comparison-20260928.json`；后者绑定原读回 SHA-256 `aa7bdda6d60dd0247c677a3a62f7bbdc6f4464a603e033e27d685ccc5f4537f8`。
- R3 范围纠正：`r3-prebuild-scope-correction-20260928.md`；此前 `r3-prebuild-input-reader-contract-20260928.md` 的“下一实施切片”建议已撤回，不再按它实施。
- R3 最小合同切片：`r3-minimal-consumer-forward-contract-proposal-20260928.md`、`r3-consumer-v3-red01.log`、`r3-consumer-v3-green01.log`、`r3-consumer-v3-contracts01.log`。这是固定签名/结构校验；其实际输入、消费会话和远端目标接线未完成。
- H1 公共祖先误判：`consume-h1-paths01.log` 保存实际变更字段；`trust-ancestor-red01.log` / `trust-ancestor-green01.log` 和同名 JSON 保存定向结果及复制源码摘要。`consume-resource-red01` 至 `red04` 均属准备失败，尚未触达 receipt 变更边界。
- 检查前移的有效边界回归：`consume-resource-red05.log`（0/1/0，171,240.391399 ms）与 `consume-resource-green01.log`（1/0/0）。每次都核对 243 项复制源码原始摘要；对应 manifest 分别为 `20260927-190140-561481037-copy.sha256` 和 `20260927-190549-209596540-copy.sha256`。原件保存在 `originals/consume-resource-change-*`，无真实密钥或业务凭据。
- R3 声明校验：`r3-metadata-declarations-red01.log`、`r3-metadata-declarations-green01.log`；范围纠偏原文为 `r3-lawful-input-reader-scope-correction-20260928.md`，覆盖前 memo 的外部授权平台推导。
- R3 固定读取器：`r3-reader-native01.log`、`20260927-194519-312525338-copy.sha256`；native copy 为 `/home/keqi_119/.cache/r3-reader-cF6Xog`。输入类型补强的 RED/GREEN 为本轮终端记录，未重复长链测试。
- R2 normal 通过：`result-verifier-native04.log`、`result-verifier-frozen05.json`、`result-verifier-native04-preserved-check.json`；保全目录 `originals/result-verifier-normal-bbdb4c44-be4b-439b-a8e5-7e23a1d2164d`。
- 中断组合有效 RED：`result-verifier-interrupted01.log`、`result-verifier-frozen06.json`、`result-verifier-interrupted01-preserved-check.json`；保全目录 `originals/result-verifier-apply-interrupted-73a9c6c4-4a81-4dd1-a4be-61ca492fd7ba`。修正重验 `result-verifier-interrupted02.log` / `result-verifier-frozen07.json` 为 1/1 通过；保全目录 `originals/result-verifier-apply-interrupted-14a38ced-7a09-463a-8011-b2d56cdc6390`，自一致报告 `result-verifier-interrupted02-preserved-check.json` 的摘要为 `sha256:d70d7d0daf56fcd2751bd195dc8107c07d5213ec468a7fb274216f75c89a95eb`。
- R3 固定策略读取器：`r3-policy-native01.log` 保留原 schema 不一致导致的失败；`r3-policy-native02.log` 为 3/3，通过复制清单 `20260927-204205-916584168-copy.sha256` 核对 247 项源码。当前仓库合同校验为 200 文件、79 schemas、128 migrations、13 commands，包含尚未提交的 R2 工作，不是最终候选证据。
- R3 创建合同全文件回归：`r3-creation-contracts-green02.log`，81/81；v4 登记后的仓库合同校验为 202 文件、81 schemas、128 migrations、13 commands，repository digest `sha256:421f75c4c7344f82e7953870e8f4d12b1437cf339e87e0f16c4f9f1c83e59ec3`。该工作树仍包含 R2 未提交部分，不能充当最终候选证明。
- R3 创建规范读取器：`r3-creation-reader-red01.log` 保留缺入口的 RED；`r3-creation-native01.log` 为 3/3 GREEN，native copy `/home/keqi_119/.cache/r3-creation-6kqBQg`，249 项复制源码均经 `20260927-211012-001929813-copy.sha256` 核对。测试使用实际 Linux 文件系统和 Git、模拟 GH 响应，不是实际 hosted job 验收。当前合同校验仍为 202 文件、81 schemas、128 migrations、13 commands，repository digest `sha256:e42650d86c8fe25af14d8d15fd69ca8dc1b47677838fa0fee5a0bcd451320fc5`，包含 R2 未提交部分。
- R3 当前 job 读取器：`r3-job-reader-red01.log`、`r3-job-native01.log`；native copy `/home/keqi_119/.cache/r3-job-fUV4eo`，249 项复制源码 manifest `20260927-212015-949658860-copy.sha256`。当前合同校验为 202 文件、81 schemas、128 migrations、13 commands，repository digest `sha256:fad2c3287a457fc1150d23ce0caf1ae3cbd7b91f3789990acddc4d597587c215`，包含 R2 未提交部分，不能充当最终候选证明。
- R3 会话和分配：父合同 RED 原始终端 chunk `783a94`，GREEN 完整输出 `r3-parent-record-green01.log` / `r3-parent-record-green02.log`；分配输出 `r3-allocation-red01.log` / `r3-allocation-green01.log`。本片仓库合同校验 `4d1f68` 自然退出 0，204 文件、83 schemas、128 migrations、13 commands，repository digest `sha256:a7ea6820c72aeb6f5e7f97f793333efec3c9af209d7d289c5fe2ab1ea344b53e`；仍包含 R2 未提交部分，不是最终候选证明。
- R2 replay 失联通过：`replay-loss-second.log`、`replay-loss-second-results.json`、`replay-loss-second-frozen.json`、`replay-loss-second-copy-check.json`。保全目录 `originals/stage2-replay-loss-reinvocation-0d75e978-53bb-477d-a989-a8f1035f28a4`，自一致报告 `replay-loss-second-preserved-check.json` 摘要 `sha256:e1ea1c4b3aecad3941f28c38783deac25aae949985a80508c41b939119ea9b76`。源码冻结在 `241c9951`，248 项复制文件与冻结原件一致；后续 R3 提交不追记为该次运行的源码。
- R3 工作区观察：`r3-workspace-collector-red01.log` 保存缺入口的 RED；解析器初始 RED chunk `446872`、别名矛盾 RED chunk `af837b`，最终输出 `r3-workspace-parser-green01.log`（6/6）。Linux 输出 `r3-workspace-native01.log`（4/4），255 项源码按 `20260927-215910-721351647-copy.sha256` 核对，native copy `/home/keqi_119/.cache/r3-workspace-Xrihd2`。首次仓库合同检查报 `CONTRACT_FILE_ORDER_INVALID`（chunk `5661ae`），仅修正新增项排列后 `0a6a18` 退出 0：206 文件、83 schemas、128 migrations、13 commands，repository digest `sha256:273aba749b1a5c67f2a3df734cad1d3dec4ffb6faf89188deecbe0d6b9a22f2c`；未重复 native 用例。预检 `0c9544` 的 migration status 仍因缺 URL 退出 1，`8667f8` 的 Prisma validate 退出 0，没有连接线上数据库。
- R3 工作区固定读取：`r3-workspace-entry-red01.log` 保存缺入口的 RED；纯报告数值边界为 `r3-workspace-report-mode-red01.log` / `r3-workspace-report-mode-green01.log`（4/5 后 5/5）。Linux `r3-workspace-reader-native01.log` 自然退出 0（4/4），254 项源码按 `20260927-221556-444807586-copy.sha256` 核对，copy `/home/keqi_119/.cache/r3-workspace-reader-7GuLMH`。合同检查 `e11407` 退出 0：207 文件、83 schemas、128 migrations、13 commands，repository digest `sha256:acd15e008a169471651ceddf1d0db55c7ba80ff5d6f85073f4304f7f80247d77`；这是本地候选代码验证。当前预检 `7ce58e` 的 migration status 因缺 `datasource.url` 退出 1，`07f87b` 的 Prisma validate 退出 0；未连接线上数据库。
