# Stage 9 Release Notes Draft

本文档是 Stage 9 Release Candidate 的发布评审草稿，用于 PR / 发布会议确认。

## 1. 客户 / 进件

- 支持客户线索、客户资料维护和跟进。
- 支持 A 线自助进件和 B 线销售辅助进件。
- 支持材料、信用、产品、车辆等审核节点。
- 权限和菜单通过 seed 初始化，权限变更后需重新登录刷新 JWT。

## 2. 产品 / 套餐

- 支持产品、产品版本、价格规则、车辆套餐、里程套餐、补能套餐和权益套餐。
- 默认 seed 初始化 baseline 产品和 active subscription plan。
- 默认 seed 不生成复杂业务流程记录。

## 3. 报价 / 订单 / 合同

- 支持基于进件创建报价。
- 支持报价确认、订单创建、订单审核、客户确认和合同生成。
- 支持合同签署、归档和取消。
- mainline scenario 当前提供客户、进件、车辆和订阅计划入口，报价 / 订单 / 合同由人工验收继续推进。

## 4. 车辆资产 / 交付 / 退车 / 再入池

- 支持车辆资产池、车辆状态、车辆销售价初始化和销售价历史。
- 支持订单交付准备、交付确认、退车准备和退车确认。
- 支持退车损伤费、押金结算和车辆再入池。
- 车辆当前销售价仍是受控字段，不能由残值预测自动覆盖。

## 5. 财务 / 押金 / 月租 / 催收

- 支持初始账单、月租账单、损伤费账单、收款和核销。
- 支持押金扣减、退款和押金流水。
- 支持逾期刷新、催收案件和催收动作。
- 财务主线仍需在人工验收中按 release checklist 确认。

## 6. 权益

- 支持订单权益账户、权益发放、月度续发、消费和过期。
- 权益相关报表和明细在人工验收清单中覆盖。

## 7. 经营看板 / 报表

- 支持 dashboard summary、订单报表、财务报表、押金池、催收报表、车辆资产报表和权益报表。
- 支持 CSV 导出路径。
- API smoke 覆盖 dashboard summary 和 asset profitability summary。

## 8. 资产经营 / ROE

- 支持车辆资产经营分析、收益试算、资本结构、收入权和收益分配相关能力。
- 残值敏感性 ROE 仅作为试算参考，不改变主 ROE。
- 主 ROE、残值敏感性和 CSV 导出口径已在 `docs/reporting-metrics.md` 中固化。

## 9. 残值预测 / 估值复核

- 支持市场残值样本、残值曲线、单车残值预测、预测点采用和估值复核。
- 采用预测点不会更新车辆当前销售价。
- 发起估值复核不会更新车辆当前销售价。
- 只有估值复核审核通过才更新 `Vehicle.currentSalePriceAmount` 并写入 `VehicleSalePriceHistory`。
- residual scenario 和 smoke 已覆盖曲线、forecast、forecast point 和待审批估值复核。

## 10. 生产就绪能力

- CI workflow 覆盖安装、Prisma validate/generate、lint、API/Web typecheck、migration deploy 和 API tests。
- 环境变量模板覆盖根、API 和 Web。
- 部署、备份恢复、权限矩阵、人工验收、scenario seed、release checklist 和主线冻结文档已补齐。
- `pnpm release:check` 可执行本地发布前质量门禁。
- `RUN_RELEASE_SCENARIOS=1` 和 `RUN_RELEASE_SMOKE=1` 可启用完整本地 release gate。

## 11. 已知延后项

- 8.5C 批量估值审批通过
- 真实 AI / ML 训练
- 自动爬虫
- 真实支付通道
- 电子签深度集成
- 短信 / 微信通知
- 批量自动调价
- 高级资金池 ROE
- 维修工单系统

这些延期项不构成当前 RC blocker。

## 12. 部署注意事项

- 生产发布前必须完成 `docs/release-checklist.md`。
- 生产发布前必须完成数据库备份，并确认恢复流程。
- 生产 migration 只允许使用 `prisma migrate deploy`。
- 生产环境禁止 `prisma migrate reset` 和 `prisma db push`。
- scenario seed 只用于开发 / 验收环境，不得用于生产。
- 发布后必须执行 health check、登录 smoke、关键 API smoke、关键页面 smoke、错误日志检查、审计日志检查和权限菜单检查。
