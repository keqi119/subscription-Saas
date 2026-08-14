# 现场交接视频可恢复分片上传设计

## 1. 背景与问题证据

Stage 2 现场交接要求车辆环绕视频单文件不超过 `300 MiB`。现有实现通过微信 iOS WebView 的 `XMLHttpRequest + FormData` 把完整视频一次性发送至 Staging API，再由 Nginx 转发、Multer 落盘并上传 OSS。

2026-08-15 人工验收中，用户在微信 iOS 内置浏览器选择约 `226.9 MB` 的 `IMG_0284` 后，页面返回 `/field/handover`，未显示任何错误。线上只读取证得到以下事实：

- Staging API Nginx 实际配置为 `client_max_body_size 320m`、`client_body_timeout 1200s`、`proxy_request_buffering off`，读写超时均为 `1200s`。
- Web、API 和 Multer 的视频上限仍为 `300 * 1024 * 1024` 字节。
- API 容器磁盘剩余约 `14 GB`，上传时没有应用异常或存储错误。
- `IMG_0284` 没有进入 Nginx access/error log、API log 或数据库；连上传预检 `OPTIONS` 请求都没有产生。
- 同一设备、同一微信 WebView 随后成功上传 `IMG_0203.mov`，文件大小 `200,922,411` 字节（约 `191.6 MiB`），API 返回 `201` 并成功入库。

因此，失败发生在微信 iOS WebView 把完整大文件交给单次 XHR 之前。继续扩大 Nginx、Multer 或业务上限无法解决该问题。现有“整文件单请求”架构不能可靠兑现移动端 `300 MiB` 的端到端能力。

## 2. 目标与验收口径

### 2.1 目标

- 微信 iOS 内置浏览器中，单个不超过 `300 MiB` 的车辆环绕视频无需压缩即可上传。
- 页面刷新、WebView 重载、重新登录、网络中断或 API 重启后，用户重新选择同一文件即可继续缺失分片。
- 浏览器只访问现有 API 域名，不获得 OSS bucket、object key、uploadId、ETag 或访问凭证。
- 沿用现有 FFprobe、最低 `720p`、关键帧生成、证据绑定、替换和审核逻辑。
- 上传全过程提供持久、明确的状态和错误信息，不再无提示返回或从零重传。

### 2.2 明确不做

- 不承诺退出微信后在后台继续上传；浏览器离开时上传暂停。
- 不改变照片上传、交接资料清单、审核流程或 `300 MiB` 总文件上限。
- 不引入浏览器直传 OSS，不向客户端暴露内部存储结构。
- 不对视频进行客户端压缩或转码。
- 不将大文件或生成的大文件固件提交至 Git。

## 3. 方案选择

采用 **API 托管的 OSS Multipart Upload**：

1. Web 把视频切成固定 `8 MiB` 分片。
2. 每个分片作为独立小请求上传至现有 API 域名。
3. API 校验并把分片转交 OSS Multipart Upload，同时在数据库记录完成状态。
4. 所有分片完成后，服务端合并 OSS 对象，执行视频质量处理并绑定证据。

未采用的方案：

- API 容器本地拼接：容器重建、扩容或迁移会丢失进度，需要额外持久卷和粘性路由。
- 浏览器直传 OSS：虽然节省 API 带宽，但扩大签名、CORS、bucket 和 object key 暴露面，违反当前受控文件访问边界。
- 降低移动端上限或要求压缩：不满足已经确认的 `300 MiB` 验收口径。

## 4. 总体架构

### 4.1 上传策略

- 照片继续使用现有单文件上传端点。
- 新 Web 对所有视频统一使用分片上传，不按文件大小分流，避免同一功能存在两套不一致的视频行为。
- 旧视频上传端点暂时保持兼容，保障 API 先发布、Web 后发布期间旧 Web 仍可工作。
- 单片大小固定为 `8 MiB`，`300 MiB` 视频最多 `38` 片。
- 每次只上传一个分片；本轮不引入并行分片，优先降低微信 WebView 内存峰值和移动网络竞争。

### 4.2 数据流

