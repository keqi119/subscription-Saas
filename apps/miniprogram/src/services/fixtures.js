const { money } = require('../utils/format');
// 全部为合成数据。图片是自制示意图，不是实车、车况或可交易库存。
const vehicles = [
  {
    id: 'demo-sedan',
    name: '城市纯电 · 舒适轿车',
    brand: '城市系列',
    city: '上海',
    registrationText: '2023 年上牌',
    mileageText: '24,800 km',
    rangeText: '约 480 km · 样例续航',
    bodyType: '轿车',
    available: true,
    statusText: '可申请',
    imageUrl: '/assets/car-sedan.png',
    minFeeAmount: 329900,
    tagline: '安静通勤，从容出发。',
  },
  {
    id: 'demo-suv',
    name: '家庭纯电 · 五座 SUV',
    brand: '家庭系列',
    city: '上海',
    registrationText: '2024 年上牌',
    mileageText: '18,600 km',
    rangeText: '约 520 km · 样例续航',
    bodyType: 'SUV',
    available: true,
    statusText: '可申请',
    imageUrl: '/assets/car-suv.png',
    minFeeAmount: 429900,
    tagline: '给家人，也给生活留一点空间。',
  },
  {
    id: 'demo-compact',
    name: '轻巧纯电 · 城市小车',
    brand: '城市系列',
    city: '上海',
    registrationText: '2024 年上牌',
    mileageText: '12,100 km',
    rangeText: '约 350 km · 样例续航',
    bodyType: '紧凑型',
    available: false,
    statusText: '整备中',
    imageUrl: '/assets/car-compact.png',
    minFeeAmount: null,
    tagline: '小巧，刚好适合日常。',
  },
].map((vehicle) => ({ ...vehicle, minFeeText: money(vehicle.minFeeAmount) }));
function plansFor(vehicle) {
  return [6, 12].map((months) => {
    const monthlyFeeAmount =
      vehicle.minFeeAmount === null ? null : vehicle.minFeeAmount + (months === 6 ? 30000 : 0);
    return {
      id: `${vehicle.id}-${months}`,
      title: `${months} 个月 · 日常通勤`,
      termMonths: months,
      monthlyFeeAmount,
      monthlyFeeText: money(monthlyFeeAmount),
      mileageText: '每月 1,500 公里',
      energyText: '充电费用按实际使用另计',
      benefits: ['基础车辆保障（以合同为准）', '日常用车服务入口'],
      depositText: '审核后确认',
      notes: '月费为样例预估；超里程、损伤及提前退出等费用以最终方案和合同为准。',
      available: vehicle.available,
    };
  });
}
function record(type, id, title, subtitle, status, statusText, details, extras) {
  return {
    type,
    id,
    title,
    subtitle,
    status,
    statusText,
    amountText: '',
    details: details || [],
    timeline: [],
    actions: [],
    documents: [],
    ...extras,
  };
}
function activeRecords() {
  return {
    orders: [
      record(
        'orders',
        'demo-order',
        '城市纯电 · 舒适轿车',
        '12 个月 · 日常通勤',
        'ACTIVE',
        '用车中',
        [
          { label: '订阅编号', value: 'DEMO-2026-001' },
          { label: '周期', value: '2026.09.01 — 2027.08.31' },
          { label: '包含里程', value: '每月 1,500 公里' },
        ],
        { amountText: money(329900) + ' / 月' },
      ),
    ],
    contracts: [
      record(
        'contracts',
        'demo-contract',
        '汽车订阅服务合同',
        '示例合同 · 非真实法律文件',
        'SIGNED',
        '样例已签署',
        [
          { label: '关联车辆', value: '城市纯电 · 舒适轿车' },
          { label: '期限', value: '12 个月' },
          { label: '签署状态', value: '仅演示；真实状态需后台核验' },
        ],
        {
          documents: [
            {
              id: 'contract-example',
              title: '合同条款示例',
              description: '展示订阅期限、费用与双方责任；本工程不包含真实合同或签署证书。',
            },
          ],
          actions: [{ id: 'sign', label: '了解签署流程' }],
        },
      ),
    ],
    bills: [
      record(
        'bills',
        'demo-bill',
        '10 月订阅账单',
        '2026.10.01 — 2026.10.31',
        'PENDING',
        '待支付',
        [
          { label: '应付日期', value: '2026.10.01' },
          { label: '应付金额', value: money(329900) },
          { label: '已付金额', value: money(0) },
          { label: '剩余应付', value: money(329900) },
        ],
        { amountText: money(329900), actions: [{ id: 'pay', label: '查看支付说明' }] },
      ),
    ],
    payments: [
      record(
        'payments',
        'demo-payment',
        '9 月订阅月费',
        '示例支付记录 · 未发生真实扣款',
        'PAID',
        '样例已支付',
        [
          { label: '金额', value: money(329900) },
          { label: '时间', value: '2026.09.01' },
          { label: '渠道', value: '本地演示' },
        ],
        { amountText: money(329900) },
      ),
    ],
    deposits: [
      record(
        'deposits',
        'demo-deposit',
        '订阅押金',
        '示例审核后押金 · 非真实账户余额',
        'HELD',
        '样例冻结中',
        [
          { label: '押金余额', value: money(600000) },
          { label: '退还规则', value: '以合同及最终结算为准' },
        ],
        { amountText: money(600000) },
      ),
    ],
    entitlements: [
      record(
        'entitlements',
        'demo-mileage-benefit',
        '月度包含里程',
        '日常通勤套餐',
        'ACTIVE',
        '使用中',
        [
          { label: '本月额度', value: '1,500 公里' },
          { label: '示例已使用', value: '860 公里' },
          { label: '超里程说明', value: '按最终合同约定单价结算' },
        ],
      ),
    ],
    notifications: [
      record(
        'notifications',
        'demo-notice',
        '请核对本月里程',
        '2026.09.12 · 用车提醒',
        'UNREAD',
        '未读',
        [
          {
            label: '提醒内容',
            value: '查看最新里程记录，若有差异可提交复核。此消息仅用于界面演示。',
          },
        ],
        { actions: [{ id: 'read', label: '标为已读' }] },
      ),
    ],
    services: [],
  };
}
function applicationFor(scenario) {
  const vehicle = vehicles[0];
  const plan = plansFor(vehicle)[1];
  const finalPlan =
    scenario === 'confirm'
      ? {
          revision: 1,
          vehicleName: vehicle.name,
          planTitle: plan.title,
          termMonths: plan.termMonths,
          monthlyFeeText: plan.monthlyFeeText,
          depositText: money(600000),
          mileageText: plan.mileageText,
          energyText: plan.energyText,
          benefits: [...plan.benefits],
          notes: `${plan.notes} 这是演示审核结果。确认后才进入订单与合同流程，实际条款以后台结果为准。`,
        }
      : null;
  return {
    id: 'demo-application',
    title: '订阅申请',
    status: scenario === 'confirm' ? 'AWAITING_CONFIRMATION' : 'SUBMITTED',
    statusText: scenario === 'confirm' ? '待确认最终方案' : '审核中',
    vehicleId: vehicle.id,
    planId: plan.id,
    vehicleName: vehicle.name,
    planTitle: plan.title,
    monthlyFeeText: plan.monthlyFeeText,
    depositText: scenario === 'confirm' ? money(600000) : '审核后确认',
    finalPlan,
  };
}
function initialState(scenario = 'new') {
  return {
    version: 1,
    scenario,
    fault: 'none',
    profile:
      scenario === 'new'
        ? { name: '', mobile: '', drivingYears: '' }
        : { name: '体验客户', mobile: '13800000000', drivingYears: '5' },
    application: ['review', 'confirm'].includes(scenario) ? applicationFor(scenario) : null,
    records:
      scenario === 'active'
        ? activeRecords()
        : {
            orders: [],
            contracts: [],
            bills: [],
            payments: [],
            deposits: [],
            entitlements: [],
            notifications: [],
            services: [],
          },
    mileage: 24800,
    handover: null,
    sequence: 0,
  };
}
module.exports = { vehicles, plansFor, record, initialState };
