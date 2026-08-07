# 车辆资产详情页签改造验收记录

## 基线信息

- 验收分支：`feat/vehicle-asset-detail-tabs-20260808`
- 功能完成提交：`3bc768020c273b63e291a7ebf6e68ac9bcce69f8`
- 自动化稳定性提交：`edbd825936cf532dba43dfe23221380f5cf47bfe`
- Staging 镜像提交：`e399457`
- 测试车辆：`VEH20260731152647G5GV`（`aeb941f4-0538-41a8-b3ca-822f6c9d8fb5`）
- Portal 已发布回归车辆：`VEH20260807061849KRNM`（`3f04c8a9-f485-4830-b5d9-c91b29ad7ff9`）
- 验收开始时间：`2026-08-08 03:30:50 +08:00`
- 验收结束时间：`2026-08-08 05:09:52 +08:00`
- 验收结果：**通过（带非阻塞暂缓项）**

## 数据库与迁移

| 检查项 | 状态 | 证据/备注 |
| --- | --- | --- |
| 工作区状态与目标分支确认 | 通过 | `feat/vehicle-asset-detail-tabs-20260808`，任务实现与证据提交范围一致。 |
| 本地 `prisma migrate status` | 通过 | 87 migrations；Database schema is up to date。 |
| `prisma validate` / `prisma generate` | 通过 | Schema valid；Prisma Client v7.8.0 生成成功。 |
| 目标数据库连接为本地/测试库 | 通过 | PostgreSQL `127.0.0.1:5432/subscription_saas`，schema `public`。 |
| 本地目标迁移仅应用一次 | 通过 | `20260808010000_vehicle_document_workspace` 完成且未回滚记录为 1。 |
| Staging 目标迁移仅应用一次 | 通过 | `2026-08-08 05:10 +08:00` 复核 `_prisma_migrations` 完成且未回滚记录为 1。 |
| migrate deploy 后 schema up to date | 通过 | 本地无待执行迁移；Staging 迁移先于新 API/Web 容器切换。 |

## 自动化验证

| 检查项 | 状态 | 证据/备注 |
| --- | --- | --- |
| 聚焦 API 测试 | 通过 | 4 个测试文件、68 项测试全部通过。 |
| 聚焦 Web 工作区测试 | 通过 | 9 个测试文件、71 项测试全部通过。 |
| `pnpm quality:gate` | 通过 | 专用测试库 `127.0.0.1:55432/subscription_saas_codex`；235/235 测试文件、2774/2774 测试通过；lint、Prisma、API/Web typecheck、迁移状态通过。 |
| `pnpm build` | 通过 | shared、Nest API、Next Web 全部构建成功；60 个页面生成成功。 |
| `git diff --check` | 通过 | 无空白错误。 |
| 路由构建 | 通过 | `/vehicles` 为静态路由，`/vehicles/[id]` 与 `/portal/catalog/[id]` 为动态路由。 |

门禁首次执行暴露出专用测试库容器停止及根 `.env` 未注入问题；恢复既有 `subscription-saas-codex-postgres` 后，测得数据库时钟领先宿主机约 809ms。将“明确过期租约”的测试夹具从数据库时钟前 1 秒调整为前 10 秒后，该文件连续 3 次 8/8 通过，完整门禁随后通过；业务实现未因该稳定性修正发生变化。

## Staging 发布记录