1. 用户选择视频；Web 校验媒体类型和总大小。
2. Web 只根据文件名、大小、MIME、最后修改时间生成恢复指纹；创建服务端上传会话前不读取任何视频二进制内容，避免微信 iOS 对大体积相册文件的预读取导致页面被系统回收。
3. API 创建或恢复上传会话，返回不透明会话 ID、分片大小、总片数、已完成片号和过期时间。
4. Web 对缺失分片逐片计算 SHA-256，依次上传。
5. API 把单片写入短生命周期临时文件，校验大小和 SHA-256，再调用 OSS `uploadPart`；成功后保存 ETag 并删除本地分片。
6. 全部分片完成后，Web 请求完成上传；API 把会话置为 `FINALIZE_QUEUED` 并立即返回 `202`。
7. API 内的数据库轮询工作器领取会话，完成 OSS Multipart、下载完整对象至临时文件并调用现有视频处理服务。
8. FFprobe、最低 `720p` 和关键帧处理通过后，在事务中创建 `FileObject`、证据文件和交接事件，并把会话置为 `COMPLETED`。
9. Web 轮询会话状态；完成后刷新交接资料卡。

### 4.3 完成阶段幂等性

完成阶段按可恢复状态推进：

`FINALIZE_QUEUED -> OSS_COMPLETING -> OBJECT_READY -> PROCESSING -> COMPLETED`

- 每一阶段成功后先持久化，再进入下一阶段。
- 工作器通过租约字段独占会话；租约过期后其他工作器可恢复。
- OSS 已合并但 API 重启时，从 `OBJECT_READY` 继续，不重复完成 Multipart。
- 视频已处理但事务未绑定时，重新从内部对象生成或核对派生物，再以证据绑定唯一约束保证不重复入库。
- 完成请求和状态查询均为幂等操作。
- 状态查询只校验当前现场人员对任务和车辆环绕视频资料项的访问权，不重复校验创建会话时冻结的替换目标；替换完成后旧文件正常失效，不得让最后一次状态轮询误报上传失败。

## 5. 数据模型

### 5.1 `FieldEvidenceVideoUploadSession`

新增视频上传会话模型，至少包含：

- `id`：UUID，仅此不透明值返回浏览器。
- `workOrderId`、`evidenceItemId`：任务和资料项归属。
- `createdBySessionId`：创建时的现场操作员会话，用于审计；恢复授权仍以当前登录手机号与任务分配关系为准。
- `originalName`、`mimeType`、`sizeBytes`、`lastModifiedMs`。
- `fingerprintHash`：文件名、大小、MIME 和最后修改时间等元数据的 SHA-256；仅用于同一资料项未完成会话的文件重选匹配，不作为文件内容完整性校验。
- `replaceEvidenceFileId`：可空；创建时冻结的替换目标。
- `chunkSizeBytes`：固定 `8 MiB`。
- `totalParts`：`1..38`。
- `status`：上传及完成状态。
- `ossUploadId`、`objectKey`、`objectEtag`：仅服务端使用。
- `failureCode`、`failureMessage`、`resumeStage`：可恢复失败信息。
- `leaseOwner`、`leaseExpiresAt`：完成工作器租约。
- `expiresAt`：创建或最近有效活动后 `24` 小时。
- `objectCompletedAt`、`processingCompletedAt`、`completedAt`、`cancelledAt`。
- `version`、`createdAt`、`updatedAt`。

状态枚举：

- `UPLOADING`
- `FINALIZE_QUEUED`
- `OSS_COMPLETING`
- `OBJECT_READY`
- `PROCESSING`
- `RETRYABLE_FAILED`
- `VALIDATION_FAILED`
- `COMPLETED`
- `CANCELLED`
- `EXPIRED`

同一资料项同时只能有一个非终态会话。迁移使用 PostgreSQL partial unique index 约束该规则；服务层事务校验作为第二道防线。

### 5.2 `FieldEvidenceVideoUploadPart`

新增分片模型：

- `id`
- `sessionId`
- `partNumber`：从 `1` 开始。
- `sizeBytes`
- `sha256`
- `ossEtag`
- `completedAt`
- `createdAt`、`updatedAt`

唯一约束为 `(sessionId, partNumber)`。重复提交相同编号、大小和哈希时直接返回已有结果；内容不一致返回 `409`。

### 5.3 保留与清理

- 数据库中的会话和分片记录不在本轮物理删除，作为上传和失败审计依据。
- 终态会话不再持有可用 OSS Multipart 会话；过期或取消时立即 abort 未完成 Multipart。
- 已合并但未绑定的源对象及派生物在失败时删除。
- 浏览器恢复标记在完成、取消、校验失败或过期后删除。

## 6. API 设计

所有端点继续使用 `FieldOperatorAuthGuard`，并再次校验当前手机号仍被分配至该任务、资料仍可编辑。

