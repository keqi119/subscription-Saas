# H1 一次性制作宿主准备读回

2026-10-05 用户明确批准 H1 一次性制作，选择 [2026-10-01 草案](2026-10-01-stage1-snapshot-producer-host-decision.md) A，原稿 SHA-256 为 `d0f4b6a92781de81ff5c0948565b490940900fc401363e9c467955b32d94765d`，原稿没有改写。此记录前向确认选择。H1 仅承接一次精确 JIT 数据 job，构建/全量套件仍在 hosted；未选择非 Actions 路线、商用 KMS 或本机磁盘加密。

## 已实际实施

固定主机 `139.196.227.195` 创建 `stage1snapshot`，UID 992、GID 988。账号为 system user、锁定密码、已过期、`/sbin/nologin`，无附加组、sudo、Docker socket 或交互登录配置。新 home `/var/lib/stage1snapshot` 为 root:root 0755；新 `/var/lib/subscription-saas/snapshot-volumes` 为 root:root 0700，必要父目录 root:root 0755。专用 limits 文件仅设置该账号 soft/hard core 为零。脚本为 [prepare-h1-snapshot-host.py](../../scripts/release/prepare-h1-snapshot-host.py)，只接受 `--check` / `--apply`，不接管漂移的同名资源，不向 job 授权。

应用前 `a5416c` 正确报告缺失。首次应用 `82b6a7` 只有账号过期检查失败；`d40212` 确认 H1 的 `useradd -r` 忽略 aging 参数，账号 `sp_expire=-1`。已在脚本增加显式 `chage -E 1`，并在核对本次新建账号 UID/GID/标记/shell/home 后补设（`32fcfd`）。新 SSH 会话 `fac9f7` 所有检查通过：实际低权限进程不能读源 dotenv、root SSH 目录或已有 LUKS backing，也不能连接 Docker socket；root 查询与该用户实际调用均确认无 sudo 权限。未挂载的既有密钥卷不能证明挂载后私钥隔离，后者仍须实际执行时核验。

前置 `3344a8` 使用服务器真实配置和 PostgreSQL 17.10，只读连接仍发现 128 项迁移中的两项待应用：`20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard`；隧道已关闭。`1abfd4` Prisma schema 有效。本轮没有改业务数据或迁移。

## 宿主加密生命周期

H1 实测为 cryptsetup 2.3.7、systemd 239/cgroup v1。单次探针只使用合成标记与内存随机 key，不读取业务数据、不生成 producer/completion 原件。实际停用两处 swap，core 限额为零并临时把 `kernel.core_pattern` 设为 `|/bin/false`，防止既有 systemd-coredump 管道落盘。LUKS2 使用 64 字节随机高熵 key、AES-XTS-512、固定 PBKDF2 100000 次；此选择避免小规格 H1 上 Argon2 动态内存基准，不代替 snapshot envelope 的 RSA/AES-GCM 算法。

`ab4985` 完整通过：新分配 1 GiB backing、LUKS2 创建、打开、ext4 挂载、合成标记写入及读回；挂载选项为 `rw,nosuid,nodev,noexec`。停用 swap 后可用内存 903524352 字节，挂载后 900038656 字节。此数字只支持本次宿主核验，不能提前证明真实制作负载准入。

清理实际完成卸载、mapper 关闭、keyslots 从 `[0]` 变为空、旧 key 被明确拒绝、无 loop 关联、删除本次 backing/mount。原 swap 路径和优先级、core pattern 均已恢复。独立 SSH `2256de` 确认制作根目录空、无 `subscription-s1-*` mapper，仅 Staging PostgreSQL 容器运行且健康。

保留的失败：`e16144` 因 2.3.7 不支持 `--dump-json-metadata` 而未完成，`945c66` 确认实际能力后改用固定 C locale 的 LUKS2 文本节；该失败卷经空 keyslots/无关联核验后清理（`ba10e6`）。`c39830` 的实际创建、读写、擦除均完成，但把“无可用 keyslot”的退出码误设为 2；`65733f` 确认为退出 1 及固定两行错误，再清理该卷（`fd51ad`）。只有后续 `ab4985` 计完整通过，没有把早期失败改称成功。

## 仍未完成

固定 PostgreSQL 工具镜像已按 `postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` 拉取完成（`6142a0`，退出 0）。没有用浮动 tag 替换既有工具摘要，也没有启动工具容器。一轮限定独立审查未发现该账号脚本可证明的 P1/P2；没有为此重复数据库套件。

`b2d0b0` 合同、格式及差异检查通过：283 文件、91 schemas、13 commands，128 项迁移摘要不变；仓库合同摘要 `sha256:5b4b2efa99b04b4f5e65f2fc364723957255549045c3ee490b2126ee89346184`。账号脚本已同时进入声明和发现清单；没有新增测试豁免。

这只完成宿主准备和合成生命周期核验。固定已安装 adapter、实际 root 控制与低权限数据库工具交接、精确 JIT/三 job 工作流、实际 producer、独立 publisher/custody 身份和完整原件仍需接通。尚未导出真实 Staging 快照、注册 Runner、触发旧明文工作流或执行最终 R2/R3/R4。
