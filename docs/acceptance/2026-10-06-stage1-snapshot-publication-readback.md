# H1 快照发布与独立回读接线

本轮完成固定五对象发布、独立 hosted 回读入口及三作业工作流的代码接线，并安装 H1 运行包。尚未执行真实 admission、JIT、源数据制作、OSS 发布或最终 producer 终态；阶段 1 未完成。业务逻辑和迁移未改动。

## 当前实现

- H1 `DATA_PREPARED` 保存完整公开 crypto authorization，root 签名覆盖完整结果摘要。独立读者重新校验签名、授权、执行观察、清理观察与 crypto proof 的绑定。
- 固定 `publish` authority 只接受空请求，重新验证 dispatch 和当前撤销状态。它从固定受保护路径读取结果、密文及独立 publisher STS，要求 STS 在实际 crypto 进程退出后签发、有效期不超过 900 秒。调用者不能传入路径、对象内容、凭据或证明正文。
- 写入前校验全部对象。顺序为 `snapshot.enc`、`encryption-envelope.json`、`snapshot-proof.json`、`data-result.json`，最后写签名的 `diagnostics.redacted.json` 发布标志。每次写均禁止覆盖；部分写入或未知结果不重试、不作为完整发布。
- 独立 reader 通过真实 HEAD/GET 验证五对象、签名、摘要、字节数、私有 ACL、版本关闭和实际 WORM。公开 JSON 最多 1 MiB；仅允许经过完整类型校验的 `cryptoAuthorization.handoff.privateKey:false` 字段，不允许凭据内容。
- `.github/workflows/sanitized-snapshot.yml` 改为 `admission → snapshot-data → snapshot-custody`。admission 输出完整五标签，data 仅调用 H1 固定容器入口，custody 使用专用 OIDC 只读角色。
- 现有闭合 YAML 解析器仅增加单行 plain scalar 内镜像冒号、shell 参数和路径通配符所需字符；仍拒绝 flow mappings、aliases、block scalars、引入新映射的 `: `、动态 action 和未批准的 action commit。实际工作流通过完整准入 verifier。
- terminal observation 接受实际 `admission` job 名，保留历史 `snapshot-admission` 名；artifact 名仍为 `snapshot-admission`。
- hosted 作业输出 `provisional:true`、`terminalAt:null` 的保管凭证。最终工作流终态及销毁凭证必须由后续真实外部观察补齐，不能由运行中的作业自报。

## H1 实际安装

| 对象          | 摘要 / 事实                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| worker        | `sha256:bc827ff4e845aefa07f5b4ab6db22e478d95a68cbc89ecbfe41b9e437de3fead`；402 文件，1,435,012 字节    |
| control       | `sha256:a75a80603d9f8e40db316458b3a02e6d69205be0bbafff795338d26ce875442e`；2,338 文件，11,504,945 字节 |
| adapter       | `sha256:4fb979ef8db6673b3aa191a6f6d1c9ddd71e33665cff4e0ff279313a3d4c62ad`                              |
| producer 文件 | `42bd54f56938999a4ecbd812c831d295cc4d381355ac34385ecacf20c3e83680`                                     |

`77117a`、`4c4e69` 核验新只读 bundle 的全部文件、隔离加载与非法输入拒绝；`4e28b5` 根据旧配置摘要受控替换并回读 adapter。`3ad87d` 直接调用已安装 producer 的 `_verify_bundle`，确认文件数、总字节数和所有摘要匹配。

`7023e1`：H1 Python 3.6.8 的 19 项相关测试通过。实际环境无临时容器、mapper，attempt 目录只余锁文件；主/恢复卷关闭，源 reader 为 NOLOGIN、密码 NULL、会话 0，Staging PostgreSQL healthy，swap/core 已恢复。未重复创建数据库或 LUKS 卷。

## 有限验证与边界

