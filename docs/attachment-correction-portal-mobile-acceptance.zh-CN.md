# 附件纠错与 Portal 移动端记录验收记录

## 1. 验收范围

- 日期：2026-08-09
- 分支：`feat/attachment-correction-portal-records-20260808`
- 基线：`origin/main@40206af`
- 设计：`docs/superpowers/specs/2026-08-08-insurance-attachment-correction-portal-mobile-design.zh-CN.md`
- 计划：`docs/superpowers/plans/2026-08-08-insurance-attachment-correction-portal-mobile.md`
- 环境：本地工作树、一次性 PostgreSQL 17 容器 `subscription-saas-attachment-test`，未连接或修改 staging 数据库。

本轮覆盖：上传中文文件名边界与存量修复、保单及附件纠错、车辆权证单文件纠错、Admin 菜单滚动条、Portal 权益和账单移动端卡片。

## 2. 自动化验证

### 2.1 测试结果

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 文件名修复 | `pnpm filename-repair:test` | 10/10 通过 |
| Shared | `pnpm --filter @subscription-saas/shared test` | 3 个文件、9/9 通过 |
| Web | `pnpm --filter @subscription-saas/web test` | 74 个文件、716/716 通过 |
| API | 注入一次性数据库连接后执行 `pnpm --filter @subscription-saas/api test` | 238 个文件、2798/2798 通过 |
| 权限种子专项 | `pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts` | 75/75 通过 |
| 保单专项 | `pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance.spec.ts` | 39/39 通过 |

第一次 API 全量运行未显式注入 `DATABASE_URL`，数据库套件因本地认证/缺少连接串失败；确认一次性容器的数据库名和凭据后，以 `127.0.0.1:55433/subscription_saas_attachment_test` 显式注入重跑，最终结果为 238/238 个测试文件、2798/2798 个用例通过。该次失败属于无效环境运行，不是业务断言失败。

### 2.2 静态门禁和构建

| 验证项 | 结果 |
| --- | --- |
| `pnpm -r lint` | 通过 |
| API typecheck | 通过 |
| Web typecheck | 通过 |
| `pnpm prisma:validate` | 通过 |
| `pnpm prisma:generate` | 通过 |
| `pnpm prisma:migrate:status` | 88 个迁移，数据库已是最新状态 |
| `pnpm build` | Shared、API、Web 生产构建全部通过；Web 生成 60 个静态页面 |

浏览器验收曾创建临时 `acceptance-records` 路由。路由删除后，`.next/types` 一度保留陈旧引用并导致一次 Web typecheck 失败。停止本地 Web 验收进程并重新执行生产构建后，路由缓存被重新生成；最终 Web typecheck、构建均通过，生产路由清单不包含该临时页面。

全仓 `pnpm format:check` 仍会报告 798 个历史文件不符合当前 Prettier 输出，此问题存在于基线且不属于本分支。分支变更文件已执行 Prettier；最终新增/修改的保单服务、回归测试和权限测试均通过 `pnpm exec prettier --check`。

## 3. 文件名修复演练

在一次性数据库的 `file_object` 中插入单条合成乱码记录，固定对象键为 `fixtures/unchanged-key.pdf`，完成以下生命周期：

1. dry-run：扫描到 1 条可修复记录，不写数据库；
2. apply：修复 1 条，批次 ID 为 `a2202702-929f-4a8f-8d5d-4564c09c9afb`；
3. 第二次 apply：修复 0 条，证明幂等；
4. rollback：按批次恢复原始乱码值；
5. 回查：`object_key` 始终为 `fixtures/unchanged-key.pdf`，未移动或重命名存储对象。

修复脚本的纯逻辑和伪 Prisma 执行器另有 10/10 自动化用例，覆盖保守识别、歧义保留、原子审计、幂等和定批次回滚。

## 4. 浏览器验收

### 4.1 保单管理

- 列表“更多”菜单包含“删除错误记录”；空原因和 1 字原因均被拦截。
- 详情附件表单只保留文件和备注，不再出现材料类型、有效期或可见性输入。
- 实际上传 `保单材料验收.pdf` 后中文文件名显示正确；删除后附件列表恢复为空。
- 删除保单、存在理赔记录的 409 冲突、商品板块已绑定附件的 409 冲突均由服务测试覆盖；删除实现只做软删除，不调用对象存储物理删除。

实际附件上传首次暴露了一个回归：保单详情文档未投影 `boundListingSections`，前端对缺失字段执行 `.map` 导致页面崩溃。先补充失败测试，再在保单详情查询中加载 `listingSourceBindings` 并去重投影板块；修复提交为 `c604c09`。修复后实际页面正常显示、预览和删除中文附件，新开浏览器页无控制台错误。

### 4.2 车辆附件与 Admin 菜单

- 商品照片实际上传 `车辆照片验收.jpg`，中文文件名显示正确，删除成功。
- 权证页实际上传 `车辆行驶证验收.pdf`，完整度从 0/8 更新为 1/8；删除后回到 0/8，历史 V1 批次保留且显示 0 个有效文件。
- 配置单、检测报告和已绑定商品板块的删除保护由 API/UI 自动化测试覆盖。
- Admin 左侧菜单保持 `overflow-y: auto`，不显示独立滚动条；鼠标滚轮可独立滚动，右侧内容滚动不改变左侧位置。

### 4.3 Portal 响应式记录

使用正式权益/账单展示组件在 1440、768、390、360 像素宽度验证：

- 1440 像素显示桌面表格，移动卡片隐藏；
- 768、390、360 像素显示移动卡片，桌面表格隐藏；
- 权益名称、单位、余额、已用、来源和有效期按字段呈现，不再逐字挤压；
- 支付单和核销记录按编号、状态、金额、渠道/方式、时间呈现；
- 长编号允许安全换行，页面无水平溢出；
- 浏览器控制台无未捕获异常。

验收用临时路由、上传样本和报告未纳入版本库。

## 5. 安全边界与结论

- 个人材料、保单材料、车辆商品照片和车辆权证使用既有软删除或归档生命周期。
- 已提交进件证据、支付/核销证据、交付证据、已签合同和审计证据仍不可直接删除。
- 本实现和修复脚本均不物理删除、重命名或移动对象存储文件。
- 保单活动记录部分唯一索引已随 88 个迁移在新数据库生效。
- 自动化、生产构建、数据库迁移状态和本地浏览器验收均通过；本分支可进入代码审查、PR 和部署流程。
