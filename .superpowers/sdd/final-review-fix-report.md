# Final Review Fix Report

日期：2026-07-25
分支：`feat/field-capture-upload-limits`
审查基线：`02b24e1`
实现 commit：`7665cb4 fix(field): address final upload review findings`

## 结论

`final-review-findings.md` 中 4 个 Important 与 3 个 Minor 已全部处理。实现保持照片
10 MiB、视频 300 MiB、磁盘临时文件、原子上传并绑定接口和 Field Cookie 边界不变。
未修改依赖/锁文件、Prisma schema/migrations、PDF/eSign/Fadada、delivery
confirmation、lease、billing、Docker/compose，也未运行 migration deploy/reset。

## Findings

### Important 1：300 MiB 精确边界被 Multer/Busboy 截断

根因证据：

- `field-operator-auth.controller.ts` 原先直接把 Multer `fileSize` 设为
  `MAX_FIELD_EVIDENCE_UPLOAD_SIZE_BYTES`。
- `handover-work-order.service.ts` 已正确使用 `sizeBytes > MAX_*` 作为产品边界，但原测试
  直接调用 service，未经过 multipart parser。
- 小阈值真实 HTTP 测试确认：parser 阈值等于产品边界时会在精确阈值触发截断；阈值设为
  `productMaxSizeBytes + 1` 后，精确产品边界通过，产品边界 `+1` 由 parser 返回 413。

修复：

- 新增 `createFieldEvidenceUploadOptions()`，生产 `fileSize` 使用
  `MAX_FIELD_EVIDENCE_UPLOAD_SIZE_BYTES + 1`。
- 保留 service 的 `> 10 MiB` / `> 300 MiB` 业务检查。
- 新增真实 Nest HTTP -> Multer -> Busboy 测试，测试阈值仅 8 bytes，不创建或读取
  300 MiB 缓冲。

文件：

- `apps/api/src/field-operator/field-evidence-upload-options.ts`
- `apps/api/src/field-operator/field-operator-auth.controller.ts`
- `apps/api/test/field-evidence-multipart.spec.ts`
- 既有 `apps/api/test/handover-work-order.spec.ts` 继续覆盖 service 产品边界。

RED：

```text
pnpm --filter @subscription-saas/api exec vitest run test/field-evidence-multipart.spec.ts
FAIL: Cannot find module field-evidence-upload-options
```

根因验证中的中间 RED：

```text
pnpm --filter @subscription-saas/api exec vitest run test/field-evidence-multipart.spec.ts test/handover-work-order.spec.ts test/field-evidence-upload-cleanup.spec.ts
FAIL: +1 实际返回 413；file + replacement 在 parts=2 时实际返回 400
```

GREEN：

```text
同一聚焦命令：3 files passed, 47 tests passed
最终 multipart 隔离命令：1 file passed, 6 tests passed
```

### Important 2：中断不确定态未做权威对账

根因证据：

- 原 `interruptFieldEvidenceUploadBatch()` 在 `fileIndex === 0` 时直接进入
  `RETRY_PENDING`，不刷新；请求即使已在服务端提交也会被重复重试。
- 原 `refreshDetail()` 只返回 boolean，批处理控制器无法区分当前文件已提交或未提交。
- 原状态只按数组 index 截取队列，没有保存当前资料项上传前后的 evidence file IDs/count。
- 原页面把取消按钮保留到整个 XHR 响应结束，没有“请求体完成、服务端处理中”阶段。
- 原 unmount 分支主动把批次清成 IDLE，并跳过权威刷新。

修复：

- 批次保存当前资料项基线 `{ ids, count }`；每个成功响应推进基线。
- 所有已发送请求的 failure/cancel/unmount 都先进入 `REFRESHING`。
- 刷新后以 ID/count 比较当前文件是否提交：
  - 多文件追加：count 或 ID 集合增加时移除当前文件，保留后续文件。
  - 单文件替换：count 可不变，以旧/new evidence ID 变化判断替换已提交。
  - 无变化时保留当前文件和后续文件。
- 刷新失败进入 `REFRESH_FAILED`，保留屏障、基线和不确定队列；重新刷新成功后再对账。
- XHR `upload.onload` 驱动 `PROCESSING` 阶段；页面显示“服务端处理中”并移除用户取消入口。
- unmount 中断保持静默反馈，但仍执行权威刷新。

文件：

- `apps/web/src/lib/field-handover-upload-batch.ts`
- `apps/web/src/app/field/handover/tasks/[id]/page.tsx`
- `apps/web/test/field-handover-upload-reconciliation.spec.ts`
- `apps/web/test/field-handover-pages.spec.ts`

RED：

```text
pnpm --filter @subscription-saas/web exec vitest run test/field-handover-api.spec.ts test/field-handover-upload-reconciliation.spec.ts test/field-handover-upload.spec.ts test/field-handover-view-model.spec.ts
FAIL: 12 tests（首次刷新、追加对账、替换对账、刷新失败、unmount、处理态等）
```

GREEN：

```text
pnpm --filter @subscription-saas/web exec vitest run test/field-handover-pages.spec.ts test/field-handover-api.spec.ts test/field-handover-upload-reconciliation.spec.ts test/field-handover-upload.spec.ts test/field-handover-view-model.spec.ts
PASS: 5 files, 43 tests
```

### Important 3：multipart fields/parts/fieldSize 无界

根因证据：

- 原 Multer limits 仅有 `fileSize` 与 `files: 1`。
- 真实 Busboy 测试确认 `parts=2` 会误伤正常的“1 file + 1 replacement field”，所以与
  fileSize 一样需要 parser 哨兵阈值。

修复：

