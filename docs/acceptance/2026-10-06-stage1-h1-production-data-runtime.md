# 阶段 1 H1 制作工序接线

本记录延续已批准 H1 选择 A。只补临时卷与数据制作的固定宿主操作，不能替代签名准入、真实 GitHub job、OSS 保管或最终验收。

## 临时加密卷

`scripts/release/snapshot-h1-volume.py` 只由受信 root 父进程调用，参数只有本次 UUIDv4；没有外部 CLI 或可选磁盘路径。`prepare()` 返回固定 attempt 挂载点，`assert_ready()` 回读实际保护和映射，所有消费者结束后调用 `cleanup()`。

- 固定 1 GiB LUKS2，独立内存随机 key，经 stdin 交给 cryptsetup；沿用 H1 已实测的 PBKDF2 参数。原签名主备卷不参与制作。
- root 固定锁排斥并发；遇到旧 attempt 残留拒绝接管。`.attempt.lock` 为持久空锁文件，保留以免 unlink 导致并发锁分裂。
- 停 swap、关闭 core 并核查内存/磁盘后才创建 key。源数据容量另由制作工序检查。
- 销毁核对本次 backing inode、实际 mapper/loop/mount；不强制或延迟卸载。卸载、关闭、清空 keyslot、旧 key 拒绝、loop 消失、目录和 backing 删除均须实际成立。
- 销毁未确认时保留保护及锁；不恢复 swap，不将失败写成终态成功。销毁确认后清空内存 key，再恢复本进程保存的 swap/core 状态。

验证：

- `ab7685`：新增模块缺失，6 项失败；`80abf9` 初次通过。
- `61d801`：目录删除失败时过早释放 backing 所有权的边界测试失败；改为先移除空挂载目录，再删除 backing。`923187` 最终 7 项通过。
- `e8db0f`：实际 H1 新模块生命周期通过，含并发尝试拒绝、挂载保护回读、真正 keyslot 清空/旧 key 拒绝、全部本次资源删除及设置恢复；源 PostgreSQL 健康。没有读取业务数据、注册 Runner 或生成制作成功原件。
- `3c1e36`：独立 SSH 回读仅剩 `.attempt.lock`、无 attempt mapper、两项 swap 和 core 已恢复、源库健康。首次只读命令 `ca02cd` 因本机 PowerShell 引号错误未执行检查，修正后才计通过。
- H1 安装文件 SHA-256：`7f11158b719bceedb8d84029548911e93d583e0511d071dc608df024dc0606fb`。

## 源库身份裁定

`source-gate-evidence.v1` 绑定测试链，不含数据库物理指纹。不得把该证据摘要解释为 OID/system identifier。固定制作入口另外核对已经独立从获准 Staging 容器读取的数据库名 `subscription_saas_staging`、OID `16384` 和 system identifier `7661173341297905697`；源库被替换时拒绝。此项不修改现有授权 schema 或把历史观察冒充本次准入。

## 固定数据制作操作

`scripts/release/snapshot-h1-producer.py` 实现源角色、隔离目标库与固定 worker 的私有 root 操作。调用者仍须先完成真实签名准入；构造对象本身不是授权。

- 独立回读固定 Staging 物理身份、角色、会话和容量；现有 Node 合同验证器与公钥验证在启用读取角色前执行。临时 LOGIN 带授权到期时间，口令只经私有 stdin 传递，并关闭该管理会话的语句/错误 SQL 日志。
- 目标 PostgreSQL 与 worker 共享固定源容器的网络命名空间，只使用 loopback 5432/5433。PGDATA、bootstrap 口令和 crypto 目录位于本次 LUKS 卷的独立目录，目标/worker 各限 192 MiB；worker UID 65532、只读代码、不挂 Docker socket，镜像声明的默认数据卷被受限 tmpfs 覆盖。
- worker 销毁请求到达后，先独立核对源会话及目标 backend 关闭，撤销本次读取角色，删除精确目标容器并确认不存在，再回 ACK/EOF。完成时核对进程退出、无 OOM、stdout EOF 及实际密文大小/摘要。失败清理只处理本次拥有的角色/容器，不能关闭他人预先启用的角色。
- 限时复用 Node 验证器解析的实际授权到期时间，避免 H1 Python 3.6 不支持 `datetime.fromisoformat`。源库容量或日志条件变化不会阻止对本次角色的撤销尝试。

验证：

- root 集成检查修正了非空 PGDATA、目标 psql 默认端口、SQL 日志、资源限额、未拥有角色的清理及输出 EOF 等问题；只针对现有工序，没有新增业务或云权限。
- `179129`：volume 7 项与 producer 6 项，本机 13 项通过。随后发现 Python 3.6 时间解析问题，`92e8df` 新回归失败，`1287d5` 修正后 14 项通过。
- `e75444`：H1 实际创建加密目录内的临时 PostgreSQL，目标库 5433 SQL/角色核对通过；源读取角色未启用、未读业务数据、未启动 worker。精确目标容器删除、临时卷销毁、swap/core 恢复、源库健康均通过。该次 producer 字节摘要为 `869a59cf...`，之后只修改授权到期解析接口。
- `659c24`：最终代码在 H1 Python 3.6.8 上 14 项全部通过，已安装 bundle 全文件核验通过，真实 Node 验证器拒绝无效授权。独立回读无临时容器/mapper，目录只剩锁文件；源角色 NOLOGIN、口令 NULL、会话 0，源库健康，swap/core 恢复。
- 最终 H1 producer SHA-256：`805afa8a414a5bf1f6f57f63dd2de793681a9b7ee33b9bd7d46654453eb36f39`。

## 未完成

本批没有实际启用源读取角色或调用完整 `produce()`，也没有注册 JIT、执行 workflow、上传 OSS 或生成制作成功原件。真实 root 准入/撤销/JIT 调度、publisher/独立 reader、三个 jobs、同候选构建和真实制作仍未完成；两项 Staging 迁移与 R2/R3/R4 保持待完成。固定 Docker 创建参数已实现，正式 root 组合执行仍须完成独立实际运行约束与终态证据核验，不能只凭本类返回值宣告准入或收口。

本轮预检 Prisma schema 有效；Staging 共 128 项迁移，仍待 `20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard`，未改业务代码或执行迁移。最终 `68d4ec` 范围内 lint/格式/diff 通过；`fc21ac` 合同检查通过（306 文件、92 schema、13 命令、128 迁移），repository digest 为 `sha256:f2cd0f647f042a9e44a24481718a10009851ac360ff8d3506839a8cf1d3f990e`，migration digest 未改变。
