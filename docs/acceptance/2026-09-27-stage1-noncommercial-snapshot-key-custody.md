# 阶段 1 非商用快照密钥保管实测

日期：2026-09-27。范围为[非商用快照修订](../superpowers/specs/2026-09-27-stage1-noncommercial-snapshot-amendment.zh-CN.md)中的独立加密密钥和恢复副本。没有购买或调用商用 KMS；本记录不代表真实快照消费、R3 双链或阶段 1 已通过。

## H1 实际生成与恢复

- 主机 `139.196.227.195`，负责人 `keqi119`，实际 Linux uid 0 / Node `v22.23.3`。生成进程核对实际 machine-id 派生的既有 host fingerprint。
- 独立 RSA-3072 / exponent 65537 / RSA-OAEP-SHA256。SPKI 指纹为 `sha256:97dd86420772ba557ce9ddeaef1e762f79cebebe39cf0319d7195ede273ada01`。主卷相对引用 `key/snapshot-rsa3072.pk8.der`；与 Ed25519 签名私钥和 LUKS unlock key 分离，既有 profile 与批准摘要不改写。
- 10:50:23.296 UTC，实际生成、0600 create-only 保存、fsync、重新读入主副本，并完成随机 32-byte challenge 加解封。独立恢复副本置于既有 recovery LUKS 卷的 `backup/snapshot-rsa3072-20260927/`。
- 关闭两卷并确认 main mapper 消失、主卷下层目录为空后，只重新打开 recovery。10:50:24.762 UTC，新 Node 进程从恢复副本重新导入私钥，以另一随机 challenge 成功加解封，公钥指纹一致。没有把第一次自检重复记录为恢复。
- controller 自然 exit 0。另一次只读 SSH 确认两卷均未挂载、mapper 不存在、下层目录为空；原 `/www/swap`、`/swapfile-stage9` 已恢复，临时 core override 已移除。秘密未进入操作输出、命令行或环境变量。
- 原始 creation JSON 的 raw digest 为 `sha256:955684cf5fc1c3d682a3b748ad2347d69e57d9cb9bf14befcbda13f005721e5c`。创建/恢复完整公共读回与控制器结果保存在本次受控操作记录中；其中不含私钥或 unlock key。

## 更新后的加密副本

- 使用关闭状态的原 recovery LUKS2 文件，重新核验 UUID `867c622b-e066-4a9a-88eb-766a4f27528c`、root/0600、单链接、恰 1 GiB，以及读前后路径/句柄身份未变。
- 10:53:32 UTC，本地完整导出通过，实际 1,073,741,824 bytes，SHA-256 `0ecae7d23d5fa22dc3e0020e9737dee2f34fbcd211a7d4a74de47fd88be0d8a0`。仅导出密文，原备份目录和旧 OSS 对象保留。
- 新副本目标：既有私有 bucket `subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai` 的 `h1-recovery/v1/20260927-1d38d30c-fb0e-440f-bce2-323bd5ecffea/recovery.luks`。
- 首次上传在获取 CLI 凭据时以 `invalid_grant` 失败，exit 1；原始失败记录保留。用户完成官方 OAuth 续期后，STS 确认账号 `1457643390906675`；11:00:34 UTC 对精确目标执行 HeadObject 得到真实 `404 NoSuchKey`，随后才以新尝试记录执行 forbid-overwrite 上传。没有覆盖失败记录或旧对象。
- 11:04:41 UTC，新上传自然 exit 0。11:07:24–26 UTC，六次串行读回全部 exit 0：对象长 1,073,741,824 bytes、对象及 bucket ACL 均为 private、对象和 bucket 加密为 AES256、WORM 为 Locked / 210 天、bucket 未启用 versioning。HeadObject request ID 为 `6AB8F8ED7125543735B89DFA`。
- 11:08:36 UTC，从 OSS 完整下载至另一个本地文件，自然 exit 0。下载长度与 SHA-256 均与源端导出一致；`independentCiphertextReadbackVerified=true`，`offHostRecoveryVerified=false`。这是完整密文字节核对，尚未在异机打开 LUKS 或执行私钥恢复。

## 证据范围与限制

操作脚本为既有已审 LUKS 开关/恢复流程的固定路径复用，加密密钥生成部分经有限独立源码审查；实际运行结果另行核验。脚本/原始结果位于候选工作区 `.superpowers/sdd/2026-09-22-stage1-r3-final-image-dual-chain-plan/h1-snapshot-key*` 与 `h1-ciphertext-*`，本报告只列非秘密事实。

