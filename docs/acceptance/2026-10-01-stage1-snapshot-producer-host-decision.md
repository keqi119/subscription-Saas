# 阶段 1 快照制作主机选择

日期：2026-10-01。状态：待负责人选择，尚未变更制作拓扑或系统加密设置。

本项只解决真实快照制作的运行位置，不增加业务功能、商用 KMS、常驻服务或新测试矩阵。数据库连接已从服务器配置核实，CLI OAuth 自动刷新也已验证恢复。

## 当前实测与适用要求

- Windows 读回 `d64a3b` / `9f1277`：C、D 均为 `FullyDecrypted / ProtectionStatus Off / EncryptionMethod None / 0%`。C 盘页面文件为 25,600 MiB，小型崩溃转储开启；`powercfg /a` 显示休眠可用。不能宣称宿主已满足设备加密要求。
- C 盘剩余 117.2 GiB，D 盘剩余 263.4 GiB，均 NTFS/Healthy。TPM 存在、Ready/Enabled/Activated 均为 true（`7a1c77`）；这不等于已启用 BitLocker。
- 当前只有开发 Ubuntu 与 Docker Desktop WSL，`.wslconfig` 仅设置 `autoProxy=false`，没有专用制作 distro。不得把现有合成数据探针当作真实主机准入。
- H1 `139.196.227.195` 只读 `277288`：RAM 共 1,870 MiB、可用 1,208 MiB；swap 4,096 MiB、已用 387 MiB；磁盘剩余 9.2 GiB。只有 Staging PostgreSQL 容器运行，既有主卷和恢复卷当前均未挂载。未执行 swapoff、卷解锁、Runner 安装或真实导出。
- 已批准[安全附录](../superpowers/specs/2026-09-03-stage1-s1-execution-infrastructure-security-addendum.zh-CN.md)规定：“若宿主磁盘、pagefile、swap、休眠或 crash dump 可能保存未加密页面且没有已验证的设备加密，停止方案 A。”因此不能直接在当前 Windows/WSL 条件下制作真实快照。

## 选择 A：在现有 H1 上只运行精确路由的一次性制作 job（建议）

只把原专用 WSL 制作数据平面改为 H1 的专用低权限执行身份。保留独立 producer run 的 `snapshot-admission`、`snapshot-data`、`snapshot-custody` 三 job，admission/custody 仍在 GitHub-hosted Ubuntu，H1 只承接 `snapshot-data`。构建、source/final 测试仍使用既有 GitHub-hosted 目标。

具体边界：

1. H1 使用专用 `stage1snapshot` 用户，无 sudo、Docker group、交互 SSH、源库写权限，以及现有 RSA 私钥/签名密钥的读取权限。现有 root SSH 只用于获准安装、独立核验和清理，不进入 Runner。
2. 只在固定 workflow 摘要、人工 Environment 批准、当前 run/job/attempt/SHA、五项精确标签与唯一排队路由均通过已有核验后注册一次 JIT/ephemeral Runner；只接一个 job，禁止常驻 service、复用或接收通用任务。
3. 数据 job 只调用固定、root-owned、摘要锁定的入口，不 checkout 仓库、不安装依赖、不执行任意 `uses` action 或 Shell/SQL 参数。入口的独立签名/当前撤销读取不能由 job 自报替代。
4. raw dump、临时 PostgreSQL、WAL、明文脱敏结果和制作凭据仅进入新的 attempt 专属 1 GiB LUKS2 卷；不复用现有签名密钥主卷/恢复卷作为原始数据临时区。加密子进程只有已核验公钥，使用既有非商用 RSA/AES-GCM 实现。
5. 制作前实际停用 H1 swap、禁止 core dump 并检查剩余内存/磁盘与源库大小；配置有界进程、数据库容器和超时。停用 swap 后容量不足即拒绝，不扩大资源或让原始数据回落普通磁盘。本次静态容量观察不保证运行时准入成功。
6. 独立控制进程确认 crypto 实际退出后，才取得获准的精确 OSS slots 发布身份；独立 reader 验证对象、内容和保留属性。完成/失败都须回读源会话关闭、目标/进程终止、卷卸载与 keyslot 失效、Runner 不再可路由；保留真实失败/UNKNOWN。
7. 为此只前向修订制作主机边界及固定安装/运行接线；复用现有 Actions 准入标签、v2 加密、completion/terminal、custody、R3 消费和同候选约束，不将 H1 密钥备份证明冒充制作/销毁证明，不重写历史原件。

代价：短期制作负载与 Staging PostgreSQL 共享这台小规格服务器，因而容量拒绝和进程隔离必须真实生效。此选择不会证明任务已经完成，也不会绕过后续具体 RAM 权限确认。

## 选择 B：保持原 WSL 方案，先完成本机 C 盘设备加密

只要求承载 OS 页面文件、休眠/崩溃转储及专用 WSL 的 C 盘启用 BitLocker；新专用 distro/VHDX/attempt 卷全部置于 C 盘，D 盘只保留代码，不承载 raw/明文数据、密钥或 swap。因此无需为本任务默认加密 D 盘。

由负责人安全保存 BitLocker 恢复材料，不在聊天中发送密钥。完成系统盘加密、保护状态确认与必要的重启后，再建立专用 WSL，禁用 interop/自动 Windows 挂载，设置 WSL swap=0，并使用 attempt 专属 LUKS 卷。修改 `.wslconfig` 生效需要一次 WSL 停止/重启窗口，会影响当前 Ubuntu 和 Docker Desktop，应按负责人安排执行。

代价：涉及本机系统级配置、恢复材料保管及重启窗口；保留原主机方案，后续仍须完成固定制作入口、唯一 JIT 路由和真实销毁证明。

## 当前停止与继续范围

负责人选择前不启用本机磁盘加密、不在 H1 注册 Runner、不导出真实数据。已经批准且与主机位置无关的 OSS 精确对象保管、输入验证和发布材料对齐可继续。两项 Staging 待迁移及最终 R2/R3/R4 仍为未完成，不因本文件改为通过。