- `ab6151` / `3a079a`：新增标签输出断言先失败；补实现后 `740d25` / `a90776` 的 21 项准入相关检查通过。实际工作流初次由 `f7d399` 确认解析失败，补足上述 plain scalar 后通过。
- `831aa8`：实际工作流经完整准入 verifier、hosted 身份约束及临时保管凭证边界三项通过；`5990bb`：19 项 storage、authority、custody、routing 检查通过。
- 本轮前段 `ad753b`：两项 H1 fixture 加密/公开发布核验测试通过，包含签名结果篡改和回读内容篡改拒绝；云服务和宿主观察是测试替身，不是生产原件。此前 `e43785` 的旧 fixture attempt ID 不符合实际 UUID 限制，改为 UUID 后通过，生产限制未放宽。
- 定向生产 JS/scripts ESLint、格式和 diff 检查通过；合同目录保持 128 项迁移、92 schemas、13 commands，新增两文件后共 314 个合同文件。未跑全仓测试或宣称 CI/真实工作流通过。
- 最终 `4c4f8f` 的 19 项完整准入测试通过；`172f18` 合同目录摘要为 `sha256:203011eb8ae1726d45c318312538aaaa1c15d06c5c6a87c0d28b9bc0fb02f431`。三个 foundation 测试文件补 Node globals 后，两个无诊断，routing 文件只有与 HEAD 一致的既有 `_removed` 未使用诊断；不扩改历史 lint 问题。
- Sol medium 分别只读审查核心发布及 hosted 入口；Luna 对齐 job 名兼容并验证。审查确认 `accessPolicyDigest` 目前是受保护配置提供的摘要，脚本不读取 RAM 管理策略。正式验收必须保留与其匹配的实际 RAM 回读原件；不能把该字段当成已完成云权限核验。

## R3 原件对齐补充

同轮后续核对 `readR3SnapshotDeclarations.checkStorage`，确认首次 PutObject 响应不能事后补造。publisher 现保存实际 SDK `res.data` 和必要响应头的安全投影，记录真实时间、principal、请求号、ETag 与空响应体摘要；只接受 SDK 实际提供的零字节 Buffer，不以缺字段推断空响应。缺失、非法或未知回执仍停止且不重试。

四份 PutObject 原件随发布标志签名，独立读者检查其对象地址、writer、时间、响应摘要与 ETag；ETag 同时与实际 GET 对齐。凭证中的 ETag 去掉 HTTP 外层引号以匹配既有 R3 消费契约，原始响应头仍保留引号。没有改动消费门槛。

`3e9904`、`405e59` 分别确认新签名回执字段和 quoted ETag 的回归失败；修复后 `370324` 两项 H1 fixture 测试通过，包含重新签名的错对象 PutObject 原件拒绝、最终 marker 的公开字段扫描。`44e850` 定向 lint 和六项 storage/custody 测试通过；初次 lint 的控制字符正则诊断已改为字符编码检查。没有重复数据库/卷生命周期检查。

`cbd361` / `179c15` 最终 H1 control 为 `sha256:ad39ebb6b10872803e3af27c6b2d6ff02477d57a404007fc2d6e1cbb00c5df2f`，2,338 文件、11,509,498 字节；最终 adapter 为 `sha256:e0b4b5d6a6dab140f20b34dd6b3ec2d81f04ccf50e29ffb8546703afe168d2ea`。worker 与 Python 文件未再次改变，全部 bundle 文件和安装配置回读通过。`9594a6` 最终合同目录摘要为 `sha256:ab283852bccb5c96d876db74c5653a35af392d4b514a329e393dc7fdf1731d03`，其余数量和迁移摘要不变。

真实首次上传尚未发生。R3 仍需要双方身份原件，以及工作流终态之后重新捕获的 Head/Get、GetObjectAcl、GetBucketAcl、Versioning、Worm 响应，不能将当前 normalized/provisional 回读改名作为这些原件。最终 completion/terminal 契约当前无生产生成器，但已批准的基础设施 addendum 明确要求它们，不能因旧消费入口未直接引用而省略。

## 必须继续完成

1. 补齐真实 workflow terminal、publisher 会话销毁及完整 destruction/completion 证据的既有收口路径；只使用实际观察，不新增通用平台。
2. 固定同候选 build/source-fresh，生成 dispatch/current-revocation 原件及独立 custody。dispatch 不含 producer run ID，可先生成；实际 run/job 出现后再绑定 producer crypto authorization。
3. 准备专用 publisher 和 hosted custody reader 的精确对象授权、保护环境及配置。新角色尚未创建或获批；新 RAM 差额仍交用户确认。已批准并完成的 archive 身份初始化不重复。
4. 将实际 RAM 策略回读摘要写入受保护配置，配置 H1 authority/producer inputs，再执行首次真实 producer、同候选 R2/R3、两项 Staging 迁移及 R4。