- `files: 1`
- `fields: 1`
- `fieldSize: 128` bytes，足够容纳唯一可选 UUID replacement 字段。
- `parts: 3`：允许最多两个业务 part，第三个 part 触发 Busboy 限制。
- 真实 multipart 测试覆盖正常 replacement、超长 field、额外 field、额外 file，以及
  单独隔离的 parts flood。

RED/GREEN：

```text
初次 GREEN 尝试：parts=2 使正常 replacement 请求返回 400（RED）
修复为 parts=3 后：正常 2 parts 返回 201
隔离 parts 测试初次按 413 断言失败；确认 Nest 将 LIMIT_PART_COUNT 映射为 400
最终：field-evidence-multipart.spec.ts 6/6 PASS
```

### Important 4：Safari 进度顺序与 loaded/total 不可信

根因证据：

- 原实现先调用 `xhr.open()`，再注册 `xhr.upload.onprogress`。
- 原实现只在 `lengthComputable=false` 时回退 `File.size`，会信任异常 `event.total`。
- 原实现不清洗 NaN、负数或超过文件大小的 `event.loaded`。

修复：

- 在 `open()` 前注册 `upload.onprogress` 与 `upload.onload`。
- `totalBytes` 始终使用所选 `File.size`。
- `loaded` 对非有限值回退 0，并 clamp 到 `[0, File.size]`。
- 测试覆盖 `lengthComputable=false`、异常 total、loaded 超上限、NaN 与负数，并记录监听
  注册顺序。

RED/GREEN：

```text
RED: listener index 在 open 之后；异常事件报告 loaded=50,total=1；onUploadComplete 未调用
GREEN: field-handover-api.spec.ts 全部通过
```

### Minor 1：API 缺少 client_body_timeout

根因证据：两个 Nginx API TLS host 已有 320m 与 1200s proxy timeout，但没有
`client_body_timeout`；Admin host 不应改变。

修复：仅在 staging/production API TLS server block 增加
`client_body_timeout 1200s`。

检查：

```text
rg -n "server_name|client_max_body_size|client_body_timeout|proxy_request_buffering|proxy_read_timeout|proxy_send_timeout" nginx/...
git diff -- nginx/staging-subauto.example.conf nginx/production-subauto.example.conf
```

结果：API host 有 320m/1200s/body buffering off；Admin 仍为 20m 与原 timeout，且没有
新增 client_body_timeout。

### Minor 2：上传业务错误被通用文案覆盖

根因证据：

- XHR parser 只接受 string `message`，不接受 Nest 常见的 string[]。
- 页面 `onUploadInterrupted` 对所有非取消错误强制传入“上传失败，请重试”，覆盖已解析的
  `ApiError.message`。

修复：

- XHR 安全解析 string 或 string[] `message`，忽略非字符串字段。
- 非取消错误不再传 fallback，交给 `getFieldHandoverActionErrorMessage()` 保留业务消息；
  用户取消保留专用文案。
- 测试覆盖数组形式的 10MB/任务不可编辑业务错误。

### Minor 3：UI 契约仅源码断言

根因证据：Web 仅有 Vitest，没有 React Testing Library/jsdom 组件测试设施；原测试主要
读取 TSX 源码查字符串。

修复：

- 未增加依赖。
- 提取并执行测试 `buildFieldEvidenceUploadInputContracts()`，覆盖照片、视频、混合媒体的
  camera/library、`capture=environment`、camera 单文件与 library multiple。
- 提取并执行测试 `cancelFieldEvidenceUploadRequest()`，证明先写入取消原因再 abort。
- view-model 可执行测试确认 locked task 的 start/save/submit 与所有 evidence upload
  action 均隐藏。
- TSX 源码契约仅保留组件接线、处理态和敏感功能边界；行为由上述控制器/契约测试覆盖。

## 最终验证

```text
pnpm --filter @subscription-saas/web typecheck
PASS

pnpm --filter @subscription-saas/web lint
PASS

pnpm --filter @subscription-saas/web exec vitest run \
  test/field-handover-api.spec.ts \
  test/field-handover-pages.spec.ts \
  test/field-handover-upload.spec.ts \
  test/field-handover-upload-reconciliation.spec.ts \
  test/field-handover-view-model.spec.ts
PASS: 5 files, 43 tests

pnpm --filter @subscription-saas/api typecheck
PASS（只执行现有 shared build / prisma generate；未运行 migration）

pnpm --filter @subscription-saas/api lint
PASS

pnpm --filter @subscription-saas/api exec vitest run \
  test/field-evidence-multipart.spec.ts \
  test/handover-work-order.spec.ts \
  test/field-evidence-upload-cleanup.spec.ts \
  test/field-operator-auth.spec.ts
PASS: 4 files, 60 tests

git diff --check
PASS（无输出）
```

## 自审

- 所有不确定的已发送上传请求先刷新；刷新失败不开放 retry/submit。
- 多文件追加与单文件替换均以权威 ID/count 对账。
- 成功响应后的下一文件以最新 evidence 快照为基线。
- 请求体完成后只显示服务端处理态，不显示用户取消。
- multipart exact/+1、fields、fieldSize、files、parts 均通过真实入口测试。
- multipart 测试最大文件 9 bytes，不分配 300 MiB 测试缓冲。
- Nginx 修改仅作用于 API TLS host。
- `git diff` 未包含任何受禁止文件或模块。
- 未 amend、未 push。

## 未解决项

无未解决 finding。

真实 iPhone Safari、微信内置浏览器和 Edge 的设备人工验收未在本地自动化环境执行；本次已
用可执行 XHR 顺序/数值测试与输入契约测试覆盖可自动化边界，不影响本次审查 findings 的
关闭。
