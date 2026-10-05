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

## 必须继续完成

1. 补齐真实 workflow terminal、publisher 会话销毁及完整 destruction/completion 证据的既有收口路径；只使用实际观察，不新增通用平台。
2. 固定同候选 build/source-fresh，生成 dispatch/current-revocation 原件及独立 custody。dispatch 不含 producer run ID，可先生成；实际 run/job 出现后再绑定 producer crypto authorization。
3. 准备专用 publisher 和 hosted custody reader 的精确对象授权、保护环境及配置。新角色尚未创建或获批；新 RAM 差额仍交用户确认。已批准并完成的 archive 身份初始化不重复。
4. 将实际 RAM 策略回读摘要写入受保护配置，配置 H1 authority/producer inputs，再执行首次真实 producer、同候选 R2/R3、两项 Staging 迁移及 R4。

预检 `650e5c` Prisma validate 通过；`cc34d6` 实际 Staging 128 项迁移仍只有 `20260925090000_stage1_operational_completion_terminal_shape` 和 `20260925091000_stage1_operational_completion_settlement_guard` 待执行，专用隧道已关闭。本轮未新增 RAM/AccessKey、解锁主密钥卷、上传 OSS 对象或触发 GitHub 工作流。