预检 `650e5c` Prisma validate 通过；`cc34d6` 实际 Staging 128 项迁移仍只有 `20260925090000_stage1_operational_completion_terminal_shape` 和 `20260925091000_stage1_operational_completion_settlement_guard` 待执行，专用隧道已关闭。本轮未新增 RAM/AccessKey、解锁主密钥卷、上传 OSS 对象或触发 GitHub 工作流。

## 身份、R3 回读原件与外部终态读取补充

本段 supersedes 上述“无身份原件/无终态读取入口”的实现状态，仍不代表真实 producer 或最终收口已经完成。

- publisher/reader 在创建 OSS 传输前用其实际 STS 调用 GetCallerIdentity，核对账号、assumed-role ARN、身份类型、请求号及会话有效期，仅返回公开身份字段。writer 身份原件纳入 H1 publication 签名，reader 回读时验证对应身份。没有保存或输出 STS 凭据。
- 固定 `snapshot.enc` 路径新增六项原件采集：GetBucketAcl、GetBucketWorm、GetBucketVersioning、HeadObject、GetObjectAcl、GetObject。保留 SDK 实际响应体、必要响应头及观察时间，验证 XML、私有 ACL、WORM 210 天、版本关闭、AES256、摘要和大小。先验证 HEAD 再下载；GET 密文只保留摘要/字节数引用，不混入声明原件。
- `readH1SnapshotStorageOriginals` 将经过签名验证的 PUT/身份原件与独立回读装配为既有 `r3-snapshot-storage-readback.v1`，输出可按摘要解析的原件。它不声称工作流已结束，不修改 provisional；最终调用方必须先读取真实终态，再重新读 OSS。
- 现有 `H1SnapshotGitHub` 增加固定 terminal 查询，通过 attempt-1 run、jobs、当前 run、再次 attempt-1 run，确认同仓库/main/dispatch/SHA/actor、准确三个 job 的成功终态及时间顺序。data runner 标签按既有规则忽略顺序/大小写并拒绝重复。private query pipe 与 JS reader 已接线；只在 GitHub token 撤销成功后返回 API 正文，不消费 route nonce。
- 控制包加入现有 OpenAPI SDK。初次构建 `d811b6` 因 SDK 的多版本 `@types/node` 编译期依赖发生冲突；排除 JS 运行包不使用的该类型包后构建成功，运行时依赖版本未替换。新模块同时加入 repository contract 清单。

必要验证：`e7b9c1` 先复现错误 HEAD 大小仍触发 GET，修复后 `7e0c65` 的 13 项身份、存储原件、发布衔接及 provisional 边界检查通过；`11b10b` 的两项 H1 原生加密/签名 fixture 检查通过；`4a8e30` 的 GitHub 相关 21 项测试在 H1 Python 3.6.8 通过。上述云调用由替身提供，不是实际发布证据。`301353` 只读查询既有 GitHub run，确认 jobs 的真实字段形状，没有创建或触发 run。定向 lint、format、diff 检查通过；初次 lint 的测试未使用常量已修复。

`434b89` / `162ce0` 安装并回读：control `sha256:9cb795e97fef8d49e05a1dc734ca75893892b8eee988e515e883685e07c230f1`，2,422 文件、11,878,719 字节；adapter `sha256:390d8c4542bbba73ff16fed38e78dacb92b127d8e1b0cdb72dbcf981ec11bf8d`。全部文件摘要、只读属主、SDK 加载及非法 private 请求拒绝通过；主/恢复卷保持关闭，attempt 无运行资源。worker 未改动或重装。`72b902` 合同目录为 316 文件、92 schemas、13 commands、128 migrations，摘要 `sha256:69fa52c0cd5017a49b8beddc7ffe860e2a5c22d6d0afceaefffe182da38ebc52`。

下一步只补既有收口链：从实际 tokenization key 生命周期、凭证清除和固定路径残留检查生成 destruction receipt，复用 publication 实际事实生成 publisher use proof 与 producer completion；随后串接上述真实 terminal 读取和终态后的 OSS 回读，生成最终 custody/R3 声明包。当前尚缺这段装配和采集，不能用 `cleanup:true` 推断全部销毁事实，也不声称物理擦除。完成后再固定候选、实际 build/source-fresh、精确 RAM 差额和首次真实 producer/R2/R3/两项迁移/R4。

本轮预检 `3bd055` Prisma validate 通过；`35b958` 实际 Staging 仍只有上述两项迁移待执行，隧道已关闭。未执行新的 RAM 授权、AccessKey 创建、真实 STS/OSS 读写、JIT、源数据导出、迁移或工作流触发。

