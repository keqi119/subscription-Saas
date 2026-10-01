const config = require('../config');
const fixture = require('./fixtures');
const clone = (value) => JSON.parse(JSON.stringify(value));
const phoneValid = (mobile) => /^1[3-9]\d{9}$/.test(String(mobile || ''));
function fail(message, code = 'VALIDATION') {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function read() {
  try {
    const value = wx.getStorageSync(config.storageKey);
    if (
      value &&
      value.version === 1 &&
      ['new', 'review', 'confirm', 'active'].includes(value.scenario) &&
      value.records
    )
      return clone(value);
  } catch (_) {
    /* 不读取其他存储键；失效演示缓存可重置。 */
  }
  return fixture.initialState();
}
function write(state) {
  try {
    wx.setStorageSync(config.storageKey, clone(state));
  } catch (_) {
    fail('无法保存本地演示数据，请检查存储空间后重试。', 'STORAGE');
  }
}
async function ready() {
  if (config.mockDelay) await new Promise((resolve) => setTimeout(resolve, config.mockDelay));
  const state = read();
  if (state.fault === 'error')
    fail('示例网络暂时不可用。可重试，或在体验设置恢复正常场景。', 'NETWORK');
  return state;
}
function assertActive(state) {
  if (state.scenario !== 'active') fail('当前没有用车中的订阅。请先选车，或切换“用车中”演示场景。');
}
function applicationView(application) {
  if (!application) return null;
  const final = ['AWAITING_CONFIRMATION', 'FINAL_PLAN_CONFIRMED'].includes(application.status);
  return {
    ...clone(application),
    timeline: [
      { title: '提交申请', description: '意向已记录，押金等待审核确认。', done: true },
      {
        title: '资料与方案审核',
        description: final
          ? '演示审核已完成，请阅读最终方案。'
          : '审核结果与需补充的资料将在此更新。',
        done: final,
      },
      {
        title: '确认最终方案',
        description: '核对车辆、套餐、费用与版本后确认。',
        done: application.status === 'FINAL_PLAN_CONFIRMED',
      },
      { title: '合同与交付', description: '确认方案后才进入合同及交付流程。', done: false },
    ],
    nextAction:
      application.status === 'AWAITING_CONFIRMATION'
        ? '请阅读并确认最终方案'
        : application.status === 'CANCELLED'
          ? '申请已取消，可重新选车'
          : application.status === 'REJECTED'
            ? '方案已拒绝，可以重新选车'
            : application.status === 'FINAL_PLAN_CONFIRMED'
              ? '方案已确认，请等待合同与交付安排'
              : '审核中，请留意资料与方案通知',
  };
}
function decoratedVehicles(state) {
  return fixture.vehicles.map((original) => {
    const vehicle = clone(original);
    if (
      state.application &&
      state.application.vehicleId === vehicle.id &&
      !['CANCELLED', 'REJECTED'].includes(state.application.status)
    ) {
      vehicle.available = false;
      vehicle.statusText = '申请审核预留';
    }
    return vehicle;
  });
}
function getContext() {
  const state = read();
  return { mode: 'mock', scenario: state.scenario, fault: state.fault, profile: state.profile };
}
async function getVehicles(filters = {}) {
  const state = await ready();
  const all = decoratedVehicles(state);
  const query = String(filters.query || '')
    .trim()
    .toLowerCase();
  return {
    items:
      state.fault === 'empty'
        ? []
        : all.filter(
            (item) =>
              (!filters.brand || filters.brand === '全部' || item.brand === filters.brand) &&
              (!query || `${item.name} ${item.city} ${item.brand}`.toLowerCase().includes(query)),
          ),
    brands: [...new Set(all.map((item) => item.brand))],
  };
}
async function getVehicle(id) {
  const state = await ready();
  const vehicle = decoratedVehicles(state).find((item) => item.id === id);
  if (!vehicle || state.fault === 'empty')
    fail('暂未找到这辆车，可能已下架。请返回选车。', 'NOT_FOUND');
  return {
    vehicle,
    plans: fixture.plansFor(vehicle),
    report: {
      summary: '车况资料示例',
      items: [
        { label: '车辆用途', value: '城市日常通勤（合成样例）' },
        { label: '外观', value: '示例：右后门轻微划痕，交付时以证据为准' },
        { label: '最近里程', value: vehicle.mileageText },
        { label: '电池与事故信息', value: '待真实报告披露，不作无事故或健康度承诺' },
      ],
      notice: '车辆图片与报告均为演示，不能作为实车车况、续航或库存承诺。',
    },
  };
}
async function getHome() {
  const state = await ready();
  const application = applicationView(state.application);
  return {
    context: getContext(),
    vehicles: state.fault === 'empty' ? [] : decoratedVehicles(state).slice(0, 2),
    nextAction:
      application && application.status !== 'CANCELLED'
        ? {
            title: application.statusText,
            description: application.nextAction,
            label: '查看申请',
            url: `/pages/application-detail/index?id=${application.id}`,
          }
        : state.scenario === 'active'
          ? {
              title: '让每一天，从容有序',
              description: '查看当前车辆、账单与用车待办。',
              label: '进入用车',
              url: '/pages/use/index',
            }
          : null,
  };
}
async function getApplication(id) {
  const state = await ready();
  if (state.fault === 'empty') return null;
  if (id && state.application && id !== state.application.id)
    fail('申请不存在或已重置。', 'NOT_FOUND');
  return applicationView(state.application);
}
async function submitApplication(payload) {
  const state = await ready();
  if (!payload || !payload.accepted) fail('请先阅读并同意申请说明。');
  if (!String(payload.name || '').trim()) fail('请填写联系人姓名。');
  if (!phoneValid(payload.mobile)) fail('请输入有效的 11 位手机号。');
  if (state.application && !['CANCELLED', 'REJECTED'].includes(state.application.status)) {
    if (
      state.application.vehicleId === payload.vehicleId &&
      state.application.planId === payload.planId
    )
      return applicationView(state.application);
    fail('已有进行中的演示申请，请先查看或取消。');
  }
  const vehicle = fixture.vehicles.find((item) => item.id === payload.vehicleId);
  if (!vehicle || !vehicle.available) fail('车辆当前不可申请，请重新选车。');
  const plan = fixture
    .plansFor(vehicle)
    .find((item) => item.id === payload.planId && item.available);
  if (!plan) fail('套餐已不可用，请重新选择预设套餐。');
  state.sequence += 1;
  state.application = {
    id: `demo-application-${state.sequence}`,
    title: '订阅申请',
    status: 'SUBMITTED',
    statusText: '审核中',
    vehicleId: vehicle.id,
    planId: plan.id,
    vehicleName: vehicle.name,
    planTitle: plan.title,
    monthlyFeeText: plan.monthlyFeeText,
    depositText: '审核后确认',
    finalPlan: null,
  };
  state.profile = { ...state.profile, name: String(payload.name).trim(), mobile: payload.mobile };
  if (state.scenario !== 'active') state.scenario = 'review';
  write(state);
  return applicationView(state.application);
}
async function getDashboard() {
  const state = await ready();
  if (state.fault === 'empty')
    return {
      subscription: null,
      application: null,
      bill: null,
      entitlements: [],
      services: [],
      todos: [],
    };
  return {
    subscription:
      state.scenario === 'active'
        ? {
            id: 'demo-order',
            title: '我的订阅',
            vehicleName: fixture.vehicles[0].name,
            planTitle: '12 个月 · 日常通勤',
            monthlyFeeText: fixture.vehicles[0].minFeeText,
            nextDueDate: '2026.10.01',
            mileageText: `${state.mileage.toLocaleString('en-US')} km`,
            imageUrl: fixture.vehicles[0].imageUrl,
          }
        : null,
    application: applicationView(state.application),
    bill: state.records.bills[0] || null,
    entitlements: state.records.entitlements,
    services: state.records.services.slice(0, 3),
    todos:
      state.scenario === 'active'
        ? [
            {
              title: '月度里程待核对',
              description: '查看里程记录，如有差异可提交复核。',
              url: '/pages/mileage/index',
            },
            {
              title: '查看交接证据',
              description: '确认事实与签署交接单是两个步骤。',
              url: '/pages/handover/index',
            },
          ]
        : [],
  };
}
async function getRecords(type) {
  const state = await ready();
  if (state.fault === 'empty') return [];
  if (type === 'applications') return state.application ? [applicationView(state.application)] : [];
  if (!Object.prototype.hasOwnProperty.call(state.records, type)) fail('暂不支持此记录类型。');
  return clone(state.records[type]);
}
async function getRecord(type, id) {
  const records = await getRecords(type);
  const result = records.find((item) => item.id === id);
  if (!result) fail('记录不存在或已重置。', 'NOT_FOUND');
  return result;
}
async function performAction(type, id, action, payload = {}) {
  const state = await ready();
  if (type === 'application' || type === 'applications') {
    const app = state.application;
    if (!app || app.id !== id) fail('申请不存在。');
    if (action === 'cancel') {
      if (['CANCELLED', 'FINAL_PLAN_CONFIRMED'].includes(app.status)) fail('当前申请不能取消。');
      app.status = 'CANCELLED';
      app.statusText = '已取消';
      app.finalPlan = null;
    } else if (['confirm', 'reject'].includes(action)) {
      if (
        app.status !== 'AWAITING_CONFIRMATION' ||
        !app.finalPlan ||
        app.finalPlan.revision !== payload.revision
      )
        fail('方案已更新或状态变化，请刷新并重新阅读。', 'REVISION_CONFLICT');
      app.status = action === 'confirm' ? 'FINAL_PLAN_CONFIRMED' : 'REJECTED';
      app.statusText = action === 'confirm' ? '最终方案已确认' : '方案已拒绝';
      if (action === 'confirm') {
        const finalPlanSnapshot = clone(app.finalPlan);
        state.records.orders.unshift(
          fixture.record(
            'orders',
            `demo-pending-order-${app.id}`,
            '订阅订单 · 待合同',
            finalPlanSnapshot.vehicleName,
            'PENDING_SIGN',
            '待签约',
            [
              { label: '方案版本', value: String(finalPlanSnapshot.revision) },
              { label: '订阅套餐', value: finalPlanSnapshot.planTitle },
              { label: '订阅期限', value: `${finalPlanSnapshot.termMonths} 个月` },
              { label: '月费', value: finalPlanSnapshot.monthlyFeeText },
              { label: '押金', value: finalPlanSnapshot.depositText },
              { label: '包含里程', value: finalPlanSnapshot.mileageText },
              { label: '能源说明', value: finalPlanSnapshot.energyText },
              { label: '包含权益', value: (finalPlanSnapshot.benefits || []).join('；') },
              { label: '使用条件', value: finalPlanSnapshot.notes },
              { label: '说明', value: '本地模拟生成，尚未签约、支付或交付' },
            ],
            {
              revision: finalPlanSnapshot.revision,
              finalPlanSnapshot,
              amountText: finalPlanSnapshot.monthlyFeeText + ' / 月',
            },
          ),
        );
      }
    } else fail('暂不支持此申请操作。');
    write(state);
    return { message: `本地演示：${app.statusText}，未向后台提交。`, record: applicationView(app) };
  }
  const item = state.records[type] && state.records[type].find((entry) => entry.id === id);
  if (!item) fail('记录不存在。');
  if (['pay', 'payment', 'sign', 'signing'].includes(action))
    return {
      message:
        '前端已预留此入口。真实支付或签署需后台会话与供应商适配完成；本次未发起交易，也未改变状态。',
      record: item,
    };
  if (type === 'notifications' && action === 'read') {
    item.status = 'READ';
    item.statusText = '已读';
    item.actions = [];
  } else if (type === 'services' && action === 'cancel') {
    if (item.status !== 'SUBMITTED') fail('当前工单不能取消。');
    item.status = 'CANCELLED';
    item.statusText = '已取消';
    item.actions = [];
  } else fail('该操作尚未接入，请等待后台就绪。', 'INTEGRATION_PENDING');
  write(state);
  return { message: '本地演示记录已更新。', record: item };
}
async function saveProfile(payload) {
  const state = await ready();
  if (!String(payload.name || '').trim()) fail('请填写姓名。');
  if (!phoneValid(payload.mobile)) fail('请输入有效的 11 位手机号。');
  const years = Number(payload.drivingYears);
  if (
    !Number.isInteger(years) ||
    years < 0 ||
    years > 70 ||
    String(payload.drivingYears).trim() === ''
  )
    fail('请输入 0–70 的整数驾龄。');
  state.profile = {
    name: String(payload.name).trim().slice(0, 40),
    mobile: String(payload.mobile),
    drivingYears: String(years),
  };
  write(state);
  return clone(state.profile);
}
function attachmentSummary(attachments) {
  return Array.isArray(attachments) && attachments.length
    ? `本地选择 ${attachments.length} 项（未上传）`
    : '未选择附件';
}
async function submitService(payload) {
  const state = await ready();
  assertActive(state);
  if (!['rescue', 'accident'].includes(payload.type)) fail('请选择救援或事故报案。');
  if (!String(payload.location || '').trim()) fail('请填写当前位置。');
  if (!String(payload.description || '').trim()) fail('请补充问题描述。');
  if (!phoneValid(payload.mobile)) fail('请填写有效联系电话。');
  state.sequence += 1;
  const item = fixture.record(
    'services',
    `demo-service-${state.sequence}`,
    payload.type === 'rescue' ? '道路救援申请' : '事故报案',
    '仅本地演示 · 未派车或通知服务商',
    'SUBMITTED',
    '已记录演示申请',
    [
      { label: '位置', value: String(payload.location).slice(0, 200) },
      { label: '问题', value: String(payload.description).slice(0, 1000) },
      { label: '联系电话', value: payload.mobile },
      { label: '附件', value: attachmentSummary(payload.attachments) },
    ],
    {
      actions: [{ id: 'cancel', label: '取消演示工单' }],
      timeline: [
        {
          title: '本地记录',
          description: '没有向服务商派单；紧急情况请直接联系当地应急服务。',
          done: true,
        },
      ],
    },
  );
  state.records.services.unshift(item);
  write(state);
  return clone(item);
}
async function submitMileage(payload) {
  const state = await ready();
  assertActive(state);
  const reading = Number(payload.reading);
  if (
    !Number.isSafeInteger(reading) ||
    reading < state.mileage ||
    String(payload.reading).trim() === ''
  )
    fail(`里程须为不小于 ${state.mileage} 的整数。`);
  if (!Array.isArray(payload.attachments) || !payload.attachments.length)
    fail('请选择一张仪表照片作为演示凭证。');
  state.sequence += 1;
  const item = fixture.record(
    'services',
    `demo-mileage-${state.sequence}`,
    '月度里程复核',
    '本地演示 · 等待复核',
    'SUBMITTED',
    '待复核',
    [
      { label: '上次确认', value: `${state.mileage} km` },
      { label: '本次申报', value: `${reading} km` },
      { label: '备注', value: String(payload.comment || '无').slice(0, 500) },
      { label: '凭证', value: attachmentSummary(payload.attachments) },
    ],
  );
  // 申报不覆盖最后已确认读数；计费与里程审核留给服务端。
  state.records.services.unshift(item);
  write(state);
  return clone(item);
}
async function submitHandover(payload) {
  const state = await ready();
  assertActive(state);
  if (state.handover) fail('本次交接已提交演示响应，请查看服务记录；可重置演示后再体验。');
  const objection = ['object', 'objection', 'dispute'].includes(payload.decision);
  if (!objection && payload.decision !== 'confirm') fail('请选择确认或提出异议。');
  if (!payload.evidenceRead) fail('请先阅读交接证据。');
  if (objection && !String(payload.note || '').trim()) fail('请说明需要核对的交接事实。');
  if (!objection && (!String(payload.name || '').trim() || !payload.accepted))
    fail('请填写姓名并确认已阅读交接事实。');
  const item = fixture.record(
    'services',
    'demo-handover',
    '交接事实核对',
    '确认事实后仍需独立签署交接单',
    objection ? 'OBJECTION_SUBMITTED' : 'CUSTOMER_CONFIRMED',
    objection ? '异议待处理' : '事实已确认 · 待签署',
    [
      {
        label: '响应',
        value: objection
          ? String(payload.note).slice(0, 1000)
          : `本地确认人：${String(payload.name).trim()}`,
      },
      { label: '签署', value: '未签署交接单，未改变实际交付状态' },
    ],
  );
  state.handover = item;
  state.records.services.unshift(item);
  write(state);
  return clone(item);
}
function setScenario(scenario) {
  if (!['new', 'review', 'confirm', 'active'].includes(scenario)) fail('无效演示场景。');
  write(fixture.initialState(scenario));
  return getContext();
}
function setFault(fault) {
  if (!['none', 'empty', 'error'].includes(fault)) fail('无效演示状态。');
  const state = read();
  state.fault = fault;
  write(state);
  return getContext();
}
function resetDemo() {
  write(fixture.initialState());
  return getContext();
}
module.exports = {
  getContext,
  getHome,
  getVehicles,
  getVehicle,
  getDashboard,
  getApplication,
  submitApplication,
  getRecords,
  getRecord,
  performAction,
  saveProfile,
  submitService,
  submitMileage,
  submitHandover,
  setScenario,
  setFault,
  resetDemo,
};
