# Stage 1 环境与可信输入准备记录（2026-09-27）

本记录只证明以下实际操作及读回，不是 H1/H2/R2.4/R3/R4 通过证明。用户已批准继续以阶段 1 收口为目标，禁止功能膨胀和过度测试，并批准需要时通过现有 SSH 密钥恢复本系统 Docker。

## 已确认的选择

- 签名执行主机：`139.196.227.195`；负责人：`keqi119`，均由用户明确指定。
- 可用私有 OSS bucket：`subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai`，由用户明确指定。既有设计要求的 210 日 WORM 保持不变；本轮未修改任何 bucket 策略。
- 当前 SSH 会话使用已有 `subauto_staging_codex` 密钥及已存 host key，开启 BatchMode、IdentitiesOnly 和 StrictHostKeyChecking；未读取/展示私钥内容。
- 实际系统 principal 为 `posix/uid=0`。业务负责人标识 `keqi119` 不表示服务器已存在同名系统账号；未创建账号或变更权限。
- 按现有 R1 Linux 算法计算的非秘密 hostFingerprint：`sha256:9a5d400437a09697e136f885d892159e8cbe7585accf5a60a95afa4c380831b0`。未输出原始 machine-id。

## Docker 恢复范围与现状

实际 Docker daemon 为 26.1.3。恢复前，本系统 `subauto-staging` 的 postgres/api/web 均停止；另有 `subscription-mvp-test` 五个容器运行。用户随后明确批准暂停与发布无关的容器：重新核对五个容器的 project label 和完整 ID 后，先对 worker/api/proxy/admin、再对 database 执行 `docker stop --time 30`。五个容器均停止，镜像、容器和数据卷保留；生产及其他原已停止的历史数据库容器未操作。

停止后 `docker ps` 仅列 `subauto-staging-postgres-1`（healthy）；`free -m` 读回总内存 1870 MiB、available 1183 MiB。暂停容器释放 CPU/内存，不代表磁盘空间增加。

通过容器 Compose labels 核对，本系统 Staging 项目目录为 `/opt/subscription-saas`，配置来源为 `docker-compose.staging.images.example.yml`。

| 服务       | 实际资源                                                                                                         | 本轮结果                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| PostgreSQL | `subauto-staging-postgres-1`；专属卷 `subauto-staging_staging_postgres_data`；无宿主端口发布                     | 对现有容器执行 `docker start`，随后读回 running/healthy |
| API        | `subauto-staging-api-1`；镜像 `ghcr.io/keqi119/subscription-api:Staging-20260901-06f60bc`；宿主 `127.0.0.1:3101` | 保持停止                                                |
| Web        | `subauto-staging-web-1`；镜像 `ghcr.io/keqi119/subscription-web:Staging-20260901-06f60bc`；宿主 `127.0.0.1:3100` | 保持停止                                                |

API 的现有配置中 `SUBSCRIPTION_JOURNEY_ENABLED`、`SUBSCRIPTION_JOURNEY_WORKER_ENABLED`、`BILLING_AUTOMATION_WORKER_ENABLED` 均为 true，`AUTO_DEBIT_ENABLED` 为 false。启动旧 API 会恢复后台任务，因此本轮只恢复用于目标盘点的数据库。后续按既有 R4 门槛部署同候选并确认业务开关后，再恢复应用服务；本记录不宣称公共网站或应用已恢复。

未 pull 镜像、重建容器/数据卷、升级 PostgreSQL、部署候选或运行业务任务。用户已明确批准按收口/发布要求对齐迁移，无须再次逐项申请批准；真实执行仍按备份、目标核验和可信候选入口顺序进行。

## 实际数据库差异

通过已确认容器内的 `psql -X`，使用 `BEGIN READ ONLY` 查询版本及 `_prisma_migrations` 元数据；未读取业务行，未运行迁移、修复或其他 DDL/DML。UTC 读回时间为 `2026-09-26T18:32:48.3260082Z`。

- 数据库：`subscription_saas_staging`；实际连接用户：`subscription_saas`；实际 PostgreSQL 版本：**17.10**。
- 当前原任务源码的迁移文件数为 **128**。
- 服务器共 **127** 条迁移记录，其中 **126** 条已完成且未回滚；没有未完成且未回滚的迁移。
- 已应用迁移与本地同名文件的 SHA-256 全部一致，没有额外已应用迁移。
- 一条保留的历史回滚记录为 `20260724150000_vehicle_insurance_policy_source_of_truth`；它不等于当前有一条进行中的失败迁移。
- 尚未应用：`20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard`。

