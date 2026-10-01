# 后台接口交接

基线 `f8ed9440`，源码 `apps/api/src/portal/portal-catalog.controller.ts` / `portal-catalog.service.ts` 等。仅静态核对，未向后台请求。页面消费 `services` 的展示模型，不能把 Mock 字段当成后台 DTO。

## 已实现的匿名目录适配

| 后台接口                                                | 返回与处理                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET /api/portal/catalog/vehicles                        | 原始数组，无分页/`data` 包装。支持字段源为 brand/series/model/city/modelDefinitionId；本批品牌和关键词在返回列表上过滤 |
| GET /api/portal/catalog/vehicles/:id                    | 原始对象；优先使用内嵌 subscriptionPlans，缺少时调用车辆专属套餐接口                                                   |
| GET /api/portal/catalog/vehicles/:id/subscription-plans | planId/planName/canSubmit/monthlyFeeAmount/subscriptionPeriodMonths 与文字条件映射                                     |
| GET /api/portal/catalog/vehicles/:id/condition-report   | 仅 STRUCTURED_REPORT 模式请求；404 提示报告不可用，不解释成无事故                                                      |
| GET /api/portal/catalog/model-definitions               | service.getModelDefinitions() 留给 marker/车型入口核验，需实际数组                                                     |

`monthlyFeeFromAmount/monthlyFeeAmount` 为整数分；null 显示待确认，0 显示 ¥0.00。不从售价、押金等级或内部公式反推报价。`canSubmit` 必须显式为 true；全局未绑定车辆的套餐不能拿来提交。

媒体只接受本 API 源下 `/api/portal/catalog/vehicles/…` 预览路径；缺图使用无事实含义的本地占位图。SOURCE_DOCUMENT 展示原始图片，NONE 保留待披露。未披露电池、事故等信息不变成“正常”。不使用管理接口、管理令牌或客户自报 customerId。

## 客户域暂未接通

| 模块                | 后台既有入口                                                                       | 下一次适配要求                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 会话                | /portal/auth/request-code、/login、/me                                             | 现登录 JSON 不返回 Bearer，令牌写 HttpOnly Cookie；须单独确定小程序会话，不复用公众号 OpenID                               |
| 申请                | /portal/self-service-applications/precheck、POST /portal/self-service-applications | 后台使用 subscriptionPlanId/subscriptionPeriodMonths，不是 Mock 的 planId/name/mobile DTO；资料和身份先由服务端校验        |
| 最终方案            | /portal/applications/:id/final-plan 与 /confirm、/reject                           | 后台 final-plan 状态 NOT_READY/PENDING_CONFIRM/CONFIRMED/REJECTED；确认 revision/commercialHash，拒绝 reason；完整快照展示 |
| 订单/账单           | /portal/orders、/portal/bills                                                      | `{items,page,pageSize,total}`；账单 amount/paidAmount/remainingAmount 是分，canPay 不等于已接通支付                        |
| 合同/支付/押金/权益 | 对应 portal 控制器                                                                 | 客户归属、会话失效与供应商能力逐项适配；不得只把本地按钮接到写 URL                                                         |
| 交接                | /portal/handover-reviews/:id 与 /confirm、/object、/esign                          | 按 manifestHash/readiness/confirmationReady 校验事实；确认事实和交接单签署是两步                                           |

Mock 的 `AWAITING_CONFIRMATION`、`FINAL_PLAN_CONFIRMED` 是页面场景状态，并非声称它们是后台 Application.status 枚举。真实适配要组合 Application.status 与 planConfirmStatus/最终方案视图。Mock `OBJECTION_SUBMITTED` 也须映射后台 CUSTOMER_OBJECTED 等实际状态；不直接发送示例记录。

## 合流验收顺序

1. 后台主控交付当前有效 API base、source/build 版本、marker、入口到期与停止方式；DB_READY/API_READY 必须有当前证据。
2. 在开发者工具请求车型 marker/空目录，核对真实请求及响应；连接失败不显示演示车辆。
3. 后台在单独获准范围提供合成车辆、有效预设套餐及必要依赖；核对列表、详情、价格条件、不可售/缺图/缺资料与错误状态。
4. 然后逐项接通客户会话、资料、申请和最终方案；再到合同、支付、交接与服务。保持入审优先主线和并发版本校验。
5. 真机与发布另行处理；此工程及源码预览都不会自动开放局域网/公网入口。
