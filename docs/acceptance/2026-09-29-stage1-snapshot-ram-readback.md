# Stage 1 快照读取身份实施读回

2026-09-29 已按用户确认的 [精确草案](2026-09-29-stage1-snapshot-ram-proposal.md) 实施。批准文件 SHA-256 保持 `c0b929946e21e08141ddb2db258f70204550e9b8569841ebd97aef3a361092c0`，本记录不变更批准范围。

## 实际配置

- 账号：`1457643390906675`。
- 专用用户：`subscription-saas-stage1-h1-snapshot-user`，ID `209920890650548072`，没有创建控制台登录。
- 专用角色：`subscription-saas-stage1-snapshot-consumer`，ID `300536155041336871`，仅信任该用户，控制台登录关闭，最大会话 3600 秒；本次读取使用 900 秒凭据。
- 用户唯一附加策略 `subscription-saas-stage1-h1-snapshot-assume` 只允许代入上述角色。
- 角色唯一附加策略 `subscription-saas-stage1-snapshot-consumer-readonly` 只允许读取指定 bucket 的 `snapshot-slots/v2/*` 对象及 ACL，和必要的 bucket ACL、WORM、版本控制属性。无写入、删除、KMS 或 RAM 管理权限。

CLI 创建后逐项读取用户、角色、两项附加关系和两份策略，核对实际内容与批准草案完全一致（`6439e8`）。未改动现有部署用户。

## 凭据保管

H1 `139.196.227.195` 的两块既有 LUKS 卷实际解锁预检通过。新建的一份专用程序凭据写入主卷 `/var/lib/stage1-volumes/main/credential/snapshot-reader/bootstrap.json` 与独立恢复卷 `/var/lib/stage1-volumes/recovery/backup/snapshot-reader/bootstrap.json`，以私有目录和 0600 文件保存，两侧独立读回核对通过（`4fbabf`）。本地仅保留当前用户 DPAPI 加密副本；凭据未写入仓库或日志。

操作期间关闭 swap/core dump；完成后卸载两卷并关闭映射，恢复 swap。独立 SSH 读回确认映射已关闭、两项 swap 恢复（`03b0f5`）。没有读取或重建 RSA/发布签名私钥，没有修改业务数据库。

## 实际身份和 OSS 读取

第一次只读核验在当前角色身份校验处失败（`d06521`），保留原报告。独立 STS 诊断（`0afbea`）确认 `AssumeRole` 返回 `role/<角色>/<会话>`，`GetCallerIdentity` 返回 `assumed-role/<角色>/<会话>`，身份类型为 `AssumedRoleUser`、无 `UserId`。修正精确校验后（`5afc4c`），以下六次请求均为 HTTP 200：

| 请求            | Request ID                             | 结果                   |
| --------------- | -------------------------------------- | ---------------------- |
| 用户身份        | `01A0EB33-894D-59E1-998D-8E800315AD2B` | 专用用户、指定账号     |
| 代入角色        | `01A0EB33-8986-5175-ABFC-2B469BDD96E5` | 精确角色与会话         |
| 当前角色身份    | `01A0EB33-89E1-5F5A-A843-6CCE4A0B7282` | 精确 assumed-role 身份 |
| Bucket ACL      | `6ABB30029FA7DD31307AAC18`             | private                |
| Bucket WORM     | `6ABB30029FA7DD3130AAAC18`             | Locked，210 天         |
| Bucket 版本控制 | `6ABB30029FA7DD3130B9AC18`             | Disabled               |

调用使用本地 DPAPI 副本中的同一凭据，经标准输入传入 Node SDK；未读取对象、上传数据、改变云端配置或执行 H1 候选链。本结果证明身份和 bucket 属性读取可用，不代表数据库快照来源、对象读取、R2/R3 或最终发布验收完成。

下载模块已同步修正两种 ARN 的校验、实际读取者记录及写入者别名排除。使用实际响应格式的既有正向用例先复现失败，修正后 Linux 定向文件 11/11 通过（`a416ed`）；该回归使用真实私有文件与合成 SDK 响应，未重跑完整快照恢复链。限定代码审查未发现阻断问题。

## 保留的原始记录

记录位于本工作树忽略目录 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/runner-second-stage/`，不包含凭据明文。以下为 SHA-256：

| 文件                                                | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `ram-installed-verification.json`                   | `732f091b7b9432ea916805cf8c75e013c2c90e30774c2c5dc7ecd0f1dfa56546` |
| `r3-h1-bootstrap-probe-result.json`                 | `e5880bf2d9f2f39fb4c935712d976d6396958e814af61fce77b50665c6adcb8e` |
| `r3-bootstrap-key-creation.json`                    | `735e416e23895f99a9ad3caf55368bf381282f01b6139cb8f06bc91e4e8a509d` |
| `r3-h1-bootstrap-install-result.json`               | `99b01cb710080101ff3fc666ed3f6775842ba8d8a4ea889900bb5820722b6e31` |
| `r3-bootstrap-live-readback-failure.json`           | `ee35cf8a50c0660817f1854d774e412d5e53000a26d5e74898f9eb1cb93f791d` |
| `r3-bootstrap-live-readback-diagnostic-result.json` | `22de1de15ef82b4fd46587de85d0091f944ae95eb875499aadda74eed17c3975` |
| `r3-bootstrap-live-readback-v2-result.json`         | `e58a728ea097d52a7e35b91fbee40152b8d7a6654c714097e175a8b10618739f` |
