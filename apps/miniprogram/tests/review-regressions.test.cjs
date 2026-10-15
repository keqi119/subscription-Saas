const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { compile } = require('../scripts/compile-templates.cjs');
const config = require('../src/config');
const fixture = require('../src/services/fixtures');
const memory = new Map();
global.wx = {
  getStorageSync: (key) => memory.get(key),
  setStorageSync: (key, value) => memory.set(key, structuredClone(value)),
  removeStorageSync: (key) => memory.delete(key),
};
const service = require('../src/services/index');
beforeEach(() => {
  memory.clear();
  service.resetDemo();
});

const revisedPlan = {
  revision: 2,
  vehicleName: '修订后的家庭 SUV',
  planTitle: '18 个月 · 家庭出行',
  termMonths: 18,
  monthlyFeeText: '¥4,899.01',
  depositText: '¥7,500.00',
  mileageText: '每月 2,100 公里',
  energyText: '充电按实际另计，每月赠送 50 度电',
  benefits: ['修订后的基础保障', '每期一次车况复核'],
  notes: '超里程每公里 ¥0.80；提前退出按最终合同结算。',
};
function pendingRevisionWithActiveOrder() {
  const state = fixture.initialState('active');
  state.application = fixture.initialState('confirm').application;
  state.application.finalPlan = structuredClone(revisedPlan);
  wx.setStorageSync(config.storageKey, state);
}
function findByClass(node, target) {
  if (!node || typeof node !== 'object') return null;
  if (
    String((node.attr && node.attr.class) || '')
      .split(' ')
      .includes(target)
  )
    return node;
  for (const child of node.children || []) {
    const found = findByClass(child, target);
    if (found) return found;
  }
  return null;
}

test('active customer applying for another vehicle keeps the current subscription and service access', async () => {
  service.setScenario('active');
  const original = (await service.getDashboard()).subscription;
  await service.submitApplication({
    vehicleId: 'demo-suv',
    planId: 'demo-suv-12',
    name: '演示用户',
    mobile: '13800000000',
    accepted: true,
  });
  const dashboard = await service.getDashboard();
  assert.deepEqual(dashboard.subscription, original);
  assert.equal(dashboard.application.vehicleName, '家庭纯电 · 五座 SUV');
  const request = await service.submitService({
    type: 'rescue',
    location: '演示地点',
    description: '轮胎需要检查',
    mobile: '13800000000',
    attachments: [],
  });
  assert.equal(request.status, 'SUBMITTED');
  assert.equal((await service.getDashboard()).services[0].id, request.id);
});

test('confirmed order uses revision 2 terms and preserves the existing active order', async () => {
  pendingRevisionWithActiveOrder();
  await service.performAction('application', 'demo-application', 'confirm', { revision: 2 });
  const orders = await service.getRecords('orders');
  assert.equal(orders[0].subtitle, '修订后的家庭 SUV');
  assert.equal(orders[0].status, 'PENDING_SIGN');
  assert.equal(orders[0].revision, 2);
  assert.deepEqual(orders[0].finalPlanSnapshot, revisedPlan);
  const details = Object.fromEntries(orders[0].details.map((item) => [item.label, item.value]));
  assert.equal(details['订阅套餐'], '18 个月 · 家庭出行');
  assert.equal(details['月费'], '¥4,899.01');
  assert.equal(details['订阅期限'], '18 个月');
  assert.equal(details['包含里程'], '每月 2,100 公里');
  assert.equal(orders.length, 2);
  assert.equal(orders[1].id, 'demo-order');
  assert.equal(orders[1].status, 'ACTIVE');
  assert.equal((await service.getDashboard()).subscription.id, 'demo-order');
  const state = wx.getStorageSync(config.storageKey);
  state.application.finalPlan.benefits[0] = '后续修改';
  wx.setStorageSync(config.storageKey, state);
  assert.equal(
    (await service.getRecords('orders'))[0].finalPlanSnapshot.benefits[0],
    '修订后的基础保障',
  );
});

test('confirmation fixture supplies readable mileage, energy, benefits and complete conditions', async () => {
  service.setScenario('confirm');
  const plan = (await service.getApplication()).finalPlan;
  assert.equal(plan.termMonths, 12);
  assert.equal(plan.mileageText, '每月 1,500 公里');
  assert.equal(plan.energyText, '充电费用按实际使用另计');
  assert.deepEqual(plan.benefits, ['基础车辆保障（以合同为准）', '日常用车服务入口']);
  assert.match(plan.notes, /超里程/);
  assert.match(plan.notes, /提前退出/);
});

test('final-plan card renders the actual revised term and every usage condition before consent', async () => {
  pendingRevisionWithActiveOrder();
  const application = await service.getApplication();
  const compiled = compile();
  const generate = vm.runInNewContext('(function(global){' + compiled.wxml + '})({})', {
    window: {},
    console,
  });
  const tree = generate('pages/application-detail/index.wxml')({
    application,
    loading: false,
    error: '',
    busy: false,
    planRead: false,
  });
  const card = findByClass(tree, 'final-plan');
  assert.ok(card, 'rendered final-plan card exists');
  const rendered = JSON.stringify(card);
  assert.match(rendered, /订阅期限/);
  assert.match(rendered, /18/);
  for (const text of [
    revisedPlan.mileageText,
    revisedPlan.energyText,
    ...revisedPlan.benefits,
    revisedPlan.notes,
  ])
    assert.ok(rendered.includes(text), 'final-plan card displays ' + text);
});

test('a stale revision cannot confirm or reject a changed final plan or mutate existing orders', async () => {
  pendingRevisionWithActiveOrder();
  for (const action of ['confirm', 'reject']) {
    await assert.rejects(
      service.performAction('application', 'demo-application', action, { revision: 1 }),
      (error) => error.code === 'REVISION_CONFLICT',
    );
  }
  assert.equal((await service.getApplication()).status, 'AWAITING_CONFIRMATION');
  const orders = await service.getRecords('orders');
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, 'ACTIVE');
});
