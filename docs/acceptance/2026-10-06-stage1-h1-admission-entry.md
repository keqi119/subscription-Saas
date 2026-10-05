# H1 固定准入入口与 dispatch 读取接线

本项继续已批准 H1 一次性制作范围。新增入口能够调用已有真实 GitHub、OSS、签名和撤销核验接口；**没有完成真实准入、JIT 注册、制作或阶段 1 收口**。

## 本次实现

- `prepare-snapshot-admission.mjs` 是 hosted admission job 的具体入口。它校验固定仓库、负责人、main、attempt 1、workflow_dispatch、候选 SHA 与 workflow 原始字节，生成未受信任的 canonical admission，独占写入 `.release-output/snapshot-admission.v1.json`，只回写 digest 和唯一路由标签。
- `snapshot-h1-admit.mjs` 是 H1 root 的固定入口，不接收路径、密钥、脚本或回调。stdin 仅接受 canonical `{selection, approvalSelection}`，分别包含现有接口定义的公开 GitHub 标识。固定 App reader 实际取得一组有时间界限的 API 原件，在本次调用中供 admission 和 post-approval 同时核验；最后执行新 nonce 的 dispatch 核验并签署 admission。stdout 仅为 `{admission, verification, postApproval}`，不含 session 或私钥。
- `snapshot-h1-dispatch.mjs` 使用实际独立 OSS reader 回读两份精确原件，核对实际版本、字节摘要、修改时间、WORM ID 与保留期限，再把原件和既有真实托管证明交给未改动的 dispatch verifier。原持久 checkpoint 和每次敏感操作重新核验的要求保留。
- `snapshot-h1-signing.mjs` 对固定目录中的原件执行 schema、Ed25519、精确内容地址及 authoritative custody 核验。fresh revocation 响应只从当前受保护文件取得状态，由本次 nonce 绑定；不接收调用者提供的状态或签名域。它不生成 dispatch 授权、初始撤销状态或 custody 原件。

## 待装配的真实输入

固定目录为 H1 已有主加密卷内 `/var/lib/stage1-volumes/main/snapshot-authority`，仅 root 可访问、文件不得跨出该卷。当前尚未写入以下生产配置，不用 fixture 初始化：

| 文件                      | 内容与约束                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `authority.json`          | `{rootPolicy, expected, trustPolicy}`；既有 H1 负责人签名身份、固定 archive writer/reader 角色和 bucket；真实 workflow、候选及托管绑定 |
| `authorization.json`      | `{body, signature, archive, receipt, observation, observationSignature}`；真实 `rc-dispatch-authorization.v1` 及其已归档证明           |
| `current-revocation.json` | 同一 packet 结构，body 为当前 `i0-revocation-state.v1`；完成真实归档及签名后以原子替换提交当前 head                                    |
| `reader-session.json`     | 原有 transport 定义的独立 reader STS session，最长 15 分钟；过期拒绝                                                                   |

fresh head 读取以检查过的 `current-revocation.json` 文件快照作为本次读取时点；生产 authority 更新必须原子替换这一完整已签名、已归档的 packet。持久 verifier checkpoint 独立拒绝回退。读取过程中发现 head 与本次捕获的原件不一致时拒绝，须重新执行。没有新增在线撤销服务或自动批准平台。

已获批准的 RAM 身份初始化不包含 OSS 对象授权。须先完成最终候选代码与 workflow，取得真实 build/source-fresh 证据，再冻结两份原件并提交精确对象权限差额。不能以主机批准、测试签名或虚构摘要替代发布授权。

## 验证与限界

- `23b2e4` / `c16cf6`：8 项入口、签名及 canonical 输出限定检查通过。增加 root selection 检查后 `afd781`：dispatch/signing 6 项通过；没有扩大为全量业务测试。
- `f0da96` 的缺失 `URL` import 已修正；`8f470f` 限定 ESLint 通过。
- `c8c7af` 暴露旧控制包 2,000 文件上限不足。`b210d6` 实测现有锁定 OSS SDK 依赖闭包为 2,332 文件、约 11.4 MB、95 包；只将控制包上限调到 4,096，单文件 4 MiB / 总量 32 MiB 上限及 worker 包保持不变，没有安装或升级依赖。
- `04b8f2`：H1 新控制包逐文件摘要、root 只读权限及原生 Node 导入核验通过，SDK/XML 依赖可加载，非法调用被拒绝。该次包为 `sha256:c638e978e28efac2ed42e1173442d3877a82e173e60d740246d17a6b4dd2f434`；后续仅校正内部签名边界注释，最终包另以下方记录为准。
- `066977`：独立 SSH 核对安装的 GitHub Python 控制代码已对齐本分支此前完成的 JIT transport；query/journal 原字节未变。主备卷关闭，attempt 目录仅保留故意持久化的 `.attempt.lock`。
- `40d74c`：最终控制包 `sha256:cd04d181ca51e27b58d9ffefcbb3b57d6de1625bc146103f57658f0fbe2a40a8`，2,332 文件 / 11,400,013 字节，原生依赖和入口拒绝检查通过。没有 GitHub 请求或生产签名操作。
- `d2e79a` 检查中控制包重建与安装记录一致，但“当前 worker 重建应等于旧安装摘要”的额外假设失败。`e6c4f4` 定位为此前已修改的 `evidence-archive-authorization.v1` schema 和新增 `i0-revocation-state.v1` schema 被打包器全量带入，与本轮 worker 运行代码无关。本轮没有重装或重新测试 worker；已安装的 `239b95e7…` 保持原样，当前 checkout 重建为 `c0b4b617…`。最终候选安装清单须明确绑定实际选定的 worker 包，不能把两者声称为同一字节版本。
- `171824`：309 个合同文件、92 个 schema、13 个命令合同、128 项迁移通过；迁移目录摘要仍为 `sha256:65ebe3208fc618ae82ad24f66b793e9bddd7464526dd45b8a0d9893d24a0ff62`。
- 限定 Luna 静态审查没有发现已证实的重要绕过或秘密输出问题。真实 RAM 权限、生产原件、session、OSS 回读和成功准入尚未验证。

Staging preflight `a033b5` / `452e80`：schema validate 通过，128 项迁移中仅 `20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard` 待执行，专用 tunnel 已关闭。本次没有业务逻辑或迁移修改。

## 继续执行的顺序

1. 接上 root 一次性编排：准入、post-approval、nonce claim、JIT、真实 job/runner 绑定、固定 producer、独立清理和不可路由证明。返回的 admission 签名不是可长期重用的执行许可；每个后续敏感边界须重新核验当前 dispatch。
2. 接上 publisher/custody，完成 `admission` / `snapshot-data` / `snapshot-custody` 三个真实 jobs。当前旧 `sanitized-snapshot.yml` 仍含明文导出及 parser 不支持的语法，**不可触发**；本次没有用占位步骤替换它。
3. 完成必要代码后取得同候选的真实 build/source-fresh 输入，落实上述有限原件、精确 RAM 权限和签名托管、生产 checkpoint，然后执行真实 producer、R2/R3、两项获准迁移及 R4。