### 6.1 创建或恢复会话

`POST /api/field/handover/work-orders/:id/evidence/:itemId/video-upload-sessions`

请求包含：文件名、MIME、大小、最后修改时间、恢复指纹及可选替换文件 ID。

响应包含：会话 ID、状态、`chunkSizeBytes`、`totalParts`、已完成片号、过期时间和面向用户的安全错误信息。

- 文件超过 `300 MiB` 立即返回 `413`。
- MIME、扩展名和资料项允许类型不匹配时返回 `400`。
- 相同指纹且存在有效会话时恢复该会话。
- 其他文件已有有效会话时返回 `409`，要求用户继续原文件或先取消旧会话。

### 6.2 上传分片

`POST /api/field/handover/work-orders/:id/evidence/:itemId/video-upload-sessions/:sessionId/parts/:partNumber`

- multipart 字段名为 `file`，单片硬上限 `8 MiB + 1 byte`。
- 请求头包含 `X-Chunk-SHA256`。
- API 校验分片编号、预计大小、哈希、会话状态、任务归属和总文件边界。
- 成功只返回片号、大小和完成时间，不返回 OSS ETag。

### 6.3 查询状态与恢复清单

- `GET .../video-upload-sessions/:sessionId`
- `GET /api/field/handover/video-upload-sessions/active`

恢复清单只返回会话 ID、任务 ID、资料项标题、文件名、大小、状态、进度和过期时间，不返回内部存储信息。

### 6.4 完成、重试和取消

- `POST .../video-upload-sessions/:sessionId/complete`：校验全部分片，置为 `FINALIZE_QUEUED`，返回 `202`。
- `POST .../video-upload-sessions/:sessionId/retry`：只允许 `RETRYABLE_FAILED`，从 `resumeStage` 重新排队。
- `DELETE .../video-upload-sessions/:sessionId`：二次确认后调用，置为 `CANCELLED` 并清理 OSS 临时内容。

## 7. OSS 与视频处理改造

扩展受控 OSS provider，仅在 API 内部增加：

- `initMultipartUpload`
- `uploadPart`
- `completeMultipartUpload`
- `abortMultipartUpload`
- 已完成对象存在性及元数据核验

源对象使用仅服务端可见的会话前缀。Multipart 完成后，该对象直接成为待绑定源对象，避免再次把完整视频上传 OSS。

现有视频处理服务扩展为接受“已存储源对象 + 本地临时路径”。工作器从 OSS 流式下载到临时文件后继续执行现有 FFprobe、分辨率校验和关键帧生成。处理通过前不改变现有证据；事务失败时删除新源对象和新派生物。

## 8. Web 交互设计

现有交接资料清单和上传按钮保持不变。视频资料卡新增持久进度区：

- 文件名和大小。
- 总体百分比、已完成分片数，例如 `18/29`。
- 阶段文案：上传中、OSS 合并中、清晰度校验中、关键帧生成中、已完成。
- `暂停上传`：中止当前分片请求，保留服务端会话。
- `取消本次上传`：二次确认后终止并清理会话。
- `继续上传`：网络失败后继续缺失分片。
- `重试处理`：仅处理阶段可恢复失败时展示。

Web 在选择文件后、创建大请求前，把以下恢复信息写入 `localStorage`：会话 ID、任务 ID、资料项 ID、文件名、大小、最后修改时间、恢复指纹和过期时间。不保存文件内容或 OSS 信息。

`/field/handover`、任务列表和任务详情都会查询有效恢复记录并显示：

> 检测到未完成的视频上传。进入原任务并重新选择同一文件后可继续。

浏览器安全模型不允许页面重载后重新取得本地文件句柄，因此用户必须重新选择原文件。指纹不一致时不得续传；用户可返回重选，或确认取消旧会话后开始新上传。

上传或处理期间禁止重复上传、删除同一资料和提交交接；其他资料仍可查看。错误信息持续显示在资料卡内，同时可辅以 Toast，但不只依赖 Toast。

## 9. 错误处理

### 9.1 分片阶段

- 网络错误和 `5xx`：当前分片指数退避自动重试 `3` 次，已完成分片不重传。
- `401`：保留恢复记录，跳转登录；重新登录后返回原任务。
- `409 CHUNK_CONTENT_CONFLICT`：停止上传，要求重新选择原文件或取消会话。
- `413 VIDEO_TOO_LARGE`：明确提示单个视频不得超过 `300 MiB`。
- 会话过期：明确提示上传记录已过期，需要重新开始。

