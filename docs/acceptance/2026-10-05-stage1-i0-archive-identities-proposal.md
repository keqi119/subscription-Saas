# 阶段 1 独立控制证据身份初始化草案

状态：待用户确认，尚未创建或授权。精确配置为[同名 JSON](2026-10-05-stage1-i0-archive-identities-proposal.json)。本次只初始化 I0 独立身份；实际对象归档另有精确对象授权和真实读回门槛。

账号 `1457643390906675`，主机 `139.196.227.195`，负责人 `keqi119`。既有 bucket `subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai` 保留原配置。管理端已于本轮通过 GetCallerIdentity 确认账号；不涉及 ECS 代管账号。

## 拟应用的精确变更

| 用途     | RAM 用户（无控制台登录）                       | RAM 角色                                  | 唯一用户策略                                     |
| -------- | ---------------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| 独立写入 | `subscription-saas-stage1-archive-writer-user` | `subscription-saas-stage1-archive-writer` | `subscription-saas-stage1-archive-writer-assume` |
| 独立读回 | `subscription-saas-stage1-archive-reader-user` | `subscription-saas-stage1-archive-reader` | `subscription-saas-stage1-archive-reader-assume` |

每个用户的唯一 Allow 是 `sts:AssumeRole` 到本行角色；每个角色的唯一信任主体是本行用户 ARN。完整两份用户策略、两份信任策略在 JSON 内。角色 MaxSessionDuration 为服务支持的最小上限 3600 秒，后续受控操作只请求 900 秒；用户不加入组，不配置登录密码。角色初始不附任何权限策略，尤其不授予 `control-evidence/*` 或任何 OSS 对象权限。实际有效权限仍须结合真实附加策略、组和资源策略回读，不以“角色为空”代替有效权限证明。

本次可创建的管理对象限定为两用户、两角色、两份 AssumeRole 自定义策略及对应的两次用户策略附加。既有 build writer/audit reader、snapshot consumer、GitHub OIDC 和其他业务身份均不在此变更集合内。

## 凭据与执行隔离

批准范围包含在实际加密卷检查通过后，为每个新用户生成最多一把专用程序凭据；没有实际使用需要时先不生成。生成前重新读取 AccessKey 清单，发现已有凭据则停止新增并核对恢复，不盲重试。主卷/恢复卷必须分别匹配既有 LUKS 身份并真实挂载，swap/core 保护须生效。仅在 JSON 列明的专用目录保存，目录 root:root 0700、文件 0600；远程仅经私有 stdin 交付。必要的本机临时保全沿用 CurrentUser DPAPI 和本人专有 ACL，不落明文文件、仓库、日志或聊天。

后续 writer 和 reader 由不同进程分别读取各自凭据、获取各自短期会话；Runner、job、数据库和管理身份不能代替它们执行归档。使用既有非商用加密卷与签名根，不引入 KMS、常驻服务或新的操作平台。

## 应用与核对

1. 管理端重新确认账号；GetUser/GetRole/GetPolicy 检查全部六个名称。已有对象只核对，不接管不匹配的对象。
2. 对缺失对象执行 CreateUser、CreateRole（精确 trustPolicy、3600 秒）、CreatePolicy（精确 assumePolicy），最后 AttachPolicyToUser。各调用失败或结果未知时先回读，不重复创建；不执行 CreateLoginProfile 或 AttachPolicyToRole。
3. 独立回读用户、角色、默认策略版本、用户附加策略和组、角色附加策略、登录配置与 AccessKey 数量；核对 ARN、信任主体、唯一用户策略、角色策略为空、无组、无登录配置。保存非秘密响应和请求 ID，创建返回值本身不算完成。
4. 专用程序凭据仅在上述保护与实际需要都成立时创建、加密保存和独立检查；未知结果保留，不自动生成第二把。

## 后续边界与批准来源

现有 build evidence writer/reader 仅信任 `trusted-image-build` OIDC；snapshot consumer 仅能读 `snapshot-slots/v2/*`。原[安全补充 503–521 行](../superpowers/specs/2026-09-03-stage1-s1-execution-infrastructure-security-addendum.zh-CN.md)要求 I0 独立于未来 build/OIDC，并先形成真实原件、精确对象集合及独立批准。

本次初始化不会完成 I0，也不会授权上传未来未知对象。原件字节、摘要和 `control-evidence/v1/<proof-type>/<canonical-digest>` 完整键名冻结后，再生成无对象通配符的 RAM 角色策略和对应会话策略，提交具体差额供用户确认。真实写入、writer 终态、独立读回、Last-Modified/Locked WORM 和签名 checkpoint 才能支持保管结论。当前 `i0-revocation-state.v1` 尚未列入归档 proofType 合同，须对齐原合同，不能改名冒充另一类证据。

这里再次请用户确认的依据是用户此前明确要求“当前如果需要 RAM 授权，请调用浏览器打开页面由我确认”，本次是新增 RAM 身份；不是重新申请 H1、Docker、GitHub App 或已批准的现有 snapshot consumer。

官方接口依据：[角色及会话有效期](https://www.alibabacloud.com/help/en/ram/user-guide/assume-a-ram-role)、[AssumeRole 会话权限交集](https://help.aliyun.com/en/ram/developer-reference/api-sts-2015-04-01-assumerole)。