## 数据进程清理事实补充

tokenization key 改由隔离 worker 在构造 workspace 前生成，不再经父进程配置传入。worker 完成时检查本地 Buffer 清零，并仅在 workspace 的既有销毁方法成功后报告其副本已清零；清理失败不会产生成功回执。不宣称物理内存擦除。

producer 在实际移除 worker/target 容器、复核固定源库 reader 为禁止登录、无认证信息、零会话并丢弃连接引用后记录清理观察。attempt 在销毁临时卷后核验固定 mount/backing/mapper 均不存在，spool 只含摘要匹配的 snapshot.enc，再保存检查时间和路径。上述事实与 worker 清零时间均纳入 data-result 签名和 crypto proof 的 terminal digest；缺失或时间顺序错误会拒绝签名。publisher 尚未执行，因此这些观察不代替 publisher 会话终态或最终 destruction receipt。

限定验证：`ac993d` worker 5 项与定向 lint 通过；`00a5f2` 原生加密测试最初被公开字段扫描拒绝，原因是清理状态字段含 credential/password 字样。改用不含秘密语义的状态投影字段，没有放宽扫描规则，`12dccc` 两项原生加密/签名测试通过。`91998f` 最终 Python 3.6.8 相关 21 项通过；主/恢复卷关闭、临时容器和 mapper 不存在、源 reader NOLOGIN/密码 NULL/会话 0、PostgreSQL healthy、swap/core 已恢复。测试替身不作为实际 producer 证据。

安装回读 `741495` / `735852` / `c2b59a`：worker 为 `sha256:128ace637be59ff23e221f9824a732c5d7952dd2a7ba4adb494d25e54cfc53fc`（402 文件，1,435,146 字节），control 为 `sha256:f76107d6b9d26b8e83576916091238456b770766aa08c19cec2e4a79ff46b34b`（2,422 文件，11,881,184 字节），adapter 为 `sha256:43177a1c5c886ab7eb45e5555a9b47e981efd283c89358901c87180e1d9c2bfd`。全文件摘要、只读属主及非法入口拒绝通过；`de245b` 直接调用已安装 producer 的 bundle verifier 通过。

`43f481` 定向格式、diff 和合同检查通过，合同仍为 316 文件、92 schemas、13 commands、128 migrations，摘要 `sha256:d40263572cdf7cf9a960d3a2e3cabbdb5df381b77e1f266de7058d0e92a39418`。预检 `fdf458` Prisma validate 通过；`27e323` 实际 Staging 仍仅上述两项迁移待执行，专用隧道已关闭。未触发真实 producer/STS/OSS/RAM/JIT/迁移/工作流。下一步采集 publisher 进程退出、固定凭据文件移除及会话确定失效，再经独立归档路径形成既有 destruction/completion 证据。

## 独立 publisher 终态观察入口

现有 H1 attempt 入口增加独立 `publish` 操作，只接受准确的 attempt/run，authority 在上传前与受保护授权核对二者。返回公开的 writer 身份、签发/到期时间及实际五份上传回执，父进程不读取凭据值。该操作不是 data-result 的一部分，也不修改已签名的发布标志。

根进程持有跨 attempt 的 flock 和保留的单次尝试锁；先记录固定凭据文件身份，再调用固定发布子进程。子进程成功退出后，只有原文件身份、root/0600/nlink 仍符合时才删除并 fsync。实际经过完整会话 TTL 的单调计时且系统时间已到期，再复核凭据路径为空，才原子写入 `publisher-terminal.json`。TTL 上限 900 秒，每次等待不超过 5 秒，超出有界等待仍为 UNKNOWN。失败写 `publisher-failure.json` 并保留尝试锁，不能自动重试未知 PUT。后续装配必须拒绝失败记录或冲突记录，不能仅凭文件名判定成功。

本地 terminal 是独立根进程观察，尚未生成完整销毁回执、publisher use proof、外部归档或 producer completion。真实发布时仍须将这些观察与签名 data/publication 原件绑定，并在实际 GitHub 终态后重新取得 OSS 回读；不能用本轮 probe 代替真实记录。