上述结果是实际元数据比对，不冒称执行了正式候选的 Prisma migration gate。R2.2 本轮开发 preflight 刻意禁用 dotenv 并移除 DATABASE_URL：`prisma migrate status` exit 1（Connection url is empty），`prisma:validate` exit 0；前者未连接服务器，也不能用来判断服务器 URL 配置损坏。

真实 Staging 仍须完成已批准的目标适配、备份恢复和可信迁移入口后才应用待迁移。不得直接将 R2 synthetic-fresh 的 URL 换为 Staging。R2/R3 要求的 PG17.11 参考/验证目标与本机现有 PG17.10 也不能混报为同一环境。

## H1/H2 尚需落实的事实

H1 已获得负责人、主机和实际 principal/fingerprint，但五个加密根、独立加密备份恢复、公钥及最终 profile 审批原件尚未建立。系统盘观察到 `/dev/vda3` 上的 ext4，未见本机 dm-crypt 映射；这不证明云厂商层未加密，也不证明已加密。当前该卷约剩余 5.1 GiB，后续镜像/参考库/副本准备须先核对容量，不清理未知数据。

服务器存在 Aliyun CLI 3.0.305，但其默认 profile 未配置。用户已说明相关基础设施尚未配置，并授权协助完成配置。使用现有应用 OSS 身份的进程内只读身份探测未能完成验真，未输出密钥或原始认证错误；不能据此认定凭证无效或其权限足够。实例 metadata 的 RAM role-name 查询返回 404，未获取任何实例凭证。用户确认 Edge 已有阿里云管理登录，但全局浏览器盘点和指定 Edge 的标签页读取均报 `nodeRepl.fetch request failed`，尚未接通控制台。尚未取得目标 bucket 的独立 Get/Head/ACL/WORM 实测，也没有证明写入者与审计读取者隔离。当前缺少可由本任务使用的云管理连接；SSH root 权限不能替代云管理认证，这不是再次等待操作批准。

GitHub 只读查询确认远端 main 受保护，当前 SHA 为 `f8ed944030646bb697c4724e9071b1151e64e5ef`。实际 environments 为 `s1-approval-revocations`、`trusted-image-build`；本次查询的 repository secrets、trusted-image-build secrets/variables 列表为空。该事实不等于 GHCR 构建必然缺凭证：现有 GHCR 分支使用 `github.token`。

最近三次 docker-images workflow 记录中，2026-09-03 的 `33716557087` 失败，2026-09-01 的 `33480081279` 与 2026-08-31 的 `33450642058` 成功。均非当前阶段 1 最终候选，未触发新 workflow、push 或合并。

后续先补齐现有云身份配置及加密/备份事实，形成精确可审查的 H1/H2 配置；不复制测试身份、不把 bucket 名称视为权限或保留策略已通过、不生成替代成功 receipt。离线 R2 代码实现可继续，不依赖这些尚未完成的外部门槛。

## 签名主机运行工具准备（同日后续）

已在 `/opt/stage1-tools/` 安装 Node `v22.23.3`、GitHub CLI `2.101.0` 和 pnpm `11.4.0`，并建立 `/usr/local/bin` 入口。安装前核对目标路径及入口不存在，没有覆盖既有程序。新 SSH 会话读回默认版本及 `gh attestation verify` 的 `--deny-self-hosted-runners` 支持；用该 Node 按既有 R1 算法重新计算 hostFingerprint，与本记录前述结果相同。

Node 和 gh 的官方发布包在本地及服务器分别校验 SHA-256：

- `node-v22.23.3-linux-x64.tar.xz`：`df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`，来源为 Node 官方发布目录及其 SHASUMS。
- `gh_2.101.0_linux_amd64.tar.gz`：`9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8`，来源为 GitHub CLI 官方 release asset/digest。

服务器直接下载 gh 曾在 90 秒后超时、未成功；随后由本地下载同一官方发布包，经 SCP 上传并在服务器重新核验后安装。失败原件未改写为成功。pnpm 通过随 Node 安装的 Corepack 准备；没有配置云凭证、生成发布签名密钥或启动业务服务。

安装后磁盘剩余约 **4.8 GiB**（使用率 88%）。这些工具只补齐执行环境，不证明 H1 加密保管、H2 可信构建或 R2 真实门槛已经通过。

## 云管理认证的后续入口

