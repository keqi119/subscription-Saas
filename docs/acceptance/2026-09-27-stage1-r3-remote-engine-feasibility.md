# R3 原生远端 Docker 通路的有限可行性核查

日期：2026-09-27。性质：只读源码与上游文档核查；未建立隧道、修改主机配置、运行远端容器或采纳新的授权契约。

## 13:49 UTC 接续：H1 原生通道配置与有限实测

下文保留早期只读核查。后续实际核实 H1 为 OpenSSH 8.0p1、Docker CLI/Engine 26.1.3，选择固定 **remote TCP → hosted Docker Unix socket**。原 reverse Unix listener 方案不采纳：8.0p1 的 streamlocal listener 没有路径 ACL，单独设置目标目录权限不能约束 `/tmp` 等可写路径；session chroot 也不能替代该限制。原生 `-R 127.0.0.1:55440:/var/run/docker.sock` 已由维护实测验证，无新增 relay、密钥服务或 diagnostic workflow。[OpenSSH 8.0p1 channels.c](https://raw.githubusercontent.com/openssh/openssh-portable/V_8_0_P1/channels.c)、[ssh.1](https://raw.githubusercontent.com/openssh/openssh-portable/V_8_0_P1/ssh.1)。

指定主机新增专用 `stage1-r3-forward`，实际 UID 994 / GID 990，只有其自身组。有效 SSH 配置逐项核对为 publickey-only、仅 remote TCP、只允许 `127.0.0.1:55440` 和 `127.0.0.1:55441`，禁用 streamlocal、local forward、shell/subsystem、agent/X11/TTY/tunnel/user rc；root-owned `/etc/ssh/stage1-r3-forward/authorized_keys` 当前为空。OUTPUT 首条精确拒绝非 UID 0 连接两个端口，INPUT 首条拒绝非回环接口向这两个回环端口送入流量。此边界信任 H1 root，不宣称只允许一个 root 进程；`PermitListen` 也不证明客户端 backend 正确，实际 hosted 来源及 Engine 身份仍须核验。

配置接续实际 exit 0，`13:48:32.408772Z` 完成 reload，没有 restart；修改前后 root 与无关账号的完整有效 SSH 配置相同。原 `/etc/ssh/sshd_config` SHA256 为 `2bdfeeeb3975231e03a8d146690899ccb90efb95ade5cdee333a5c12dec2be9d`，修改后为 `01b68980e6a0d04caeac6bec361b172e5f195beb087edc3bf4b3fb8078d12730`。首次候选语法检查真实 exit 1：该版本不允许在 Match 内设置 `ChallengeResponseAuthentication`；当时尚未创建账号、安装规则或修改正式配置。失败源/候选/备份保留，接续只删除该不支持的 Match 行，继续核验既有全局值为 no 及本账号 publickey-only。

一次维护实测于 `13:48:54.833397Z` 实际 exit 0：只在 `/run` tmpfs 生成临时 SSH 维护密钥，经同机反向转发读取现有 Docker Engine ID，与直接读取一致；非 root 连接被拒绝，额外端口和会话请求均被拒绝。未启动/停止容器、访问业务数据库、读取发布/RSA 私钥或进行快照恢复。临时 key、授权与连接已移除；另一条独立 SSH 于 `13:49:41.877985Z` 确认 keys 为空、维护目录和监听不存在、转发 UID 无进程、两条精确防火墙规则仍居首位，root 重连成功。

原件位于本候选 R3 hidden workspace：`h1-r3-forward-configure-result-20260927-{01,02}.json`、`h1-r3-forward-smoke-result-20260927-01.json`、`h1-r3-forward-independent-readback-20260927-01.json`；接续配置脚本 SHA256 `d80cc0189e19020618ae34ecd9ef1086af49d4fcab2434f60cad8bf8f2903df7`，smoke 脚本 `c0210a839776f7335cec988ef12611ce3487ad84757247c7f61ecfdb6b2d4a59`。这些 create-only 运维脚本已经执行，不能重新运行初始化。

**本次只关闭 H1 原生转发可用性。** 防火墙规则尚不跨重启持久化，每次真实消费前仍须独立验证其存在和顺序。真实 hosted job、加密 Engine、双端 PG、同 job attestation、scope/session/RSA 释放及 R3 双链仍未完成，当前没有长期转发连接或已获准的 hosted key。后续仅复用现有 source/final job；hosted 加密方向固定 classic overlay2，拒绝 containerd image store 或任何落在加密边界外的持久载荷。Docker `data-root` 本身不能证明 containerd 存储也已迁移，须实际读回 driver、RootDir 和 backing mount。[Docker daemon 存储配置](https://docs.docker.com/engine/daemon/)。

## 2026-09-27 23:00 UTC：同 socket 路径交接实测

维护验证自然退出 0（tool `9c65a7`），同一 SSH PID 2303107 和 H1 55440 监听，先连接 `/run/s1r3-handoff-b2or_du5/engine.sock` 的临时 HTTP listener，收到 204 后关闭并按 inode 核对移除 socket；独立空 dockerd PID 2303127 使用同一路径建立新 listener。直接 Unix 与 H1 TCP 的 Engine ID 均为 `69a59aea-54ef-4181-808e-cf8d6cdb05e6`，与原 Engine `93a80aa5-983c-4272-b315-c4b99bb3e696` 不同。临时 daemon 使用私有 `/run` tmpfs、vfs、独立 data-root/exec-root/pidfile/config，禁用 bridge/iptables/IP forwarding；没有拉镜像或创建容器，实际 Images=0、Containers=0。

daemon 和 SSH 均正常退出 0。随后独立 SSH 读回（tool `2aaca5`，23:01:18 UTC）确认临时进程、forward UID 进程、两个固定端口监听、临时 key 文件和 socket 均不存在，authorized_keys 为空；原 Engine 的 ID、17 个容器及 19 个镜像计数在维护前后相同。空 daemon 诊断保留在上述私有临时目录，没有递归删除或触碰原 Docker 数据目录。

这证明该版本 OpenSSH 可在同一反向连接下将新通道连接到同路径的新 Unix listener，不证明真实 hosted provenance、加密创建、PG 映射或候选验收。没有新增第三端口、常驻服务或业务载荷。只读预检首次因服务器 Python 3.6 不支持 `subprocess.run(text=...)` 失败（tool `71b473`）；修正调用参数后预检退出 0（tool `c45ff0`），未修改主机配置。

原件位于既有 hidden workspace：`r3-native-handoff-probe01.log`、`r3-native-handoff-independent-readback01.json`；维护脚本 `r3-native-handoff-probe-20260928.py` 的 SHA-256 为 `599e9bdf035b17b9c8da8bcc7f704959a4966417ca20b38884e5f666b7555321`。该脚本是一次维护实测，不能作为创建/消费入口重复执行。

## 原始只读核查

结论：可以优先细化“原 H1 父进程控制远端 Engine”的较小方案，避免仅因容器位于 hosted VM 就新增 manual delegation 签名与另一套帧协议。现代码尚不支持该方案；R3 的主机执行停止点仍未闭合。

## 可以保留的边界

H1 loader 核验运行父进程的实际 machine-id、UID 及本地私钥保管位置。父进程仍在已批准 H1，保留 owner 确认、签发、消费、撤销、锁、档案与备份；hosted VM 不取得签名私钥或代签权。

现 Runner launcher 记录本地 `docker run` 的真实 PID、argv、pipes、CID 和 Engine inspect。它不向 Runner 挂载本地 bind 文件，shared assessor 也未要求 Engine 与父进程处于同一主机。因此，经独立批准并核验的原生 Docker 通道有机会保留 MS2 和原父子授权机制；不能据此向调用者开放 `DOCKER_HOST` 或任意 `--host`。

Docker 官方支持远端 Engine。当前服务器 Docker CLI 26.1.3 的 `createContainer` 在客户端创建 CID 文件并写入 Engine 返回的容器 ID，`runContainer` 通过 Engine API attach/start/wait；这些实现支持上述位置划分，但不证明本项目已完成接线。[Docker 远端访问](https://docs.docker.com/engine/security/protect-access/)、[26.1.3 create.go](https://github.com/docker/cli/blob/v26.1.3/cli/command/container/create.go)、[26.1.3 run.go](https://github.com/docker/cli/blob/v26.1.3/cli/command/container/run.go)。

## 仍须闭合的最小准入

1. **固定通道及 hosted 来源。** 每次实际 run/job/VM、短期连接身份、owner 独占路径、实际 Engine、candidate、operation 与独立 target 必须可核对并防替换。launch 与 H3 observation 当前各自固定本地 Docker socket，必须统一受同一可信准入约束，不能只替换其中一个环境变量。H1 身份不自动证明 hosted VM 来源。
2. **两端 PG 映射。** 父 observer 已使用 profile 回环 endpoint，Runner 已使用 Docker network 内的 PG `serverAddress/serverPort`。当前 H3 将 Docker 发布端口直接等同父 endpoint；远端方案必须证明 H1 回环、hosted 回环 publication 与同一 PG 容器之间的精确映射。physical fingerprint 继续使用真实 PG 容器地址和服务端口，不改成隧道端口。
3. **新目标与加密边界。** 现 R2 仅准入 synthetic-fresh，H3 还要求普通 local volume、空 options。R3 fresh/snapshot 的独立 profile/target/H3 及受控加密挂载仍须单独完成，不能继承 R2 许可；两条 final 链仍在不同 hosted VM 上运行。
4. **失联行为。** 本地 SSH 或 Docker CLI 退出不能证明远端容器停止。必须从同一已准入 Engine 对同一 CID 独立 inspect；无法取得事实时保持 UNKNOWN，禁止切回本地 Engine或换 operation 重试。

OpenSSH 支持 Unix socket 的远端转发，但这本身不构成项目授权。实际 server/client 版本、路径权限、连接安装与撤销仍须核验；不能假定 `PermitListen` 已限定 Unix 路径，也不能交付任意 root 反向 socket。[OpenSSH RemoteForward](https://man.openbsd.org/ssh_config#RemoteForward)。

## 不被这一方案解决的事项

lifecycle suite 的 Docker/provisioner/migration 权限及其两个内部目标、database-test successor 的 per-suite map/runtime role/真实 CID、host launcher 与 R3 bridge 接线，仍是现 Task 4 的工作。合法副本、非商用加密接缝、实际 hosted 来源和数据保护也仍独立待办。用户已明确拒绝商用 KMS，不再保留 KMS 采购或预算等待项。

本次裁决仅是缩小后续设计搜索范围：先验证原生通道是否足够，再决定确有必要的契约增量。旧 delegation/relay 草案保持未采纳；本页不宣称零 Schema 改动、不提供可直接执行的 SSH 配置，也不解除真实发布门槛。
