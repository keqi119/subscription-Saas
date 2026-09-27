# R3 原生远端 Docker 通路的有限可行性核查

日期：2026-09-27。性质：只读源码与上游文档核查；未建立隧道、修改主机配置、运行远端容器或采纳新的授权契约。

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

lifecycle suite 的 Docker/provisioner/migration 权限及其两个内部目标、database-test successor 的 per-suite map/runtime role/真实 CID、host launcher 与 R3 bridge 接线，仍是现 Task 4 的工作。合法副本、KMS 费用边界、实际 hosted 来源和数据保护也仍独立待办。

本次裁决仅是缩小后续设计搜索范围：先验证原生通道是否足够，再决定确有必要的契约增量。旧 delegation/relay 草案保持未采纳；本页不宣称零 Schema 改动、不提供可直接执行的 SSH 配置，也不解除真实发布门槛。