Edge 已登录的控制台仍无法由浏览器工具读取，因此改用阿里云官方 CLI 的 OAuth 浏览器授权流程。Windows CLI `3.5.1` 已从官方 CDN 下载，其发布包 SHA-256 与官方 GitHub release digest 一致：`e35c0f66727df399c996646a4c33f64cd5b69f66eee3e33e1c4f51d41c603997`。两次 GitHub 下载传输失败/停滞保持为失败事实；没有使用第三方包。

已准备单独的当前用户 ACL 目录 `C:/Users/keqi_119/AppData/Local/Stage1CloudAuth`，本次 profile 为 `stage1-keqi119`，使用显式 `--config-path`。官方浏览器授权已发起并等待用户完成；截至本检查点，配置文件尚未生成，没有取得云管理身份，也没有创建 RAM role、改 OSS 策略或核实云盘加密。不会在报告、仓库或聊天中保存令牌/AccessKey。该认证步骤不改变用户此前对基础设施配置和服务器操作的授权。

## 已验明现有 RAM 身份与 OSS 配置（同日后续）

后续读取确认，前述 CLI 探测在本地 `profile default is not configure yet` 处失败。改用 `/dev/shm` 中 0700 临时目录及 0600 配置、仅在进程内装入既有项目凭证后，STS GetCallerIdentity 实际成功：账户 `1457643390906675`，RAM 身份 `deploy-codex-staging-user`。临时配置随后删除；没有将凭证值、凭证摘要或配置内容输出到日志/仓库。此前失败保留，不将其解释为凭证无效。

该身份的 `ram:ListPoliciesForUser` 返回 `NoPermission`，`ecs:DescribeInstances` 返回 `Forbidden.RAM`。这两项不证明所有其他 RAM/ECS 动作均禁止，但不足以完成受审查的角色/云盘配置；仍等待官方 OAuth 管理授权，不能将 SSH root 或当前应用身份当成云管理员。

使用已有 API 镜像中的 ali-oss SDK，对指定 bucket 的以下五项只读请求均返回 200：

| 配置                    | 实际读回                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| bucket / region / owner | `subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai` / `oss-cn-shanghai` / `1457643390906675` |
| ACL                     | `private`                                                                                             |
| Versioning              | SDK `versionStatus=null`，未启用版本控制                                                              |
| WORM                    | `Locked`，保留 **210 天**；创建于 `2026-09-05T15:47:35.000Z`                                          |
| 默认服务端加密          | `AES256`                                                                                              |

这些请求在无业务启动命令的临时只读容器中执行，仅以 stdin 在内存传入现有 OSS 凭证；不传 API 数据库环境，不挂载数据卷，禁用提权并限制内存/CPU，结束后容器已删除。第一次 SDK 相对路径解析失败（exit 1）后，按镜像既有 `/app/apps/api/node_modules/ali-oss` 路径修正才成功；没有启动旧 API/Web 后台工作者。

未写 OSS 对象、修改 ACL/WORM/加密、创建角色或绑定身份。当前事实仅证明已有桶配置符合这些基础条件，**不证明独立 writer/audit-reader、对象 Get/Head、实际保留或 H2 已通过**；210 天既有锁保持不变。ECS 云盘加密仍为 UNKNOWN，H1 五根/独立恢复仍未建立。

## 后续身份配置的只读准备

GitHub 实际读回：`trusted-image-build` 环境要求 reviewer `keqi119`，自定义分支策略只有 `main`；OIDC 仓库设置为 `use_default=true`、`use_immutable_subject=false`、`sub_claim_prefix=repo:keqi119/subscription-Saas`。没有修改环境或仓库设置。独立 writer/audit-reader 的限域 RAM 策略及 OIDC trust 草稿已放入 Task10 scratch；只是待管理身份认证后逐项核对的草稿，没有应用。

GitHub OIDC discovery 和 TLS 链也已实际读取：JWKS 主机为 `token.actions.githubusercontent.com`，服务端末张证书是 ISRG Root X1 交叉签名的 Root YR。该证书与 Let's Encrypt 官方发布 DER 精确一致；使用官方 X1 根证书校验完整链、服务端用途和实际 hostname，OpenSSL verify exit 0。按阿里云官方“取服务端输出最后一张证书”方法，当前指纹为 `ab9d0263244dd0326eb67015705a667e79cfe998`；未创建 provider。公开证书及读回原件保存在 Task10 scratch `oidc-public-chain/`，不含认证凭证。依据：[阿里云方法](https://www.alibabacloud.com/help/en/ram/user-guide/obtain-oidc-idp-fingerprints-through-openssl)、[Let's Encrypt 信任链](https://letsencrypt.org/certificates/)。
