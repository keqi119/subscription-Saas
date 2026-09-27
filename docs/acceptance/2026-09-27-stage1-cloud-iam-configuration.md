# Stage 1 云端 IAM 配置与服务器账号边界（2026-09-27）

## 本轮结论

指定 OSS 桶所属账号的管理认证及 H2 所需 OIDC/双角色配置已真实完成，并通过服务 API 独立读回核对。H2 整体仍未完成：尚未执行同候选 CI 的 OIDC 交换、双身份对象写入/读取、私有保管及证明链。阶段 1 继续开放。

服务器与 OSS 分属不同账号。此前在 OSS 账号查询不到服务器，不应解释为实例不存在、未加密或云权限配置失败。

| 资源/身份            | 实际读回                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------- |
| 已授权 OAuth profile | `stage1-keqi119`，默认地域 `cn-shanghai`                                                  |
| STS 身份             | `IdentityType=Account`，账号 `1457643390906675`                                           |
| OSS 桶               | `subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai`，所属账号 `1457643390906675` |
| 签名/部署服务器      | `139.196.227.195`                                                                         |
| 服务器实例           | `i-uf63lwxj7v011m6m4yim`，`cn-shanghai-g`                                                 |
| 服务器所属账号       | `1335332669126231`，通过已验 SSH 主机的实例 metadata `owner-account-id` 读取              |
| 云盘加密             | 尚未确定；需要服务器所属账号的云管理身份                                                  |

本地认证目录 `C:/Users/keqi_119/AppData/Local/Stage1CloudAuth` 为当前 Windows 用户独占 ACL，配置文件继承该权限。未读取、打印、归档或复制 OAuth 令牌/密钥内容。现有应用 RAM 用户权限没有扩大，没有创建长期 AccessKey。

## 已实施并读回的 H2 IAM 配置

OIDC provider 为 `acs:ram::1457643390906675:oidc-provider/github-actions-stage1`。创建前 `ListOIDCProviders` 返回空列表、无分页；两项命名角色/策略均返回对应 EntityNotExist。只创建缺失对象，没有覆盖旧信任关系。

- issuer：`https://token.actions.githubusercontent.com`。
- audience：`sts.aliyuncs.com`。
- 信任主体精确限定为 `repo:keqi119/subscription-Saas:environment:trusted-image-build`。
- `IssuanceLimitTime=1` 小时；两角色 `MaxSessionDuration=3600` 秒，`AllowConsoleLogin=false`。
- 当前真实 TLS 链再次核验 hostname、用途及信任根成功；按阿里云官方方法取链末证书，指纹为 `ab9d0263244dd0326eb67015705a667e79cfe998`。

| 角色                                             | 唯一附加自定义策略 v1                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `subscription-saas-stage1-evidence-writer`       | 仅指定桶 `evidence/*`、`receipts/*` 的 `oss:PutObject`                                                                 |
| `subscription-saas-stage1-evidence-audit-reader` | 相同对象前缀的 `oss:GetObject`、`oss:GetObjectAcl`；该桶的 ACL、WORM、版本、加密、公开策略状态、防公开访问六项只读查询 |

已逐项核对 GetOIDCProvider、GetRole、GetPolicy 的实际默认版本文档与 ListPoliciesForRole。每个角色仅挂上述对应 Custom policy，信任的 issuer/audience/subject 与固定 provider 精确一致。角色返回的 Federated 单元素数组与请求中的同一主体语义一致，没有因服务端规范化改变信任范围。

这些读回证明已配置策略；不冒称实际作业令牌交换、OSS 双角色操作或所有外部资源策略的有效权限审计已经通过。未改变桶的 private/BPA/WORM 210 天/AES256/版本配置，未写入或删除对象，未触发 workflow、push、迁移或部署。

## 原件、失败与继续执行边界

实际 API 请求参数、响应原文、时间、退出码及摘要保存在发布隔离工作树：
`.superpowers/sdd/2026-09-25-stage1-trusted-build-input-preparation-plan/cloud-setup-20260927/`。
其中 `iam-configuration-complete.json` 汇总真实配置结果；各角色 create/readback/attach 原件独立保留，`server-account-boundary.json` 记录两账号关系。目录无凭证内容；不是已签名 H2 custody 或发布准入材料。

保留的准备失败包括：CLI 对 EntityNotExist 实际退出 2，最初检查误预期 1；服务器按公网 IP/实例 ID 在 OSS 账号内查询均为零结果；严格文本比较首次拒绝服务端把 Federated 字符串规范化为单元素数组；一次 GetPolicyVersion 缺 VersionId 的 CLI 校验失败，未请求云 API。后续按已有成功创建原件接续，没有重复创建/覆盖对象。策略版本最终采用 GetPolicy 已返回的 DefaultPolicyVersion 文档独立核验。

用户已批准基础设施配置和服务器操作；当前额外缺口是另一个账号的实际登录。已为服务器账号发起独立 `stage1-ecs-keqi119` OAuth，会话待回调，配置路径为 `C:/Users/keqi_119/AppData/Local/Stage1EcsCloudAuth/config.json`。原 OSS profile 保留。只有实际 STS 确认账号 `1335332669126231` 后，才继续该实例的云盘查询/配置；不扩大现有应用 RAM 用户权限来绕过账号边界。

R2 父命令执行链的离线实施正在原隔离工作树继续。本轮 preflight 的 migration status 因 `datasource.url` 缺失 exit 1（禁用 dotenv、未连接 DB），schema validate exit 0。未改业务代码；真实 H1、H2、完整 R2、R3 双链与 R4 验收仍未关闭。
