# 阶段 1 快照非商用密钥方案前向修订

日期：2026-09-27。依据用户已经批准的阶段 1 收口范围，以及明确拒绝商用 KMS 的指令。本修订替代旧安全附录中快照必须调用商业 KMS、KEK 硬件不可导出、consumer 必须在 hosted VM 解封 DEK 的要求。其余合法输入、逐操作授权、身份分离、私密保管、完整认证、独立目标和真实验收要求保留。

本文件确定后续实现方向，不是已生成密钥、已完成加解密、已授权具体快照或已完成恢复的证明。不得重新申请 KMS 预算、购买实例或建立常驻密钥服务。既有 H1 profile 的批准摘要和 Ed25519 签名身份保持原件，不因本修订重建或改写。

## 固定实现方向

1. 沿用现有 AES-256-GCM 快照实现、每对象随机 96-bit nonce、256-bit DEK、两遍源摘要核对、1 GiB payload 限制及认证完成后发布文件的顺序。每次加密以 Node 原生随机源生成独立 DEK，不使用固定测试 DEK。
2. H1 `139.196.227.195` 使用独立的 RSA-3072 加密密钥对，公钥指数 65537，以 RSA-OAEP/SHA-256 包装 DEK；Node 参数固定 `padding=RSA_PKCS1_OAEP_PADDING`、`oaepHash="sha256"`，后者同时指定 OAEP/MGF1 的 hash，不依赖默认 SHA-1。不得复用 Ed25519 签名密钥、LUKS 解锁密钥或 CI 身份。
3. 公钥指纹为 DER/SPKI 字节的 SHA-256。OAEP label 使用现有 canonical JSON 编码的 `{ domain: "stage1-snapshot-dek-v2", contextDigest, keyFingerprint }`。context 保留 repository ID、source SHA、releaseAttemptId、snapshotRunId、sanitization contract digest 和既有到期时间；GCM AAD 另绑定扫描后的 snapshotDigest、contextDigest 和 keyFingerprint。包装算法、指纹、context、AAD 或任一摘要不符即拒绝。
4. 生产者仅持公钥，不能解封已有对象。独立私钥只在 H1 已准入 LUKS 主卷及独立恢复卷内保管；生成、备份、恢复和公钥指纹须有实际独立读回。既有签名密钥恢复证明不能替代新密钥恢复证明。私钥不进入 CI、OSS 明文对象、argv、环境变量或日志。
5. 独立 OSS reader 获取指定密文和 metadata。已获本次 read/decrypt/use 授权的 H1 一次性 consumer 在短生命周期进程内解封 DEK，先写入 H1 加密卷内 0600 临时文件，只有 GCM tag、明文/密文摘要、长度、来源和对象版本全部核对后才发布已认证文件。认证失败不得调用 `pg_restore`。
6. H1 本地 Docker CLI 通过同一个固定准入的原生 remote Engine transport，把已认证文件交给本次独立 hosted PostgreSQL 目标。复制后的实际字节摘要和目标身份须在恢复前核对；`cp`、`pg_restore`、`psql`、inspect 和清理使用同一 executor。不得把 H1 路径当远端 bind source，也不得用加载时的 Buffer 摘要替代稍后复制字节的证明。
7. hosted 端的 dump、PGDATA、WAL、临时数据与日志继续位于已准入加密边界。fresh/snapshot 使用独立目标；H1 不承担构建或全量数据库套件。完成、失败或中断均保留真实退出/UNKNOWN 和清理状态，未证明结束不伪造成功。