### 9.2 完成阶段

- OSS 或临时网络故障：置为 `RETRYABLE_FAILED` 并记录 `resumeStage`。
- 低于 `720p`、损坏或无法识别：置为 `VALIDATION_FAILED`，显示现有可操作提示，删除未绑定对象。
- 替换目标已变化：返回 `EVIDENCE_MUTATION_CONFLICT`，不覆盖当前证据。
- 完成工作器崩溃：租约到期后从最后持久化阶段恢复。

错误响应不得包含 bucket、object key、uploadId、ETag、本地路径、堆栈或存储凭证。

## 10. 清理与可观测性

- API 启动一个轻量数据库轮询工作器，负责领取完成会话和清理过期会话，沿用项目现有数据库租约工作器模式，不引入 Redis 或新中间件。
- 过期清理先 abort Multipart，再删除已完成但未绑定对象，最后置为 `EXPIRED`。
- 每个分片临时文件在 OSS `uploadPart` 成功或失败后都通过 `finally` 删除。
- 完整视频处理临时文件及关键帧临时文件沿用现有 cleanup 机制。
- 结构化日志记录会话 ID、任务 ID、资料项 ID、状态、分片编号、耗时和安全错误码；不记录手机号明文或 OSS 内部标识。
- 交接事件记录会话创建、恢复、取消、完成、失败和最终证据替换。

## 11. 发布与回滚

发布顺序：

1. 应用新增数据库迁移。
2. 部署兼容旧端点、同时提供新分片端点和工作器的 API。
3. 验证迁移、API 健康和 OSS Multipart 预检。
4. 部署统一使用视频分片上传的新 Web。
5. 完成微信 iOS 实机验收。

迁移只新增枚举、会话表、分片表和索引，不修改现有证据记录。若 Web 回滚，旧 Web 仍可调用旧上传端点；若 API 回滚，新增表保留且不影响旧代码。回滚前先停止新会话，等待或取消正在处理的会话。

## 12. 测试设计

### 12.1 Web 单元测试

- `300 MiB` 整限通过，`300 MiB + 1 byte` 被拒绝。
- `8 MiB` 切片和最后一片大小正确。
- 恢复指纹无需读取视频二进制内容，并可在创建上传会话前稳定生成。
- 已完成片号被跳过，进度按总文件计算。
- 当前分片网络失败自动重试三次。
- 暂停、继续、取消、重新登录和重新选择原文件状态转换正确。
- 指纹不匹配不续传。
- 恢复卡片在入口页、任务列表和详情页正确显示。
- 状态和错误持久显示，不只触发 Toast。

### 12.2 API 单元与集成测试

- 创建、恢复、单活会话和 `24` 小时过期规则。
- 每片大小、编号、SHA-256、总大小和媒体类型校验。
- 相同分片幂等，不同内容冲突。
- 当前操作员、任务分配、资料项和可编辑状态鉴权。
- OSS Multipart 初始化、上传片、合并、abort 和失败补偿。
- 工作器租约、API 重启、阶段恢复和重复执行幂等。
- `720p` 及以上通过；低清、损坏和不可解析视频失败。
- 替换失败保留旧证据；成功后才使旧文件失效。
- 未授权、跨任务和篡改会话全部拒绝。
- 响应和日志不暴露 OSS 内部字段。
- 照片上传及旧视频端点回归测试保持通过。

大文件测试通过稀疏文件、生成视频和 OSS fake 执行，不向仓库提交大二进制文件。

## 13. Staging 实机验收

1. 在微信 iOS 内置浏览器选择约 `226.9 MB` 的 `IMG_0284`。
2. 确认显示分片和总体进度，最终成功绑定车辆环绕视频。
3. 上传约 `40%` 后关闭页面，再进入任务并重新选择原文件，确认只继续缺失分片。
4. 上传中重新登录一次，确认恢复提示和续传有效。
5. 完成后核对文件名、大小、视频分辨率、关键帧、资料状态和事件审计。
6. 使用低于 `720p` 的视频尝试替换，确认显示明确提示且原视频不受影响。
7. 检查 Nginx、API、数据库和 OSS，确认没有遗留临时分片、未绑定对象或本地临时文件。

通过标准：以上场景全部成功，`300 MiB` 整限自动化测试通过，`300 MiB + 1 byte` 被明确拒绝，且整个过程不再无提示跳转或从零重新上传。
