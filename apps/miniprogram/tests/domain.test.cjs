const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const memory = new Map();
global.wx = {
  getStorageSync: (key) => memory.get(key),
  setStorageSync: (key, value) => memory.set(key, JSON.parse(JSON.stringify(value))),
  removeStorageSync: (key) => memory.delete(key),
};
const { money } = require('../src/utils/format');
const service = require('../src/services/index');
beforeEach(() => {
  memory.clear();
  service.resetDemo();
});
test('金额保留一分钱，区分零与待确认，不接收字符串和非整数', () => {
  assert.equal(money(1), '¥0.01');
  assert.equal(money(0), '¥0.00');
  assert.equal(money(null), '待确认');
  assert.equal(money(undefined), '待确认');
  assert.equal(money('399900'), '待确认');
  assert.equal(money(1.4), '待确认');
  assert.equal(money(329900), '¥3,299.00');
});
test('默认新客目录仅为本地样例，品牌和关键字筛选真实生效', async () => {
  assert.equal(service.getContext().mode, 'mock');
  const all = await service.getVehicles({});
  assert.ok(all.items.length >= 2);
  const brand = all.items[0].brand;
  const filtered = await service.getVehicles({ brand });
  assert.ok(filtered.items.every((item) => item.brand === brand));
  assert.equal((await service.getVehicles({ query: 'does-not-exist' })).items.length, 0);
});
test('申请只进入审核，押金待确认，重复提交不产生新单', async () => {
  const vehicle = (await service.getVehicles({})).items.find((item) => item.available);
  const plan = (await service.getVehicle(vehicle.id)).plans.find((item) => item.available);
  const payload = {
    vehicleId: vehicle.id,
    planId: plan.id,
    name: '体验客户',
    mobile: '13800000000',
    accepted: true,
  };
  const result = await service.submitApplication(payload);
  assert.equal(result.status, 'SUBMITTED');
  assert.equal(result.depositText, '审核后确认');
  assert.equal((await service.getRecords('orders')).length, 0);
  const again = await service.submitApplication(payload);
  assert.equal(again.id, result.id);
});
test('拒绝缺少同意、无效手机号、不可售车辆和错配套餐', async () => {
  const items = (await service.getVehicles({})).items;
  const available = items.find((item) => item.available);
  const unavailable = items.find((item) => !item.available);
  const plan = (await service.getVehicle(available.id)).plans[0];
  const valid = {
    vehicleId: available.id,
    planId: plan.id,
    name: '体验客户',
    mobile: '13800000000',
    accepted: true,
  };
  await assert.rejects(service.submitApplication({ ...valid, accepted: false }));
  await assert.rejects(service.submitApplication({ ...valid, mobile: '123' }));
  await assert.rejects(service.submitApplication({ ...valid, vehicleId: unavailable.id }));
  await assert.rejects(service.submitApplication({ ...valid, planId: 'unknown' }));
});
test('错误/空态可独立恢复，不覆盖持久业务状态', async () => {
  service.setScenario('active');
  service.setFault('error');
  await assert.rejects(service.getDashboard());
  service.setFault('empty');
  assert.deepEqual((await service.getVehicles({})).items, []);
  service.setFault('none');
  assert.ok((await service.getDashboard()).subscription);
});
test('交接异议与确认门槛保留，里程不能倒退', async () => {
  service.setScenario('active');
  await assert.rejects(
    service.submitHandover({
      decision: 'confirm',
      name: '体验客户',
      evidenceRead: false,
      accepted: true,
    }),
  );
  await assert.rejects(service.submitHandover({ decision: 'object', note: '' }));
  await assert.rejects(service.submitMileage({ reading: 1, attachments: [] }));
  const result = await service.submitHandover({
    decision: 'object',
    note: '右侧外观需要核对',
    evidenceRead: true,
  });
  assert.equal(result.status, 'OBJECTION_SUBMITTED');
});
