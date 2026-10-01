# 阶段 1 R3 非秘密证据交付草案

状态：用户于 2026-09-30 明确“批准按草案实施”，授权包含新账号和必要 SSH 配置；尚未实现、创建账号或修改线上 SSH。范围仅为补齐已批准 R3 调用链的跨机交付，不增加业务功能、商用 KMS 或常驻应用服务。

## 现有缺口

`r3-hosted-creation-control.mjs` 的 `exportEvidence` / `exportCleanupEvidence` 只返回 hosted 本机 Buffer；`launch-manual-stage1.mjs` 的两个 import 也只接 H1 本机 Buffer。负责人 ACK 后没有通知仍存活的 hosted holder 清理的通道。现有“owner/CI artifact delivery”说明尚无实现。

`stage1-r3-forward` 只允许两个反向端口，且 `MaxSessions 0`、`ForceCommand /sbin/nologin`。55440 创建后已交给 Engine，55441 用于 PG。不得把这些端口改作通用命令接口。清理读回还要求 UID 994 的进程全部消失，因此不能让同一账号的文件传输会话一直等 CLOSED。

## 选择

采用独立的 `stage1-r3-evidence` 系统账号，通过现有 sshd 的 `internal-sftp` 交换非秘密文件。它使用同一已核验 job 的临时公钥，但与转发账号使用不同 UID、独立 root 管理的 authorized_keys 和目录。保留原转发账号、两个端口及关闭条件。

相比 OSS 轮询，此方案不需要新的云凭据、RAM 策略或对象保留配置；相比自写强制命令代理，不增加自定义网络协议、root IPC 服务或远端命令解析器。代价是新增一个仅能访问临时交换目录的 SSH 身份，需要确认这项有限权限变更。

