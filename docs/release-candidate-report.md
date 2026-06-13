# Stage 9E Release Candidate Report

## 1. RC 基本信息

| 项目 | 结果 |
| --- | --- |
| RC 名称 | Stage 9 Release Candidate |
| RC 日期 | 2026-06-13 |
| 分支 | `feature/stage9-release-candidate` |
| 验证基线 commit | `b723e1c chore: add release checklist and readiness gate` |
| 是否包含 migration | 否 |
| migration status | up to date, 35 migrations found |
| 是否修改默认 seed | 否 |
| 是否执行 scenario seed | 是，执行 cleanup / mainline / residual |
| 是否执行 smoke | 是，执行 API / mainline / residual，且包含 Web route smoke |
| 执行人 | Codex |

本报告只记录发布冻结验收结果，不引入业务功能、schema 变更或 migration。

## 2. 质量门禁结果

| 检查项 | 结果 | 备注 |
| --- | --- | --- |
| `pnpm -r lint` | PASS | workspace lint 通过 |
| `pnpm prisma:validate` | PASS | schema valid |
| `pnpm prisma:generate` | PASS | Prisma Client generated |
| API typecheck | PASS | `tsc --noEmit -p tsconfig.json` |
| Web typecheck | PASS | `tsc --noEmit --incremental false` |
| API tests | PASS | 31 test files / 527 tests passed |
| migrate status | PASS | database schema is up to date |
| `node --check scripts/api-smoke.mjs` | PASS | syntax check |
| `node --check scripts/release-check.mjs` | PASS | syntax check |
| `node --check apps/api/prisma/seed-scenario.mjs` | PASS | syntax check |
| `pnpm release:check` | PASS | default mode |
| full release check | PASS | `RUN_RELEASE_SCENARIOS=1`, `RUN_RELEASE_SMOKE=1`, with Web route smoke |

## 3. Scenario Seed 结果

Initial cleanup 清理了上一轮 `SCN9_` 场景数据：

| 数据域 | 清理数量 |
| --- | ---: |
| vehicle valuation review | 1 |
| residual forecast points | 3 |
| residual forecast | 1 |
| residual curve points | 3 |
| residual curve | 1 |
| market observations | 6 |
| market import batch | 1 |
| application | 1 |
| customer | 1 |
| vehicle sale price history | 2 |
| vehicle | 2 |

Mainline scenario 输出：

| 字段 | 值 |
| --- | --- |
| 输出文件 | `.tmp/scenarios/mainline.json` |
| scenario | `mainline` |
| coverage | `customer_application_vehicle_plan` |
| customerId | `412a8ada-deb6-425f-874b-3790cdfdab82` |
| applicationId | `97037ac4-6763-4f2a-848f-86adf189df9a` |
| vehicleId | `1b2ea848-d634-4f1d-aec2-ba11324078a3` |
| subscriptionPlanId | `89fec1da-6cc0-49ce-9203-81a358c2cdc4` |
| quoteId / orderId / contractId | `null` by design |

Residual scenario 输出：

| 字段 | 值 |
| --- | --- |
| 输出文件 | `.tmp/scenarios/residual.json` |
| scenario | `residual` |
| coverage | `vehicle_market_curve_forecast_pending_review` |
| vehicleId | `709083ce-4a80-45d9-8f27-b9000d833f37` |
| importBatchId | `34a21731-70df-4a6b-ae17-625eda099df8` |
| curveId | `84a58fdd-7ae9-4c1e-8a68-9ddd599d6498` |
| curvePointId | `aa20f21b-0770-4c41-92d2-6700a0fac7d3` |
| forecastId | `062f4115-ce8f-4e28-bd68-6b7ebf874527` |
| forecastPointId | `9b32e389-68b0-4fb5-b65e-8cfbbae1d527` |
| valuationReviewId | `5ef2dfad-456f-495c-82cb-eab7bad6febc` |

Full release check 后再次执行了 cleanup，清理了 full check 生成的 `SCN9_` 场景数据，不保留 RC 验收数据。

## 4. Smoke 结果

| Smoke | 结果 | 备注 |
| --- | --- | --- |
| `pnpm smoke:api` | PASS | health、login、me、核心 API、报表、系统接口 |
| `pnpm smoke:mainline` | PASS | customer/application/vehicle 详情通过；quote/order/contract 按设计跳过 |
| `pnpm smoke:residual` | PASS | vehicle、curve、forecast、valuation review 详情通过 |
| Web route smoke | PASS | `SMOKE_WEB_BASE_URL=http://localhost:3000` |

Web route 已覆盖：

- `/`
- `/applications`
- `/vehicles`
- `/orders`
- `/contracts`
- `/reports`
- `/reports/asset-profitability`
- `/residual-market`
- `/vehicle-valuation-reviews`

## 5. 主线验收冻结状态

| 主线能力 | 状态 | 备注 |
| --- | --- | --- |
| A/B 进件 | Ready | mainline scenario 可定位进件；完整人工路径见 manual acceptance |
| 报价 | Manual verification required | mainline scenario 不直接造 quote |
| 订单合同 | Manual verification required | mainline scenario 不直接造 order / contract |
| 账单收款 | Manual verification required | 人工验收覆盖 |
| 交付 | Manual verification required | 人工验收覆盖 |
| 权益 | Manual verification required | 人工验收覆盖 |
| 月租 | Manual verification required | 人工验收覆盖 |
| 逾期催收 | Manual verification required | 人工验收覆盖 |
| 退车 | Manual verification required | 人工验收覆盖 |
| 押金结算 | Manual verification required | 人工验收覆盖 |
| 车辆再入池 | Manual verification required | 人工验收覆盖 |
| 经营看板 | Ready | API smoke 覆盖 dashboard summary |
| 资产经营 | Ready | API/Web smoke 覆盖 asset profitability |
| 残值预测 | Ready | residual scenario + smoke 覆盖 forecast |
| 估值复核 | Ready | residual scenario + smoke 覆盖 pending review |
| CSV 导出 | Manual verification required | manual acceptance 覆盖 |

## 6. Release Blockers

No release blockers found in Stage 9E checks.

注意事项：

- Web route smoke 已执行并通过。
- 生产发布仍需人工确认真实环境变量、数据库备份文件、部署进程和人工验收签字。
- 本轮未自动打 tag，未 push tag，未真实部署生产。

## 7. Deferred Items

以下事项明确延期，不属于当前 RC blocker：

- 8.5C 批量估值审批通过
- 真实 AI / ML 训练
- 自动爬虫
- 真实支付通道
- 电子签深度集成
- 短信 / 微信通知
- 批量自动调价
- 高级资金池 ROE
- 维修工单系统

## 8. Tag 建议

人工验收通过后，可考虑创建 RC tag：

```powershell
git tag -a rc-20260613-stage9 -m "Release candidate 2026-06-13 Stage 9"
git push origin rc-20260613-stage9
```

不要在未完成 Release Candidate 人工验收前自动推送 tag。
