# H1 固定一次性执行入口与运行中 job 绑定

本轮接续已批准 H1 一次性制作方案。固定 root 入口、实际运行中 job 读取和容器约束核验已实现并安装；**尚未执行真实 JIT 注册或源库快照制作，阶段 1 未收口**。

## 实现边界

- `snapshot-h1-attempt.py` 只接收公开的 `selection`、`approvalSelection`。调用者不能指定命令、路径、凭据或回调。安装配置把该入口自身、六个 Python 模块、三个 JS 入口、控制包和 Runner distribution 摘要共同绑定为 `adapterDigest`。
- 私有 Node authority 使用既有主密钥卷内的固定文件读取、签名与实际 dispatch/custody/revocation verifier。新增 `producer-inputs.json` 仅含有效 v2 制作授权和既有 RSA 公钥，必须由真实发布前提生成；本轮没有填入合成生产配置。
- 第一次准入后准备新卷、容器和控制 socket；准备完成后重新读取实际排队状态、Environment 审批及撤销状态，要求 admission 和 production 内容未变。持久消费 route nonce 后才允许 JIT 注册；后来每个敏感入口重新检查 dispatch，并读取真实运行中 job 和本次实际分配的 Runner。
- 运行中读取不把 `in_progress` 改写为 `queued`：同时核对当前 run attempt、SHA、仓库、发起人、job ID、Runner ID/name/group、五个精确标签，以及 Runner 的 online/busy 状态。该方法的成功生产观测仍待真实 job。
- 数据面凭据交付前，root 根据实际 Docker inspect 核对目标库/worker 的挂载、只读根目录、capabilities、no-new-privileges、内存/swap/pids/core 限制、日志、入口及环境。环境变量允许 Docker 重排，但拒绝额外值和重复名称。清理单独使用容器所有权检查，避免配置漂移阻止删除本次容器。
- 成功制作后仅将校验过的 `snapshot.enc` 复制到固定 root-only 输出目录。Runner、socket/job、源角色/会话、worker/目标容器、GitHub 路由和令牌必须全部确认清理后，才能销毁本次临时加密卷。任一消费者或路由状态不明时保留卷与保护，不出具成功结果。
- `DATA_PREPARED` 只表示固定数据操作和清理完成；它不表示 OSS 发布、custody 或阶段 1 完成。主密钥卷的打开/关闭及外层 swap/core 保护仍由已批准的受控父流程持有。

## 安装与实际回读

H1：`139.196.227.195`；固定目录 `/opt/subscription-saas/snapshot-adapter/v2`。

| 项目 | 实际摘要 |
| --- | --- |
| adapter 安装配置 | `sha256:51a5f8068444fc35bacfdd15ae4a2f51a7035747d9da5b8af1f2d81d2063fa0f` |
| 控制运行包 | `sha256:d9d53a0b1e595491639a7980aa416f4a1bf7628cfe10580dd116a9d8379d8fba` |
| attempt 入口 | `936e272e5ad804e9abf408821f7438b2506b8d6515c8a9bf238f3f8fd134e709` |
| GitHub transport | `bf6073edfb39d7b3e2621c5b3fae832e4d4d6360cb505378826a8959d08f183b` |
| producer | `0382d13b198ecc5f0d9485b9890cbd1122307c8d2394598ebbc6c2a5843bf663` |

`9dab5e` 安装控制包：2,335 文件、11,456,877 字节，逐文件摘要及 root 只读权限通过，实际 Node/SDK 加载和非法入口拒绝通过。`23633c` 安装固定 Python 控制入口及配置，实际重新校验完整闭包，并通过私有 pipe 拒绝非法 JWT 请求；没有发出 GitHub 请求或打开密钥卷。沿用已安装 worker `239b95e7…`，没有重装或冒称其与当前 checkout 的重建包相同。

`efa298` 针对新增 Docker 约束做一次原生核验：在新加密卷中启动独立目标 PostgreSQL，真实创建但不启动 worker，两者 inspect 校验通过。没有启用源只读角色、读取业务行、运行 producer 或生成快照。目标库与未启动 worker 清理完成；临时卷 keyslot 清空、旧 key 被拒绝、卷销毁，swap/core 恢复。

`39a056` 独立 SSH 回读确认：临时容器和 mapper 无残留，临时卷目录仅有既有锁文件，主备密钥卷均关闭；源只读角色 `NOLOGIN`、密码为空、零会话，Staging PostgreSQL 健康。

## 验证与保留的失败

- 本轮预检 `a12f22` Prisma schema 有效；`4f216b` 实际 Staging 128 项迁移中仍有已知两项 pending：`20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard`，隧道已关闭。本轮仅改发布基础设施，没有业务代码或迁移执行。
- 本地 `d5a7db`：attempt/job-binding/producer 共 18 项 Python 测试，authority/signing 共 4 项 Node 测试通过。`39a056` H1 Python 3.6.8 上相同 18 项通过；这是兼容性核验，不额外扩大用例矩阵。
- `26c21e` 先确认缺少晚期准入导致回归失败，再实现顺序约束；`fb76e8` 确认按环境数组顺序比较会错误拒绝 Docker 的合法重排，修正为精确名称/值匹配并拒绝重复。失败记录保留。
- `13cbba` 相关 JS lint 与格式检查通过；代码合同目录增加两个实际生产入口，未增加业务 schema 或迁移。

## 剩余收口顺序

1. 将现有 publisher/独立 reader、真实销毁和不可路由事实接到固定入口，完成 admission/data/custody 三个 job。当前旧 `sanitized-snapshot.yml` 仍不可触发。
2. 固定最终候选并取得真实 protected build/source-fresh 证据。随后生成实际 dispatch/current-revocation 两份原件，按用户要求提交精确 OSS 对象 RAM 差额；已有身份初始化授权不扩展为对象授权。
3. 装配固定生产授权和短期 reader session，执行真实加密制作及同候选 R2/R3，再对齐两项已批准迁移并完成 R4 真实验收。维持无商用 KMS、无业务扩张、无通用 I0 平台和无重复全量测试的范围。