OpenSSH 8.0 的内置 SFTP 可配合 chroot，无须在目录中安装 shell；`MaxSessions 1` 允许一个子系统会话，其他转发必须另外关闭。这是文档支持的机制，尚非 H1 实测结果。[OpenSSH 8.0 sshd_config](https://raw.githubusercontent.com/openssh/openssh-portable/V_8_0_P1/sshd_config.5)

## 可核对的配置范围

新账号无 sudo、无附加组、无可用密码，登录 shell 保持 `/sbin/nologin`。仅对该账号配置以下 Match；实施前必须用 H1 实际 sshd 做语法及有效配置核验，不能影响 root 和原转发账号：

```text
Match User stage1-r3-evidence
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthorizedKeysFile /etc/ssh/stage1-r3-evidence/authorized_keys
    AuthorizedKeysCommand none
    TrustedUserCAKeys none
    AuthorizedPrincipalsFile none
    AuthorizedPrincipalsCommand none
    ChrootDirectory /run/stage1-r3-evidence
    ForceCommand internal-sftp -d / -u 0077 -p open,close,read,write,lstat,fstat,stat,realpath,rename,posix-rename
    MaxSessions 1
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    PermitListen none
    PermitOpen none
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    PermitTunnel no
    PermitUserRC no
```

请求白名单仅用于固定文件上传、原子改名和读取；不允许创建链接、修改权限或删除目录。具体请求名依据 [OpenSSH 8.0 SFTP 实现](https://raw.githubusercontent.com/openssh/openssh-portable/V_8_0_P1/sftp-server.c)，仍需实际客户端的短验证。

交换目录使用独立、限额 8 MiB / 128 inode 的 tmpfs，`nodev,nosuid,noexec`；H1 必须继续满足既有禁 swap/core 要求。chroot 根及所有父目录由 root 拥有且不可由该账号写入。`in/` 由新账号写，`out/` 只由 root 写、该账号只读。此目录不包含私钥、密码、快照、数据库数据或 archive/backup 的挂载。

每次仅允许一个已准入操作。准备前要求交换 authorized_keys 为空、无该账号遗留进程、无上一操作未解决的交换目录；失败不覆盖或复用。只安装当前 job 已核验的 Ed25519 公钥，不接受另一把交付密钥。客户端固定验证 H1 host key，禁止自动接受陌生主机。

## 固定文件与顺序

| 文件                        | 方向        | 唯一用途                                                         |
| --------------------------- | ----------- | ---------------------------------------------------------------- |
| `in/creation.bundle.json`   | hosted → H1 | 现有创建证据 exporter 的签名字节，最多 1 MiB                     |
| `out/cleanup-request.json`  | H1 → hosted | 当前真实终态及其负责人 ACK 的非秘密原件、摘要和操作绑定          |
| `in/cleanup.bundle.json`    | hosted → H1 | 现有清理证据 exporter 的签名字节，最多 1 MiB                     |
| `out/cleanup-imported.json` | H1 → hosted | 确认 H1 已验证并导入指定清理 bundle，可关闭原转发连接            |
| `out/closed.json`           | H1 → hosted | H1 正常关闭后的精确 CLOSED 记录读回；不冒充旧 RC public evidence |
| `in/closed-received.json`   | hosted → H1 | 确认已取得精确 CLOSED 字节，仅用于清除本次交付临时目录           |

实施修正（2026-09-30）：仅发布 CLOSED 或看到 SFTP 退出，不能证明 hosted 已收到 CLOSED，故在同一已批准 inbox 写权限内增加上述固定交付回执。它绑定完整既有 scope 与 CLOSED 原件摘要，不是负责人 ACK、CLOSED 证据或执行授权；没有回执或摘要不符时保留旧交换目录。此项不增加账号权限、端口、密钥或服务。

上传先写固定 `.part` 文件再改名。H1 限长读入稳定的普通单链接文件，验证现有签名、operation/spec/job 和摘要，才调用原 import；到达或文件名不代表成功。入站临时目录内容始终不受信任，不能直接成为私有 archive。

H1 的通知由持有原生会话的 owner 进程写入 root-only 出站目录。每个通知闭合绑定 operationRef、sessionId、sessionNonce、jobAdmissionDigest、creationSpecDigest、phase、chain 及对应实际记录摘要；包含的原记录必须匹配这些字段。来源依赖已固定的 H1 SSH host key 与 root-only 目录，不新增签名体系或发布授权。hosted 必须验证这些约束和当前 job/时窗，只能调用本句柄已有的零参数方法。

正常顺序：

1. H1 先完成既有 H1/H2、规范和 GitHub job attestation/API 准入；再准备交换目录及临时公钥。creation spec / job admission 的生产和准入前 GitHub artifact 下载仍需接入，SFTP 不用于绕过这一步。
2. hosted 保持原控制句柄、临时密钥和转发 SSH，上传创建 bundle。H1 验签、导入，执行当前 source/fresh 创建与完整 source 测试。
3. H1 显示真实终态摘要，负责人单独确认后调用 `acknowledgeSource`。仅成功 ACK 后发布清理通知；测试成功、超时、文件到达都不能自动 ACK。
4. hosted 验证通知，调用自己的 `cleanupOwnedTarget`，导出并上传清理 bundle。H1 导入并核验后发布 imported；此时还没有 CLOSED。
5. hosted 收到匹配的 imported 后终止原转发 SSH 并等待实际退出。独立 SFTP 会话继续存活。
6. H1 执行 `completeCleanup`、正常 `close`，确认原 UID 994 进程与两个监听消失，仅释放既有两个共享槽位。然后发布真实 CLOSED 读回。
7. hosted 取回并验证 CLOSED 后上传精确交付回执，再结束文件交付。H1 验证回执、撤销新账号临时 key，确认其进程退出，保留必要诊断到既有私有存储，再清除此操作临时交换目录。未完成交付的目录阻止下个交付操作复用，不能据此重做已消费操作。

任一步错位、摘要不符、超时、job 结束或连接中断，均保留原 UNKNOWN/失败事实与现有锁规则；不触发新的自动操作。账号或目录清理只针对本次实际持有资源。新增账号没有 DB/Engine 访问权，也不能写 root 出站通知。

## 实施与验证界限

先实现一个 source/fresh 的真实调用链：固定输入生产/准入、两侧持有进程、上述交付、独立 ACK、清理与关闭。再复用到其他 phase/chain；不拆成只有抽象回调的“已完成”接口。

只做必要的文件绑定/错序/中断检查，加一次隔离 OpenSSH 文件交付验证，覆盖禁止 shell/转发/越界写以及“关闭转发后 SFTP 仍能取得 CLOSED”的顺序。现有 final 长组合测试不因本草案重跑。线上启用前给出实际配置差异、语法验证、原账号有效配置对比与回滚文件；保持现有管理 SSH 连接。

旧 `source-gate` / `final-compose` public evidence 与 aggregate 的映射仍需独立对齐，不能把本文件或 CLOSED 通知当成发布凭证。合法 DB 快照、实际同候选 R2/R3 双链、两项 Staging 迁移及 R4 仍为原收口要求。本草案不批准 push、merge、workflow dispatch 或发布。