验证：`82ea12` 先复现缺少 attempt/run 的 publish 仍进入保护配置读取；修正后 `994de1` 两项 authority 检查和定向 lint 通过。Sol high 完成有限 Python 控制器，根审查修正原文件身份、全局互斥、到期后再次确认文件不存在、完整写入及无毫秒 STS 时间兼容。`a0498f` H1 Python 3.6.8 的 26 项相关测试通过；`8f5c44` / 最终 `8f7116` 在隔离 `/run` 目录验证实际 flock、替换文件拒绝、凭据路径重新出现时拒绝、0600/root 原子记录、create-only 及超时子进程 kill/wait 回收，probe 已移除。主密钥卷、实际凭据、数据库和云对象均未用于该 probe。

`163859` / `3a3bca` 安装回读：control `sha256:ebf288b67553a9548a41c4cf314ff012599d27658b1c483ac173f78834cb0980`（2,422 文件、11,882,021 字节），adapter `sha256:39bb8bd16ed4430e4df432732cb801ed5a9172b746956084613e73ae1704fb56`；worker 保持上一段版本。全部文件摘要、root 只读属主和非法 private 请求拒绝通过，主/恢复卷关闭、无运行中的 attempt。最终合同摘要 `sha256:b9c8db85267ff3c92fbd42d22d0227bcf08ca37ee2ee4cefdcbfefcbd631aa5f`，数量和迁移摘要不变。阶段 1 仍未收口，无新增 RAM 授权或真实上传。

## 销毁签名与精确对象归档传输

新增独立 `seal-destruction` 操作：从固定 root 路径重新校验已签 data、crypto proof、publication 和实际 publisher terminal，绑定五份上传结果、进程退出、凭据文件移除及会话到期。只有顺序、摘要、大小与身份全部一致才签署现有 `snapshot-destruction-receipt.v1` 的完整封套。失败记录、临时记录、残留 publisher 凭据或已有输出均拒绝；调用者不能传入正文或路径。Python 入口先保全签名封套，再保全裸回执，任一步失败保持可见且不重新上传。该入口尚未签署真实 producer 的销毁证明。

新增归档 writer/reader 传输，仅接受已冻结的精确对象和独立角色。writer 对每个原件只发起一次禁止覆盖的 PUT；reader 保留实际 SDK 回应，核验对象及 bucket 私有 ACL、版本关闭、WORM 210 天、AES256、HEAD/GET 长度和内容。两种既有 H1 签名封套按内层 proofType 归档，但摘要覆盖整个原件；传输层不代替上游签名验证。读者合同增加实际核验所需的 `GetObjectAcl`、`GetBucketVersioning`，尚未应用这些云权限。每次请求均检查 STS 和授权期限；PUT 回应越界记为结果未知，不重试。

限定验证：`c70a18`、`fa8f60` 先确认缺失的 JS/Python 销毁入口；`9aa1c1` 两项 H1 原生 fixture 加密/签名检查通过，包含销毁绑定和篡改拒绝。首次 fixture 打包缺少依赖的失败 `03f84d` 已修复。`d0db4b` H1 Python 3.6.8 的 27 项相关检查通过；`c38cc8` 归档、时限和 authority 的 32 项检查通过，`e1ad90` 定向 lint/diff 通过。云响应与 publisher 终态为测试替身，不能作为真实发布原件。Luna 完成销毁路径限定审查，未发现阻断问题；未重复数据库或卷生命周期测试。

实际安装：`bf22c7` worker 为 `sha256:4f2ced908d88ea64a59e14baa259f9c5b811c616bef55227a1f1529fe1594848`（402 文件，1,435,221 字节）；`3ad6bb` control 为 `sha256:2f4507311e80f9eb7887a5d6b25b28f9e28f4f25bf22692e8175923f0c470b47`（2,425 文件，11,933,592 字节）；`1dc155` adapter 为 `sha256:4414a3c887f8db1a433e7e2222b8928bfd82d6c91157833b53896226c745327b`。全部文件、root 只读属性、SDK/入口加载及非法输入拒绝均回读通过，`2b0766` 已安装 producer 的 bundle verifier 通过。`630833` 最终合同摘要为 `sha256:cc26cd893eae056cc1b84792ff4ce5624dddb6abba95d8b674b2a0938976b466`，317 文件、92 schemas、13 commands、128 migrations。

预检 `648a4f` Prisma validate 通过，`0631a4` 实际 Staging 仍仅前述两项迁移待执行，隧道已关闭。本段未新增 RAM/AccessKey、解锁主密钥卷、真实 STS/OSS 调用、JIT、源数据导出、迁移或工作流。仍需 publisher-use 证明、固定归档作业及独立终态/保管装配，再固定候选并执行真实 R2/R3、迁移和 R4；阶段 1 未完成。