| 检查项 | 状态 | 证据/备注 |
| --- | --- | --- |
| 发布前 API/Web 镜像 | 通过 | API/Web 均为 `Staging-20260807-7fb2465`。 |
| 数据库备份 | 通过 | `/opt/subscription-saas/backups/subscription_saas_staging_vehicle_tabs_20260808040349.dump`；2,245,492 bytes；SHA256 `22d133991b068cd3e0c0b0edbe6c8c1ae79e280fe0ea32040bb88cfbd48d830a`；`pg_restore -l` 校验通过。 |
| 环境文件备份 | 通过 | `/opt/subscription-saas/.env.staging.images.bak.vehicle-tabs-20260808040349`。 |
| 迁移先于应用镜像发布 | 通过 | 迁移 `20260808010000_vehicle_document_workspace` 成功后再切换 API/Web。 |
| API/Web 使用同一提交构建 | 通过 | `Staging-20260808-e399457`；GitHub Actions [run 31213941304](https://github.com/keqi119/subscription-Saas/actions/runs/31213941304) 成功。 |
| API 镜像 | 通过 | `ghcr.io/keqi119/subscription-api:Staging-20260808-e399457`；digest `sha256:73d8c6db81dbd34e14f23e65bd51c4e14d507e653f2d787ad2a100f7002f8095`。 |
| Web 镜像 | 通过 | `ghcr.io/keqi119/subscription-web:Staging-20260808-e399457`；digest `sha256:42d9e678957268e05b9ed2353953db5596e07eacdf3566d55d004b3a4604c496`。 |
| `/health` | 通过 | `2026-08-08 05:09:52 +08:00` 返回 200，`status=ok`、`storage=oss`。 |
| Admin 登录 | 通过 | API 登录 201、浏览器登录成功。失效的 staging admin 密码已受控重置并写审计；密码未记录到本文。环境备份：`/opt/subscription-saas/.env.staging.images.bak.admin-recovery-20260808043322`。 |
| Portal 商品目录加载 | 通过 | `/portal/catalog` 返回 200，公开商品详情加载成功。 |
| 容器健康 | 通过 | staging API/Web 均 `healthy`。production API/Web 仍为 `production-20260714-0e89ad1` 且 `healthy`，未被本次发布改动。 |

## Admin 验收矩阵

| 检查项 | 状态 | 证据/备注 |
| --- | --- | --- |
| 台账仅显示“车辆列表”和“待销售价格复核” | 通过 | 浏览器实测仅 2 个页签，车辆列表 9、待复核 0。 |
| 行/详情入口打开独立 `/vehicles/:id` | 通过 | 指定车辆打开 `/vehicles/aeb941f4-0538-41a8-b3ca-822f6c9d8fb5?tab=overview`。 |
| 六个一级页签均可加载 | 通过 | 概览、权证、保险与电池、商品展示、估值与折旧、资本与分润均加载真实板块，无空壳或加载错误。 |
| 刷新与浏览器返回保留 URL 状态 | 通过 | `tab=capital` 刷新后保持；浏览器 Back 返回 `/vehicles?page=1&pageSize=10`。 |
| 非法/不可见页签规范化且不泄露内容 | 通过 | `tab=not-authorized` 自动规范化为 `tab=overview`；真正低权角色实机项见“权限边界”暂缓说明。 |
| 概览编辑、状态、初始化/复核销售价行为不变 | 通过 | 指定车辆核心状态、编辑/状态/销售价按钮均保留；车辆处于租赁中，未为验收强行改变业务状态。相关写行为由完整自动化回归覆盖。 |
| 待复核入口直达销售价历史 | 通过 | 深链 `?tab=valuation&section=sale-price-history` 加载“本车辆销售价历史”；当前待复核队列为空。 |
| 八类权证均可上传、预览/下载且仅内部可见 | 通过 | 八类均完成真实 OSS 上传；每类 Admin 受控预览返回 200 与正确图片 MIME；数据库 `customer_visible=false`。 |
| 支付凭证一次上传至少两个银行回单 | 通过 | V1 批次包含 PNG、WebP 两个文件；UI 显示 `V1 · 2 个有效文件`。 |
| 支付凭证后续上传形成追加版本批次 | 通过 | 后续上传形成 V2，UI 同时显示 `V2 · 1 个有效文件` 与 V1，追加规则提示可见。 |
| 配置单/检测报告 JPEG、PNG、WebP 可精确绑定 | 通过 | 配置单 PNG/WebP、检测报告 JPEG 均返回 200；绑定精确指向选择的文档 ID。 |
| PDF 与错误文档类型绑定被拒绝 | 通过 | PDF MIME 与机动车登记证错类型绑定均返回 400。 |
| 上传新候选文件不自动切换当前绑定 | 通过 | 绑定配置单 V1 后上传 WebP V4，复核绑定仍指向 V1；人工切换后才改变。 |
| 被引用版本归档返回/展示 409，解绑后可归档 | 通过 | API 归档被引用批次返回 409，UI 显示“已引用，需先解除绑定”；解绑后 14 个验收批次全部 201 归档成功。 |
| 保险/BaaS、商品/套餐能力保持不变 | 通过 | “车辆保险”“电池与 BaaS”“发布状态”和套餐模块均加载；完整自动化回归通过。 |
| 残值/复核/折旧/销售价历史能力保持不变 | 通过 | 估值页及销售价历史深链加载成功；完整自动化回归通过。 |
| 资本事件/融资分摊/分润规则能力保持不变 | 通过 | “资本总览”“资本事件”“融资分摊”“分润试算”加载成功；完整自动化回归通过。 |
| 分润试算不生成结算单或付款记录 | 通过 | 试算 GET 返回 200；前后 `payment_record` 均为 5，响应无 settlement/payment record 标识。 |

## Portal 验收矩阵

| 检查项 | 状态 | 证据/备注 |
| --- | --- | --- |
| 配置单原件长图通过受控 Portal URL 加载 | 通过 | 受控预览返回 200 `image/png`；DOM 出现 1 个“车辆配置单原件”，加载提示消失。 |
| 检测报告原件替代而非重复结构化报告 | 通过 | 受控预览返回 200 `image/jpeg`；DOM 出现 1 个“车辆检测报告原件”，正式结构化报告计数为 0。 |
| 解绑原件后回退已发布结构化报告 | 通过 | API `conditionDisplayMode=STRUCTURED_REPORT`；DOM 恢复 `VCR-20260807-3D713BFC`，原件图片计数为 0。 |
| 无原件且无结构化报告时显示中性空状态 | 通过 | 短暂归档 staging 报告后 API `conditionDisplayMode=NONE`，DOM 显示“暂无可展示的车况报告”；随后立即重新发布，报告编号和 `customerVisible=true` 恢复。 |
| 隐藏/未发布/未绑定/错误车辆/错误 section 预览均返回非披露 404 | 通过 | 隐藏/不可售测试车、全零车辆 ID、非法 section、解绑后的两个 section 均返回 404。 |
| Portal 响应与 DOM 不含 bucket/object key/其他权证元数据 | 通过 | API JSON 与 DOM 均无 `bucket`、`objectKey`、`storageKey`；DOM 无登记证、行驶证、发票、支付凭证信息。 |

## 权限边界

| 检查项 | 状态 | 证据/备注 |
| --- | --- | --- |
| 无 `vehicle:view` 显示 403 | 暂缓 | Staging 当前没有可安全复用的低权验收账号；权限守卫与页面 403 已由聚焦及完整自动化测试覆盖。未临时创建长期账号或修改现有人员角色。 |
| 权证、保险/BaaS、估值、资本页签按权限显示 | 暂缓 | ADMIN 实机可见性通过；低权角色组合由自动化矩阵覆盖，Staging 实机等待专用低权账号。 |
| 管理按钮按精确 manage 权限禁用 | 暂缓 | ADMIN 操作入口正常；低权 manage/view 差异由自动化矩阵覆盖，Staging 实机等待专用低权账号。 |
| Portal 不显示 Admin 下载入口或其他权证资料 | 通过 | Portal 仅显示两个受控来源原件的“查看原图”，未出现 Admin 权证下载或其他七类资料。 |

## 验收数据清理与恢复

- 使用 6 个无业务信息的纯色占位文件完成 staging 验收；本地临时目录已删除，不可恢复且无保留价值。
- 共形成 14 个验收批次、15 个文档；验收后全部归档，数据库复核 `customer_visible=0`、`ACTIVE=0`。
- 指定测试车辆和公开回归车辆的 source binding 均已清零；解绑后的两个 Portal 受控 URL 均返回 404。
- 公开回归车辆的结构化报告 `VCR-20260807-3D713BFC` 已恢复为 `PUBLISHED`、`customerVisible=true`，Portal 回到 `STRUCTURED_REPORT`。
- staging API/Web 与 production API/Web 在清理后均保持 healthy。

## 已知暂缓项

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 微信模板通知联合 Golden Path | 暂缓 | 模板 `Ws_SDUYiCIWD8p8XCiMjWndSxgp9Ga5IGt_MYBEUaqo` 尚在 7–30 个工作日审批期；不作为本车辆工作区缺陷。 |
| 低权角色 Staging 实机矩阵 | 暂缓 | 当前无专用低权验收账号；自动化已覆盖。后续提供一次性低权账号后补跑 403、页签可见性和 manage 按钮三项。 |

## 回滚说明

- 应用回滚：将 staging API/Web 成对切回 `Staging-20260807-7fb2465`，不得只回滚单侧。
- 数据库恢复：使用 `/opt/subscription-saas/backups/subscription_saas_staging_vehicle_tabs_20260808040349.dump`，先停写并校验 SHA256/`pg_restore -l`，禁止 `prisma migrate reset` 或临时破坏性 SQL。
- 环境文件恢复：使用发布前备份 `.env.staging.images.bak.vehicle-tabs-20260808040349`；admin recovery 另有 `.env.staging.images.bak.admin-recovery-20260808043322`。
- 对象存储：本次不搬迁既有对象；验收占位对象对应数据库文档已全部归档且不可被 Portal 访问。

## 验收结论

- 结果：**通过（带非阻塞暂缓项）**。
- 阻塞缺陷：无。
- 功能暂缓：仅低权 staging 实机账号矩阵；自动化权限覆盖已通过。
- 外部暂缓：微信模板审批，不计入本车辆工作区缺陷。
- 发布状态：Staging 已部署并健康；Production 未改动。
