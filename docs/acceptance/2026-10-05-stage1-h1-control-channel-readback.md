# H1 root 与 job 受限交接

2026-10-05，沿用已批准 H1 一次性制作范围，无新登录账号、Docker 组、RAM 授权或业务功能。

## 实现与边界

- `snapshot-h1-control.py` 提供 root 私有状态机和固定 job 容器操作，无面向 job 的通用命令、路径、SQL、镜像或环境变量参数。两个 Unix socket 分属管理 UID/GID 992/988 与 job 65533/65533；peer 来自内核 SO_PEERCRED，job 还须属于实际创建容器的 PID、mount、network namespace。
- 请求只有 command/admissionRef；最多 512 字节、3 秒收帧，必须收到 EOF 才处理。每个实例限制 16 次连接、最多 3 条同时连接，以容纳 run、produce 和 cleanup。制作只执行一次；prepare/run/produce 均调用 root 的当前准入核验。失败或未确认退出不能报告成功。
- 固定 job 容器只挂 Node、两个固定客户端文件和 job socket 目录，使用 UID/GID 65533、无网络、只读根文件系统、无 capabilities、no-new-privileges、128 MiB 内存且无额外 swap、32 PID 及 core=0。镜像声明的 PostgreSQL 数据目录被禁写的 64 KiB tmpfs 覆盖，不产生匿名磁盘卷。
- `snapshot-h1-container-hook.js` 仅支持 prepare/run/cleanup，丢弃 workflow 脚本、环境和挂载指令；按 root 返回的 runnerRoot 限定 responseFile。`snapshot-h1-job-client.mjs` 仅以 opaque 引用请求 produce。所有网络式通道均为本机固定 Unix socket，不连接任意服务。客户端失败只输出固定代码。
- root 模块仍须由正式编排器绑定既有签名准入、当前撤销、GitHub 独立观测及真实 worker/清理回调；本记录不把合成回调视为生产核验，也不签发制作成功原件。

## 验证结果

`bf79ad` 在 H1 实际通过 hook → root → 固定 job → root 的 prepare/run/cleanup 整链：

- 真正运行 UID 992 hook 和 UID 65533 job；host root 直接发同样管理请求也被 peer 检查拒绝。
- 实际 root 准入回调调用 3 次，合成制作回调仅 1 次；job 容器的独立 namespaces、挂载、资源限制均实际检查。
- 容器内进程无法读取合成 Runner 凭据、管理 socket、Docker socket、另一 UID 进程的宿主 `/proc` 路径或主密钥配置路径；没有挂载、读取真实凭据内容。
- job 容器、控制 socket、合成目录和进程均已清理。此次没有数据库连接、快照导出、密钥解锁或 OSS 写入。

独立 SSH `6e51c2` 确认：上述资源无残留，Staging PostgreSQL 为 running/healthy，主备密钥卷关闭，attempt 根目录为空；UID 992 hook 在 stdin 保持打开时实际于 5.081 秒退出 1，输出固定错误码。Windows 相关用例只覆盖早期身份拒绝，Linux 此次实测补齐了真正的 stdin 超时路径。

H1 安装于 `/opt/subscription-saas/snapshot-adapter/v2/control`，文件均 root 所有、0555：

| 文件                          | SHA-256                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| snapshot-h1-control.py        | faf4d0a740cc3fcbd8e47e6694c6982435470bfe69c6052ec04244ff187574be |
| snapshot-h1-container-hook.js | c4062cc65928cefdddf348c4fec048ea1656f489048e485a4663319febf6faae |
| snapshot-h1-job-client.mjs    | 30420902eb7687f02cd4ac91f0114b297ebde8567eeddac13a1ae18049b73c1d |

定向验证为 Python 5 项与 Node 7 项；客户端 ESLint 通过，合同检查为 289 文件、91 schema、13 命令、128 项迁移。未运行全量业务测试矩阵。预检 `72f46c` 为真实 Staging PostgreSQL 17.10，只有 `20260925090000_stage1_operational_completion_terminal_shape` 和 `20260925091000_stage1_operational_completion_settlement_guard` 待迁移；`b9142e` schema 校验通过，未执行迁移。

## 保留的失败与修正

1. 有限静态审查发现创建失败后可能按名称认领其他同名容器；`099c26` 复现误删，修正为必须持有本次 create 返回的 ID，无法确认时保留失败状态。`4406df` 五项测试通过。审查 agent 随后遭遇模型容量错误，不将该次输出称为完整审查通过。
2. 首次 H1 `f047e5` 拒绝运行；`adc39a` 确认固定 PostgreSQL 工具镜像自动挂载了匿名数据卷。增加显式 tmpfs 覆盖和清理时的匿名卷移除；`d01666` 根据原容器事件核对唯一遗留卷为空且无人使用后删除，随后 `bf79ad` 整链通过。
3. 本轮 Python 缓存删除命令被自动审批审查拦截，未返回具体原因；保留缓存并加入常规忽略规则，没有改用其他删除通道。

下一步只接真实准入/JIT 与本次 attempt 的制作、清理工序，再替换旧 workflow。尚未注册 Runner、触发真实制作或完成 R2/R3、两项迁移、R4；阶段 1 继续保持未完成。