Node 22 原生 API 提供上述 OAEP 参数及随机源，后续实现不增加密码库：[Node.js crypto 文档](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptopublicencryptkey-buffer)。Docker CLI 读取 CLI 主机文件并通过 Engine API 复制；bind 源则由 daemon 主机解释：[Docker 26.1.3 cp 源码](https://raw.githubusercontent.com/docker/cli/v26.1.3/cli/command/container/cp.go)、[bind mount 限制](https://docs.docker.com/engine/storage/bind-mounts/#considerations-and-constraints)。这些是实现依据，不是本系统已运行证据。

## 必要契约变更与兼容边界

使用前向版本，旧 v1 原件和摘要不改形。新执行只使用非商用分支，不增加运行时任选云厂商或算法的配置平台。

| 文件 / 实现                                                                                                | 必须表达的实际事实                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `producer-crypto-run-authorization.v2.schema.json`                                                         | 独立公钥指纹、软件包装算法、context、真实 key readback / 恢复引用、生产者和 H1 consumer 的既有授权绑定；不伪造 RAM/KMS endpoint/action/session。 |
| `producer-crypto-use-proof.v2.schema.json`                                                                 | 本次加密调用、输出 envelope、进程真实退出、准入终止及清理原件；本地进程退出不能冒称 STS REVOKED/EXPIRED。                                        |
| `snapshot-encryption-envelope.v2.schema.json`                                                              | RSA-OAEP/SHA-256 包装元数据、384-byte wrapped DEK、公钥指纹、contextDigest、真实 key readback、AES-GCM AAD/tag 与完整字节摘要。                  |
| `snapshot-cloud-policy.v2.json` 及同名 schema                                                              | 保留 OSS exact-slot、create-only、独立 writer/reader、Locked WORM 和 retention 身份；移除 KMS data action，将对象读取权与 H1 本次解封权分开。    |
| `snapshot/producer-crypto-contracts.mjs`、`snapshot/envelope-crypto.mjs`、`snapshot/custody-contracts.mjs` | 在现有共享校验和加解密函数内按确切版本校验，不新增第二套解析器；历史 v1 可校验，不作为新执行路线。                                               |
| `snapshot/local-envelope-key.mjs`                                                                          | 小型 Node 原生包装/解封实现，仅接受已验证公钥或本次已打开的私钥句柄、固定 context；不扫描路径、不下载凭据、不提供服务或任意 CLI 参数。           |

以上 schema 位于 `release/contracts/schemas/`，policy JSON 位于 `release/contracts/`，实现位于 `packages/release-foundation/src/`。同一实现切片同步现有 archive proof allowlist、测试分类目录及 `repository-contract-files.v1.json`；不得先发布消费不了的新证明。`prebuild-sanitized-input-binding.v1` 已有独立 read/decrypt/use 权威，不因替换算法自动扩大授权。

host consumer、源导出、producer、固定 remote Engine 和认证文件交付仍按 R3 现有任务实现。它们尚未接线；本修订不把离线 envelope 测试算作合法真实快照、host 准入或最终双链通过。

文件消费接缝固定在 R3 已列的 `scripts/release/database-test-launcher-runtime.mjs`。本地适配器切片 `9417b5b3` 已绑定 shared 传入的 `dump/dumpDigest/target`，并在自建私有目录中核验复制后的实际文件摘要、权限及实际 PG 身份，失败时不调用恢复。`loadSnapshotArtifact` 仍读取 repo 明文 Buffer；H1 已认证文件、hosted 加密暂存路径和所有 Docker 动作使用同一获准 executor 的接线仍未完成。该切片没有授予真实快照消费权限。

## 有限验证与完成条件

- 在现有 crypto / schema / custody 测试中验证真实随机 DEK 包装和解封、完整加解密往返，以及错误公钥/context/AAD、篡改 ciphertext/tag、截断输入和目标已存在时的拒绝。复用既有流/大小/清理测试，不复制旧矩阵。
- 验证 producer 只有公钥仍可加密，不能解封；未通过完整认证时恢复 adapter 调用次数为零；恢复前复制字节/目标核验失败也不得调用恢复。
- 新 RSA 密钥的实际生成、独立恢复读回、软件 consumer 退出、私钥保管、真实快照合法性、OSS 独立读回与远端恢复分别取实际证据，不从单元测试推断。
- 最终仍须同候选两条链各 37 套及 API/Web 就绪通过，随后完成 Staging R4。此修订不增加新的业务范围或套件数量。

## 软件保管的真实限制

LUKS 内软件私钥可被获准进程和宿主 root 读取，不能声明硬件不可导出。准入到期只能阻止新的解封；已释放 DEK 不能靠授权到期、进程退出或文件删除被证明撤销。已有 core/swap/内存保护条件必须按实际主机能力和读回满足，不能填写虚构的 memoryLocked 或物理擦除证明。

主卷与恢复卷当前共享同一物理主机，已有异地密文保管不等于异机解密恢复。恢复范围必须如实记录。不得为单个对象到期销毁仍保护其他有效对象的共享 RSA 私钥；保留既有独立 retention 权限与到期保管规则，不承诺软件密钥支持逐对象密码销毁。
