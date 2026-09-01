# Stage1 S1 证据保管协议

## 适用范围

本协议适用于 source-gate evidence、Manifest、post-state observation、execution proof、启动方记录、脱敏日志与 Release 聚合索引。普通 Runner 文件系统、临时 CI workspace、控制台输出和业务数据库均不属于可信证据存储。

## 固定流程

1. 产生方先拒绝包含原始连接串、凭证、令牌、手机号、客户标识或私钥的证据。
2. 对允许的 I-JSON 值执行 RFC 8785 规范化，并计算 SHA-256 digest 与字节数。
3. 以 `evidence/<sha256>.json` 作为不可覆盖对象身份，由受保护写入身份执行 create-only 上传。
4. 存储端必须返回对象引用、实际字节数、存储时间与保留截止时间；任何不一致均拒绝。
5. 独立 `audit-reader` 身份回读对象，重新计算并核对 digest。
6. 生成 `custody-receipt.v1`，以 `receipts/<receiptId>.json` create-only 上传并再次由审计身份回读。
7. 只有 `assertCustodyComplete()` 验证通过后，状态才是 `CUSTODY_CONFIRMED`。数据库回收和 Release 聚合只能消费已确认收据。

## 信任和访问边界

存储适配器必须声明 `immutable-content-addressed/v1` 信任策略、具名受保护写入身份和独立 `audit-reader`。`scripts/release/custody-evidence.mjs` 不支持任意模块、目录或交互式存储入口；未由受保护流水线注入已批准适配器时直接 fail closed。

对象引用不得包含凭证。人工批准者不会自动获得原始证据读取权限。收据只记录 owner、批准的只读角色、存储对象身份、上传/回读时间、内容 digest、保留截止时间、到期处置和 attestation 引用。

## 保留与到期

- `SUCCEEDED`、`FAILED`、`PREFLIGHT_REJECTED` 和 `INTERRUPTED_UNKNOWN` 使用相同 owner、读取范围、脱敏与 180 日保管规则。
- 保留期内禁止覆盖和删除；`assertCustodyDeletionAllowed()` 必须返回 `EVIDENCE_RETENTION_ACTIVE`。
- 到期处置为 `review` 或 `retain-approved` 时仍须独立批准，不得自动删除。
- 删除或转存需要新的内容寻址记录与收据；不可覆盖不代表永久保留。

## 失败处理

| 错误                                                                   | 处理                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `EVIDENCE_SECRET_DETECTED`                                             | 不上传；只修正产生方的脱敏或引用模型                    |
| `EVIDENCE_OVERWRITE_REFUSED`                                           | 不覆盖既有对象；按既有 operation/receipt 进行 reconcile |
| `EVIDENCE_READBACK_DIGEST_MISMATCH`                                    | 保留数据库和隔离工作区，禁止聚合与回收                  |
| `CUSTODY_RECEIPT_MISSING` / `CUSTODY_RECEIPT_READBACK_DIGEST_MISMATCH` | 不把对象标为已保管；由可信启动方记录失败                |
| `CUSTODY_TRUSTED_STORAGE_ADAPTER_REQUIRED`                             | 说明调用未经过受保护存储入口，不得用本地目录降级        |

上传失败不能用控制台文本或人工复制文件补签。任何重试都保留原失败事实，并使用新的 attempt/run 身份。
