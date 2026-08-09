# Portal 权益页面 UI 改进验收记录

## 变更范围

- 分支：`fix/portal-entitlement-ui-20260809`
- 当前实现提交：`776d62a`
- 基线：`origin/main`，提交 `9d12f7e`
- 本轮只调整 Portal 权益页面 UI 与客户端数据投影。
- 未修改 API、数据库、Prisma、迁移、权益台账计算、附件上传或部署逻辑。
- 中文附件名上传已在 `Staging-20260809-9d12f7e` 单独复验通过，不属于本分支验收范围。

## 已实现能力

1. 固定按“服务权益 / 补能权益 / 里程权益”显示 Tab 和数量。
2. 默认打开含当前有效权益的第一个类型；否则打开第一个有记录的类型。
3. 同一类型内按当前期次、未来期次、历史期次排列，并按距当前日期由近到远排序。
4. 采用方案 B 权益卡片，突出当前可用额度，并展示当期初始额度、已核销额度和核销进度。
5. 已过期、已取消权益整卡置灰；已用尽权益不整卡置灰，显示 100% 进度和零可用额度。
6. 文本权益显示“已发放 / 不适用 / 可使用或不可用”，不显示数值进度条。
7. 核销记录跟随当前权益类型过滤；桌面保持表格，移动端使用卡片。
8. 客户端完整读取全部分页，不再只展示第一页；读取失败时显示可重试状态。

## 自动化验证

在隔离工作树 `portal-entitlement-ui-20260809` 执行：

```powershell
pnpm exec prettier --check apps/web/src/app/portal/entitlements apps/web/test/portal-entitlement-view-model.spec.ts apps/web/test/portal-entitlement-overview.spec.tsx apps/web/test/portal-entitlement-page-content.spec.tsx apps/web/test/portal-entitlement-records.spec.tsx apps/web/test/portal-paged-loader.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/portal-entitlement-view-model.spec.ts test/portal-entitlement-overview.spec.tsx test/portal-entitlement-page-content.spec.tsx test/portal-entitlement-records.spec.tsx test/portal-paged-loader.spec.ts
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/shared build
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web build
```

结果：

- Prettier：通过。
- 权益聚焦测试：5 个文件、24 项测试全部通过。
- Web 全量测试：78 个文件、737 项测试全部通过。
- TypeScript：通过。
- ESLint：通过。
- Next.js 生产构建：通过，`/portal/entitlements` 路由成功生成。
- 首次全量测试因隔离工作树尚未生成 `@subscription-saas/shared` 构建产物，有 2 个套件无法解析共享包；执行共享包构建后原样重跑，78/78 个测试文件通过。
- 构建仅出现 Next.js 对多工作树锁文件推断根目录的环境提示，无代码告警或构建失败。

## 已覆盖的响应式与状态证据

- CSS 契约测试确认桌面端两列卡片、`768px` 及以下单列卡片。
- 组件渲染测试确认固定 Tab、数量、当前/历史期次、额度三项、进度、TEXT、EXPIRED、EXHAUSTED 和类型核销过滤。
- CSS 契约确认机器编号可换行、无 `overflow-x: scroll` 页面级横向滚动方案。
- 视觉方案 B 已在设计确认阶段通过可视稿确认。

## Staging 人工验收清单

本地没有可复用的 Portal 登录态和覆盖全部状态的非生产权益数据，因此以下真实账户浏览器检查留待部署到 Staging 后执行，不在本文中冒充已完成：

1. 在 360px、390px、768px 和桌面宽度检查无横向溢出。
2. 检查三类 Tab 数量、默认 Tab 和 Tab 切换。
3. 检查当前、未来、历史权益的实际顺序。
4. 检查当前可用额度、初始额度、已核销额度和进度条。
5. 检查已过期/已取消置灰、已用尽不置灰、TEXT 无进度条。
6. 检查核销记录只显示当前 Tab 类型。
7. 检查多于 100 条权益或核销记录时仍能完整读取。
8. 检查请求失败时错误提示和“重新加载”，并确认浏览器控制台无新增错误。
