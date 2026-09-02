# S1 脱敏快照受控导出

## 目的和边界

本流程只为 Release CI 生成可复核的 Staging 类脱敏快照。它不修改 Staging，不属于应用运行时，也不形成 build proof、Environment Manifest 或 Runner execution proof。

唯一入口是 `Protected sanitized snapshot` 工作流。该工作流只能从 `main` 手工触发，使用受保护环境 `stage1-snapshot-export` 和带同名标签的隔离自托管 Runner。普通 PR、通用 CI 和 API 容器不能取得该环境或来源身份。

## 受信适配器前置条件

隔离 Runner 必须预装固定路径 `/opt/subscription-saas/snapshot-adapter/v1/index.mjs`。适配器负责解析两个引用，而不是把原始连接串或密钥交给仓库脚本：

- `secret://stage1-snapshot-export/source`：只读 Staging 身份；
- `secret://stage1-snapshot-export/tokenization-key`：隔离副本内使用的令牌化密钥。

适配器必须实现 `protected-snapshot-adapters/v1`，并提供来源、临时脱敏数据库、不可改写发布器和最终发布检查。不得通过环境变量、工作流输入或请求 JSON 接受原始数据库连接串。

来源身份不得拥有 `SUPERUSER`、`CREATEDB`、`CREATEROLE`、`BYPASSRLS`、Schema ownership/CREATE、表写入/TRUNCATE 或可写函数 EXECUTE 权限。任何一项不满足均在导出前关闭失败。

## 执行顺序

1. 校验 repository contract 和版本化 sanitization contract。
2. 在 Staging 上开启 `REPEATABLE READ, READ ONLY, DEFERRABLE` 事务，记录权限和来源指纹。
3. 从同一 MVCC snapshot 导出原始内容到隔离工作区；原始内容不得上传。
4. 恢复至临时数据库，只在临时数据库执行版本化转换。
5. 导出最终快照并执行敏感信息扫描。
6. 在仍保持的来源 snapshot 上再次计算指纹；任何变化均拒绝发布。
7. 不可改写地发布最终 dump、metadata、权限/指纹观察、扫描证明和 custody receipt，并逐项读回验证。
8. 无论成功或失败，都关闭来源事务、销毁临时数据库并清理本地工作区。

## 成功证据

成功产物严格限于以下六项：

- `sanitized-snapshot.dump`
- `snapshot-metadata.v1.json`
- `source-privilege-observation.v1.json`
- `source-fingerprint.v1.json`
- `sanitization-scan.v1.json`
- `custody-receipt.v1.json`

metadata 必须仍在有效期内，dump、contract、扫描对象、来源迁移 head 与两个来源指纹必须一致。custody receipt 必须证明不可覆盖写入、读回 digest 一致、owner/readers 正确以及保留期完整。

## 停止条件

遇到权限过高、未知 migration head、来源指纹变化、扫描发现、部分发布、custody 不完整或清理失败时立即停止。不得上传原始或部分脱敏文件，不得改用写权限来源身份，不得在 Staging 原地执行转换，也不得人工修改 metadata 后继续使用。
