# Stage 10D-B0 法大大 API 文档审计与对接矩阵

审计日期：2026-06-25

官方文档来源：[法大大开放平台文档](https://open.fadada.com/index.html#/portal/documentCenter/BGNSHLCYNW/NLVJ5HLAM3VAELPU)

本轮范围：只读审计并输出对接矩阵。未修改业务代码，未修改 Prisma schema，未新增 migration，未调用真实法大大业务接口，未提交 secret。

## 摘要

- 已成功读取法大大官方 SPA 文档。目标 URL 对应“引言”章节，接口细节位于同一官方文档目录树下。
- 当前系统已有 Stage 10D-A 基础：`ContractESignTask`、`ContractESignSigner`、`ContractESignCallbackLog`、`ESignProvider`、`MockESignProvider`、Portal 合同 API、后台合同电子签任务区。
- 法大大当前文档不是“先创建签署任务，再添加签署人”的 REST 工作流；核心是合同编号 `contract_id`、客户编号 `customer_id`、交易号 `transaction_id`、签署页面链接/自动签接口、回调摘要验签。
- 现有模型能承载部分真实 provider 状态和链接，但缺少法大大客户编号、交易号、合同编号、平台印章/授权关系、PDF artifact 生命周期等清晰字段或服务方法。
- 可以进入 Stage 10D-B1 Provider skeleton；B1 不应调用真实接口，不应新增 migration。

## Part A：文档核查

### 版本与环境

| 项目 | 官方文档结果 | 备注 |
| --- | --- | --- |
| 接口版本 | 公共参数 `v` 默认 `2.0` | 少数下载/查看地址场景提到 `2.1` 返回加密地址 |
| 测试环境 base URL | `https://testapi.fadada.com:8443/api/` | 文档“开发指南”章节确认 |
| 正式环境 base URL | TODO | 官方文档要求联系运营人员开启，未给固定公开 URL |
| 请求方法 | 普通接口多为 HTTP POST/GET | POST 普通表单为 `application/x-www-form-urlencoded;charset=UTF-8` |
| 文件上传 | `multipart/form-data;charset=utf8` | 合同上传文件要求 `<=20MB` |

### 认证与签名

| 项目 | 官方文档结果 | 备注 |
| --- | --- | --- |
| access token | 未发现 | 当前文档主流程使用公共参数摘要签名 |
| nonce | 未发现 | 不应臆造 nonce 字段 |
| RSA 私钥/平台公钥 | 未发现 | 不应引入 `PRIVATE_KEY_PATH` / `PUBLIC_KEY_PATH` 作为本版必需项 |
| 公共参数 | `app_id`、`timestamp`、`v`、`msg_digest` | `timestamp` 格式为 `yyyyMMddHHmmss` |
| 摘要算法 | MD5/SHA1 结果转大写后继续计算；通用形态为 `Base64(SHA1(app_id + MD5(timestamp) + SHA1(app_secret + sort)))` | 部分接口有专用公式，必须逐接口实现 |
| body canonicalization | 业务参数按 ASCII/字典升序参与 `sort`，但部分接口指定特殊参数和顺序 | 不应写成全局唯一规则 |

### 回调验签

签署异步通知由法大大向接入方 `notify_url` 发起 HTTP POST，请求格式为 `application/x-www-form-urlencoded;charset=UTF-8`。字段包括：

| 字段 | 含义 | 备注 |
| --- | --- | --- |
| `transaction_id` | 交易号 | 本地应映射到 provider transaction/task 标识 |
| `contract_id` | 合同编号 | 法大大合同编号，不等同于本地 UUID |
| `result_code` | 签章结果代码 | `3000` 成功，`3001` 失败，`3003` 拒签 |
| `result_desc` | 签章结果描述 | 需保存到 callback payload |
| `download_url` | 已签合同下载地址 | 可选 |
| `viewpdf_url` | 已签合同查看地址 | 可选 |
| `timestamp` | 请求时间 | `yyyyMMddHHmmss` |
| `msg_digest` | 摘要 | 公式为 `Base64(SHA1(app_id + MD5(timestamp) + SHA1(app_secret + transaction_id)))` |

页面同步回跳 `return_url` 为 HTTP GET，参数与签署结果类似；拒签同步跳转的摘要公式使用业务参数排序，需单独实现。

### 关键接口清单

| 能力 | 法大大接口 | 文档确认字段/说明 |
| --- | --- | --- |
| 注册账号 | `account_register.api` | `open_id`、`account_type`，返回 `customer_id` |
| 获取个人实名地址 | `get_person_verify_url.api` | 返回 `transactionNo` 和 Base64 编码 URL；认证后可自动绑定 |
| 获取企业实名地址 | `get_company_verify_url.api` | 企业认证套餐、管理员/法人/代理人信息、回调/回跳 |
| 绑定实名信息 | `apply_cert.api` | `customer_id` + `verified_serialno`；绑定成功后才可签署 |
| 合同上传 | `uploaddocs.api` | `contract_id`、`doc_title`、`doc_url` 或 `file`、`doc_type=.pdf` |
| 普通手动签 | `extsign.api` | 页面接口，拼接签署 URL |
| 有效期/次数签署链接 | `extsign_validation.api` | `validity`、`quantity`，适合 Portal signUrl |
| 自动签署 | `extsign_auto.api` | 平台/企业自动盖章；可传 `signature_id` |
| 快捷签/批量签 | `quick_sign.api`、`queryBatchSignUrl.api`、`extBatchSignAuto.api` | 适合批量合同或实名认证+签署融合场景 |
| 查询用户签署结果 | `query_sign_result.api` | 返回 `result`：`3000` 成功、`3001` 失败、`3002` 已撤销、`3003` 已拒签、`9999` 待签署 |
| 查询合同状态 | `contract_status.api` | 返回 `contractStatus`：`0` 待签署、`2` 已完成、`5` 已拒签 |
| 合同下载 | `downLoadContract.api` | 正常直接返回 PDF，异常返回 JSON |
| 临时查看/下载地址 | `geturl.api` | 可设置 `validity`、`quantity`，返回 `download_url` / `viewpdf_url` |
| 合同查看 | `viewContract.api` | 页面接口 |
| 合同归档 | `contractFiling.api` | 签完后归档存证；归档后不能再签署 |
| 拒签 | TODO | 目录为“合同拒签接口”；文档文本出现 `reject_by_contract_id.api`，链接目标显示 `contract_reject_sign.api`，需二次确认 |
| 证据报告下载 | TODO | 未找到独立接口；FAQ 说明归档会生成出证所需证据材料 |

### 错误码

公共错误码需至少覆盖：

| code | msg / 含义 |
| --- | --- |
| `-1` | 暂时无法处理请求/未知异常 |
| `0` | 失败 |
| `1` | 成功 |
| `2` | 重复请求 |
| `1001` | 公共参数非法 |
| `1002` | `app_id` 不存在或未启动 |
| `1003` | `msg_digest` 无效 |
| `1004` | 请求参数非法或必选参数为空 |
| `1005` | 未绑定 IP 白名单 |
| `1006` | 请求频繁 |

## Part B：现有系统映射

### Provider interface

当前 `ESignProvider` 仅包含：

- `createSignTask`
- `getSignerUrl`
- `verifyCallback`

结论：对 Mock 足够，对法大大真实闭环不够。法大大接入至少还需要上传合同 PDF、查询签署结果/合同状态、下载已签 PDF、合同归档、拒签/过期补偿等 provider 能力。B1 可先只新增 skeleton 和签名工具，不扩 schema。

### ContractESignTask

现有字段已有：

- `provider`
- `providerTaskId`
- `providerEnvelopeId`
- `signUrl`
- `signUrlExpiresAt`
- `documentObjectKey`
- `signedDocumentObjectKey`
- `evidenceObjectKey`
- `requestSnapshot`
- `responseSnapshot`
- `callbackSnapshot`
- `errorSnapshot`

结论：任务级 provider、签署链接、已签 PDF、证据 object key 均已有承载位。缺口是语义字段：法大大 `contract_id`、`transaction_id`、`customer_id` 当前只能塞进 provider ids 或 snapshot，不利于查询和幂等。

### ContractESignSigner

现有字段已有：

- `providerSignerId`
- `signUrl`
- `signUrlExpiresAt`
- `signerName`
- `signerPhone`
- `signerIdNoMasked`
- `snapshot`

结论：可承载 signer 级 signUrl 和 provider signer id，但法大大 signer 核心是 `customer_id`，且本地 `customerId` 是 UUID。需要明确 `providerSignerId = 法大大 customer_id`，或后续新增更清晰字段。

### CallbackLog

`ContractESignCallbackLog` 已有 provider、eventType、providerTaskId、payload、verified、handled、errorMessage。可以保存法大大 form payload。

缺口：

- 当前 `handleCallback` 用 `providerTaskId` / `taskNo` 找任务；法大大回调给 `transaction_id` / `contract_id`。
- 当前完成事件集合基于事件名；法大大需要按 `result_code=3000` 判定成功，`3001/3003` 进入失败/拒签分支。

### Signed PDF / evidence file

模型已有 `signedDocumentObjectKey`、`evidenceObjectKey`，`Contract.fileId` 也可关联归档文件。但 StorageService 目前没有专门的合同电子签 artifact put/get 方法，也没有把 `FileObject` 与电子签任务建立外键关系。

### StorageService

现有 StorageService 有 application materials、customer profile materials、service case、vehicle listing、vehicle document、vehicle BaaS contract attachment 等分类。

结论：B4 需要新增合同电子签 artifact 分类，例如：

- 原始待签 PDF
- 已签 PDF
- 法大大归档/存证材料

### Portal 合同页面

Portal 详情页在非 Mock 时会 `window.location.assign(result.signUrl)`，可以承接真实法大大 signUrl。Mock provider 会跳转本地 mock sign 页面。

缺口：

- 目前不展示已签 PDF 下载入口。
- 不展示法大大下载/查看 URL。
- 不展示失败/拒签详情。

### 后台合同详情

后台合同详情可以展示电子签任务列表、provider、taskStatus、signer 状态。缺口是没有展示：

- 法大大 `contract_id` / `transaction_id`
- `download_url` / `viewpdf_url`
- 已签 PDF / evidence object key
- 回调 payload 详情
- provider 原始状态

### Module 装配

当前 `ESignModule` 无条件注入 `MockESignProvider`。即使配置 `ESIGN_PROVIDER=fadada`，实际 provider client 仍是 Mock。

结论：Stage 10D-B1 必须先修正 provider factory，按 `ESIGN_PROVIDER` 注入 Fadada skeleton 或 Mock。

## Part C：对接矩阵

| 系统动作 | 法大大接口 | 本地方法 | 本地模型 | 是否缺字段/方法 | 风险 |
| --- | --- | --- | --- | --- | --- |
| 创建签署任务 | 无同名接口；需串联上传合同和签署链接 | `ESignService.createTaskForContract` | `ContractESignTask` | Provider 缺上传/归档/查询等分步方法 | 不能把法大大理解成“任务 + 添加签署人”模型 |
| 上传/创建合同文件 | `uploaddocs.api` | 当前无 | `documentObjectKey` 可承载本地原件 key | 缺合同 PDF 生成/上传流水 | 当前合同是 snapshot，不是可签 PDF |
| 添加客户签署人 | 法大大使用 `customer_id` | 当前创建 customer signer | `ContractESignSigner.providerSignerId` 可承载 | Customer 层缺稳定 provider customer id | 不能只传本地 customer UUID |
| 添加平台签署方/印章 | `extsign_auto.api`、`signature_id`、印章授权接口 | 当前无平台 signer 创建 | enum 有 `PLATFORM` | 缺平台 signer、seal/signature 配置 | 自动盖章需企业实名、印章、授权 |
| 获取客户签署链接 | `extsign_validation.api` 或 `extsign.api` | `getSignerUrl`、`startPortalSigning` | `signUrl`、`signUrlExpiresAt` | 基本可承接 | 有效期/次数需按法大大参数保存 |
| 接收签署完成回调 | `notify_url` | `handleCallback` | `ContractESignCallbackLog` | 需把 `transaction_id` 映射为 `providerTaskId` | 当前完成判断不适配 `result_code` |
| 查询任务状态 | `query_sign_result.api`、`contract_status.api` | 当前无 | `responseSnapshot` / `callbackSnapshot` 可存原始结果 | 缺 query/status sync provider 方法 | 回调丢失时无法补偿 |
| 下载已签 PDF | `downLoadContract.api`、`geturl.api` | 当前无 | `signedDocumentObjectKey`、`Contract.fileId` | StorageService 缺合同电子签 artifact 方法 | 临时 URL 可能过期 |
| 下载证据报告 | TODO；`contractFiling.api` 触发归档存证 | 当前无 | `evidenceObjectKey` | 官方接口未定位到 | 需要法大大 PDF/Markdown/截图补充 |
| 取消/过期/拒签 | 拒签接口；链接过期由 `validity/quantity` 控制 | 当前无 | `CANCELLED`、`EXPIRED`、`REJECTED` | 缺 provider cancel/reject/expire 方法 | 本地状态机不能直接套用为法大大取消 |

## Part D：凭据清单

以当前官方文档为准，建议准备：

| env | 是否建议 | 说明 |
| --- | --- | --- |
| `FADADA_ENV` | 是 | `sandbox` / `production` |
| `FADADA_BASE_URL` | 是 | 沙箱为 `https://testapi.fadada.com:8443/api/`；生产 TODO |
| `FADADA_APP_ID` | 是 | 官方公共参数 `app_id` |
| `FADADA_APP_SECRET` | 是 | 摘要计算使用 |
| `FADADA_API_VERSION` | 是 | 默认 `2.0` |
| `FADADA_PLATFORM_CUSTOMER_ID` | 是 | 平台企业法大大 `customer_id`，替代原清单 `FADADA_ORG_ID` |
| `FADADA_PLATFORM_SIGNATURE_ID` | 视自动盖章需要 | 法大大 `signature_id`，替代原清单 `FADADA_SEAL_ID` |
| `FADADA_AUTH_PERSON_CUSTOMER_ID` | 视企业章授权需要 | 对应 `outh_customer_id` |
| `FADADA_SIGN_NOTIFY_URL` | 是 | 签署异步回调 `notify_url` |
| `FADADA_SIGN_RETURN_URL` | 是 | 签署同步回跳 `return_url` |
| `FADADA_VERIFY_NOTIFY_URL` | 视实名流程需要 | 实名认证异步回调 |
| `FADADA_VERIFY_RETURN_URL` | 视实名流程需要 | 实名认证同步回跳 |

不建议作为本版必需项：

- `FADADA_PRIVATE_KEY_PATH`
- `FADADA_PUBLIC_KEY_PATH`
- `FADADA_CALLBACK_SECRET`

原因：当前官方文档未发现 RSA 公私钥或独立 callback secret；回调验签使用 `app_secret` 摘要。

不要提交任何真实值。

## Part E：阶段拆分建议

### Stage 10D-B1 Provider skeleton

- 新增 Fadada provider skeleton。
- 新增配置读取和配置缺失错误。
- 新增摘要工具：MD5、SHA1、Base64、大写、业务参数排序。
- `ESignModule` 按 `ESIGN_PROVIDER` 注入 Mock 或 Fadada provider。
- 不调用真实接口。

### Stage 10D-B2 create sign task + sign URL

- 生成或取得可签 PDF。
- 调用 `uploaddocs.api` 上传合同。
- 调用 `extsign_validation.api` 获取客户签署链接。
- 保存 `transaction_id`、`contract_id`、signUrl、有效期。

### Stage 10D-B3 callback verify + idempotency

- 按法大大 `result_code` 和 `msg_digest` 验签。
- 成功、失败、拒签分别映射本地状态。
- 兼容 `transaction_id` 查询本地任务。
- 保持回调幂等。

### Stage 10D-B4 signed PDF / evidence archive

- 下载已签 PDF。
- 调用 `contractFiling.api` 归档。
- 归档到 StorageService。
- 证据报告/存证文件下载等待官方补充。

### Stage 10D-B5 staging real signing validation

- 沙箱账号与沙箱 base URL 验证。
- 平台企业实名。
- 客户实名。
- 印章/授权。
- 公网 HTTPS 回调。

### Stage 10D-B6 production readiness

- 正式 base URL 和运营开通确认。
- IP 白名单。
- 回跳域名。
- 密钥轮换。
- 审计日志、脱敏、告警。

## Part F：风险和阻塞项

| 风险/阻塞项 | 判断 |
| --- | --- |
| 是否需要真实企业认证 | 是。平台企业 `customer_id` 和企业签署/印章能力依赖企业实名 |
| 是否需要印章 ID | 自动盖章需要 `signature_id`；手动签可不一定需要 |
| 是否需要客户实名认证信息 | 是。签署前需要法大大 `customer_id` 绑定实名 |
| 是否需要平台自动盖章权限 | 若平台自动签企业章，则需要 |
| 是否需要回调公网 HTTPS | 是。文档支持 HTTP/HTTPS，但生产建议 HTTPS，且法大大必须能访问 |
| 是否需要 IP 白名单 | 可能需要。错误码包含 `1005` 未绑定 IP 白名单 |
| 是否需要签署回跳域名 | 是。`return_url` 需可访问，部分场景有长度限制 |
| 是否需要合同 PDF 模板调整 | 是。法大大签署基于 PDF、关键字或坐标定位 |
| 是否需要敏感字段加密/脱敏 | 是。身份证、手机号、银行卡等字段应脱敏或按官方 AES256 规则加密 |
| 是否需要新增数据库字段 | B1 不需要；B2-B4 建议新增或明确复用字段保存 provider customer id、transaction id、contract id、signature id、artifact 元数据 |

## Part G：结论

1. 成功读取法大大最新 SPA 文档；目标 URL 是引言，接口细节来自同一官方文档目录树。
2. 关键接口已确认：账号/实名、合同上传、手动签、有效期签署链接、自动签、查询、下载、归档、回调。
3. 认证/签名方式是 `app_id` + `timestamp` + `v` + `msg_digest`，使用 MD5/SHA1/Base64 摘要，不是 access token/RSA/nonce 方案。
4. 回调验签使用 `app_secret` 和回调业务字段摘要；签署成功以 `result_code=3000` 为准。
5. 现有模型可承接部分真实 provider 状态，但 provider interface、module 注入、法大大 id 映射、PDF artifact、下载/归档能力存在缺口。
6. Env 凭据以 `FADADA_APP_ID`、`FADADA_APP_SECRET`、`FADADA_BASE_URL`、平台 `customer_id`、`signature_id`、notify/return URL 为核心。
7. 建议按 B1-B6 渐进对接。
8. 阻塞项包括企业实名、客户实名、印章/授权、公网 HTTPS 回调、IP 白名单、PDF 模板和敏感字段处理。
9. 可以进入 Stage 10D-B1，但 B1 仅做 provider skeleton、配置校验、摘要工具和注入切换，不调用真实法大大接口。

## Stage 10D-B2-A Update

Stage 10D-B2-A has prepared the mockable upload/sign URL code path in `docs/stage-10d-fadada-upload-sign-url-prep.md`. It does not make real Fadada calls. Real sandbox upload/sign URL smoke still requires the B2-B gate: credentials, enterprise/customer `customer_id`, response-code confirmation, endpoint-specific digest confirmation, and public HTTPS notify/return URLs.

## 官方文档章节索引

本次审计读取或定位的官方文档章节包括：

- 引言：`BGNSHLCYNW / NLVJ5HLAM3VAELPU`
- 开发指南：`2YEL4GXZXF / TU0FQ5WZPY78GZGX`
- 接口调用流程：`YDLDOXUCE4 / N4OKGNCPSOT9RS4M`
- 规范：`HWHKFFX1RU / 9Z0XAZIEIPQDFEFG`
- 合同上传：`U09RVJDZKW / 0YGCJ64ZVEEV2OLB`
- 手动签署：`BRGBWEUMV8 / WF0FZHNDK1RLMRMB`
- 自动签署：`MTKGDVFFTS / YYGDYLFKTTDVHTAZ`
- 文档签署接口（含有效期和次数）：`Z37JIZAD6S / WZADETZUJIS4BTPU`
- 新批量快捷签接口：`ADKNI9FCLV / UF9IT4ZNOW8UAP0P`
- 查询用户签署结果接口：`LJ4X6JX0IZ / 74JYFWT2NXOJN2LK`
- 查询合同状态：`K9ZXBZCZGM / SZHNELD8KMR0XEXH`
- 合同下载：`1YEJOHTBV2 / MEKQMHH4DUN5CE63`
- 文档临时查看/下载地址接口：`LQVXHW3UOD / FDUCRZEPR8HJHOI9`
- 合同归档：`O3XZYZSR9C / XVUNBPZQWX37OLEA`
- 签署结果异步通知规范：`IHLWUKC27D / VPRIC7HKFX5VJ4K1`
- 页面跳转规范：`N0Q0OLN5NR / LIVYDN4H1WNFK9WQ`
- 接口错误码列表：`PCLRYTIBS3 / VCWPQI42GMGLR6L9`

## Stage 10D-C1 Production-channel Update

After B0, the reused car-rental production Fadada channel was confirmed for Auto Subscription:

- production host: `https://textapi.fadada.com/api2/`
- allowed contract APIs: `uploaddocs.api`, `extsign_validation.api`, `extsign_auto.api`, `query_sign_result.api`, `downLoadContract.api`, `contractFiling.api`, `contract_status.api`, `geturl.api`, `reject_by_contract_id.api`
- Auto Subscription signing callback and return domains are allowed
- API egress IP whitelist is configured
- current enterprise `customer_id` and `signature_id` are the Auto Subscription seal subject and seal

No already-real-named personal test signer is available. Stage 10D-C1 therefore prepares a controlled test signer through `account_register.api` and `get_person_verify_url.api` before production-host upload/signUrl smoke. `find_personCertInfo.api` is confirmed from the local PDF docs to query by `verified_serialno`, not `customer_id`.