这是同主机独立加密卷恢复，尚未进行异机解密恢复。软件私钥可被获准进程/root 读取；内存清除仅 best effort，不声明硬件不可导出或可证明物理擦除。本次 OSS 上传与独立请求读回使用同一 Account 身份，不能证明独立 RAM principal；真实 CI 的 writer/audit-reader 身份隔离仍属于 H2 验证。

本地纯密钥模块 Windows Node 24 的 6 项离线测试已通过，但 H1 本次使用的是受控操作脚本中的原生 crypto；不能把它写成生产 envelope/consumer 已运行。v2 流接线的三个定向测试文件已通过 53 项离线测试，代码复核另行进行；实际输入授权、H1 consumer 接线和远端认证恢复仍须完成。

## 13:17 UTC 后续：生产公件读取器实际读回

提交 `48ac0b8edaba543d9e003bef181849de04e65a78` 增加已有创建/恢复公件的闭合结构、公钥关联校验和固定读取入口。原件不新增 schemaVersion、不重新编码；恢复记录继续绑定创建文件的原始字节摘要。校验实际 SPKI DER、RSA-3072 / exponent 65537，拒绝私钥 PEM。固定入口核对实际 H1 身份、原 profile / owner binding / 批准、文件权限和独立重开，并返回可重查、可关闭的公件句柄，不授予消费权限。

Windows shared 测试从 4 项定向 RED 到既有文件 22/22 GREEN；Linux 原生文件读取小组从 10/10 RED 到最终 10/10 GREEN，Node exit 0。最终版本包含首个 await 前固定调用参数及 IO 完成后重新检查有效窗口。有限独立源码复核 ACCEPT，七文件暂存字节与最终已测摘要一致；没有重跑旧业务或正常执行链。

随后仅部署该提交的公件读取源码子集至 `/opt/stage1-h1-key-reader-20260927`。包为 443,553 bytes，SHA-256 `f2541b88f8d79ec9c8464e16aa840ef75a5cb39ce81743bbd5e1857849699130`；149 个源码文件逐字节匹配该提交，533 个纯 JS 依赖匹配当前相同版本文件。上传、create-only 解包及另一次独立 SSH 对全部 682 个文件的身份/长度/摘要读回均 exit 0。这不是完整发布 checkout、候选镜像或 CI 验收。

实际受控操作将原 archive 创建公件、独立 recovery 卷的创建副本及恢复公件分别重开核对。只把原始公件字节导入固定 private input 区，生成非授权索引 `270960aa-bbfc-4bd6-bd94-409d36822f3b`，再调用上述生产读取器和 recheck / close。进程自然 exit 0，主机记录时间为 `2026-09-27T13:17:59.856Z`：

- index raw digest：`sha256:65c9f5100926f101973675f740e7cbfb8bdc93782aa6c29757e97f823ddd7bca`。
- 创建公件 raw digest 保持 `sha256:955684cf5fc1c3d682a3b748ad2347d69e57d9cb9bf14befcbda13f005721e5c`。
- 恢复公件 raw digest：`sha256:74abe19bc040c4c02db15f6785a1790f3582b21fed6e921db219b2a4ea538962`；公钥指纹仍为本报告前述 `97dd8642…`。
- 原 profile、批准及原公件均保留；没有生成新密钥、读取 RSA 私钥、连接数据库或授予消费权限。

后续独立 SSH 确认两卷均已卸载、mapper 不存在、underlay 为空，两个原 swap 已恢复，本次临时 core override 已移除，操作进程无遗留。运维脚本及部署包分别经有限源码复核；真实结果保存在同一 R3 scratch 的 `h1-public-reader-source-readback.json`、`h1-public-reader-source-independent-readback.json`、`h1-public-key-reader-install-result.json` 和 `h1-public-reader-independent-cleanup.json`。最初准备状态及测试 RED/较早 GREEN 保留，未覆盖为最终成功。

本增量闭合公件固定读取，仍不证明合法快照输入、read/decrypt/use scope、目标准入、consumer session、私钥释放、异机恢复或远端 restore。`consumerAuthorized=false`、`offHostRecoveryVerified=false`、`h1Complete=false`；商用 KMS 仍不在范围内。
