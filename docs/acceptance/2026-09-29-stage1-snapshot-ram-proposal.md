# 阶段 1 快照读取身份确认

账号：`1457643390906675`。用途：H1 主机 `139.196.227.195` 在既有 R3 授权流程内读取 OSS 加密快照。2026-09-29 实际接口已确认目标 RAM 用户与角色均不存在。

本次拟创建以下四项，并仅附加下列两份策略：

| 对象 | 名称 | 权限 |
| --- | --- | --- |
| RAM 用户 | `subscription-saas-stage1-h1-snapshot-user` | 仅代入下列角色，不开通控制台登录 |
| RAM 角色 | `subscription-saas-stage1-snapshot-consumer` | 读取指定 bucket 的快照目录及必要属性；最大会话 3600 秒 |
| 自定义策略 | `subscription-saas-stage1-h1-snapshot-assume` | 附加给上述用户 |
| 自定义策略 | `subscription-saas-stage1-snapshot-consumer-readonly` | 附加给上述角色 |

用户策略：

```json
{"Version":"1","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Resource":["acs:ram::1457643390906675:role/subscription-saas-stage1-snapshot-consumer"]}]}
```

角色信任策略：

```json
{"Version":"1","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Principal":{"RAM":["acs:ram::1457643390906675:user/subscription-saas-stage1-h1-snapshot-user"]}}]}
```

角色权限策略：

```json
{"Version":"1","Statement":[{"Effect":"Allow","Action":["oss:GetObject","oss:GetObjectAcl"],"Resource":["acs:oss:*:*:subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai/snapshot-slots/v2/*"]},{"Effect":"Allow","Action":["oss:GetBucketAcl","oss:GetBucketWorm","oss:GetBucketVersioning"],"Resource":["acs:oss:*:*:subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai"]}]}
```

这将建立 H1 的独立 OSS 读取身份；不包含上传、删除、修改 bucket 设置、管理其他身份或 KMS 权限。读取加密对象不等同于获准解密或执行数据库测试，后两项仍受既有发布授权约束。

确认后先创建身份与附加策略，并通过 RAM 接口回读核对。服务器加密卷当前未挂载；仅在恢复并核验既有 LUKS 主备卷后，才可生成这一用户的专用程序凭据并直接保存到批准的加密凭据目录，禁止落到未挂载目录、仓库或聊天中。既有构建上传身份与其他应用权限保持原状。

本确认不涉及 ECS 代管账号、商用 KMS、生产业务数据迁移或最终发布签收。
