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

## 未完成

源角色、临时 PostgreSQL、固定 worker 的正式接线和有限验证尚在进行。真实 root 准入/撤销/JIT 调度、publisher/reader、三个 jobs、同候选构建和真实制作仍未完成；两项 Staging 迁移与 R2/R3/R4 保持待完成。
