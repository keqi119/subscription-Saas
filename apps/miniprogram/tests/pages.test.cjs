const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const memory = new Map();
let navigations = [];
let toasts = [];
global.wx = {
  getStorageSync: (key) => memory.get(key),
  setStorageSync: (key, value) => memory.set(key, JSON.parse(JSON.stringify(value))),
  removeStorageSync: (key) => memory.delete(key),
  setNavigationBarTitle() {},
  navigateTo: (value) => navigations.push(value.url),
  switchTab: (value) => navigations.push(value.url),
  showToast: (value) => toasts.push(value.title),
  showModal: (value) => value.success({ confirm: true }),
  chooseMedia: (value) =>
    value.success({
      tempFiles: [
        { tempFilePath: '/private/local-only-example.png', size: 1024, fileType: 'image' },
      ],
    }),
  previewImage() {},
  request() {
    assert.fail('Mock 页面不得发出网络请求');
  },
  uploadFile() {
    assert.fail('演示附件不得上传');
  },
};
const service = require('../src/services/index');
const event = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
function createPage(name, options = {}) {
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  const file = path.resolve(__dirname, `../src/pages/${name}/index.js`);
  delete require.cache[file];
  require(file);
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data || {})),
    setData(value) {
      Object.assign(this.data, value);
    },
  });
  if (page.onLoad) page.onLoad(options);
  if (page.onShow) page.onShow();
  return page;
}
async function settled(page) {
  const end = Date.now() + 3000;
  while (page.data.loading && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(page.data.loading, false, '页面在期限内完成加载');
  return page;
}
beforeEach(() => {
  memory.clear();
  service.resetDemo();
  navigations = [];
  toasts = [];
});
test('实际页面：四Tab及八类记录均加载；合法详情保持来源类型', async () => {
  service.setScenario('active');
  for (const name of ['home', 'catalog', 'use', 'mine']) {
    const page = await settled(createPage(name));
    assert.equal(page.data.error, '');
  }
  for (const type of [
    'orders',
    'contracts',
    'bills',
    'payments',
    'deposits',
    'entitlements',
    'notifications',
    'services',
  ]) {
    const page = await settled(createPage('records', { type }));
    assert.equal(page.data.error, '');
    if (page.data.items.length) {
      page.openRecord({ currentTarget: { dataset: { id: page.data.items[0].id } } });
      assert.match(navigations.at(-1), new RegExp('type=' + type));
    }
  }
});
test('实际页面：填表、同意、提交审核和返回已提交申请', async () => {
  const page = await settled(
    createPage('application', { vehicleId: 'demo-sedan', planId: 'demo-sedan-12' }),
  );
  await page.submit();
  assert.ok(page.data.formError);
  assert.equal(navigations.length, 0);
  page.onName(event('', '体验客户'));
  page.onMobile(event('', '13800000000'));
  page.onAccepted(event('', ['accepted']));
  await Promise.all([page.submit(), page.submit()]);
  assert.equal(navigations.length, 1);
  assert.equal((await service.getApplication()).status, 'SUBMITTED');
  const detail = await settled(createPage('application-detail', { id: page.data.submittedId }));
  assert.equal(detail.data.application.depositText, '审核后确认');
  assert.equal((await service.getRecords('orders')).length, 0);
});
test('实际页面：最终方案必须阅读，确认后仍未签约支付', async () => {
  service.setScenario('confirm');
  const page = await settled(createPage('application-detail', { id: 'demo-application' }));
  await page.confirmPlan();
  assert.match(page.data.actionError, /阅读/);
  page.onPlanRead(event('', ['read']));
  await page.confirmPlan();
  assert.equal(page.data.application.status, 'FINAL_PLAN_CONFIRMED');
  assert.equal((await service.getRecords('orders'))[0].status, 'PENDING_SIGN');
  assert.equal((await service.getRecords('payments')).length, 0);
});
test('实际页面：资料保存使用同一数据层，重载能读回', async () => {
  const page = await settled(createPage('profile'));
  page.input(event('name', '体验客户'));
  page.input(event('mobile', '13800000000'));
  page.input(event('drivingYears', '5'));
  await page.submit();
  assert.match(page.data.message, /本机/);
  const again = await settled(createPage('profile'));
  assert.equal(again.data.name, '体验客户');
  assert.equal(again.data.drivingYears, '5');
});
test('实际页面：救援和事故保留字段，附件只存元数据且不会派车', async () => {
  service.setScenario('active');
  for (const type of ['rescue', 'accident']) {
    const page = await settled(createPage('service', { type }));
    page.input(event('location', '上海 · 示例停车场'));
    page.input(event('description', '车辆无法启动需要核对'));
    await page.chooseAttachments();
    assert.equal(JSON.stringify(page.data.attachments).includes('/private'), false);
    await Promise.all([page.submit(), page.submit()]);
    assert.equal(page.data.submitted.status, 'SUBMITTED');
    assert.match(page.data.submitted.subtitle, /未派车/);
    page.openRecord();
    assert.match(navigations.at(-1), /type=services/);
  }
  assert.equal((await service.getRecords('services')).length, 2);
});
test('实际页面：里程凭证及交接异议保留独立门槛', async () => {
  service.setScenario('active');
  const handover = await settled(createPage('handover'));
  await handover.submit();
  assert.equal(handover.data.submitted, null);
  assert.match(toasts.at(-1), /证据/);
  handover.showEvidence();
  handover.acknowledgeEvidence();
  handover.selectDecision({ currentTarget: { dataset: { value: 'dispute' } } });
  handover.input(event('note', '交接外观照片需要重新核对'));
  handover.consent(event('', ['accepted']));
  await handover.submit();
  assert.equal(handover.data.submitted.status, 'OBJECTION_SUBMITTED');
  assert.match(handover.data.submitted.details[1].value, /未签署/);
});
test('实际页面：错误、空态可通过设置恢复；非法记录不会访问其他路径', async () => {
  service.setFault('error');
  const page = await settled(createPage('catalog'));
  assert.ok(page.data.error);
  const settings = createPage('settings');
  settings.changeFault({ currentTarget: { dataset: { id: 'empty' } } });
  const empty = await settled(createPage('records', { type: 'orders' }));
  assert.deepEqual(empty.data.items, []);
  settings.changeFault({ currentTarget: { dataset: { id: 'none' } } });
  const catalog = await settled(createPage('catalog'));
  assert.equal(catalog.data.error, '');
  const invalid = await settled(createPage('records', { type: '__proto__' }));
  assert.ok(invalid.data.error);
  assert.equal(navigations.length, 0);
});
test('支付说明不把账单改为已付；通知已读独立更新', async () => {
  service.setScenario('active');
  const payment = await service.performAction('bills', 'demo-bill', 'pay', {});
  assert.match(payment.message, /未发起交易/);
  assert.equal((await service.getRecord('bills', 'demo-bill')).status, 'PENDING');
  await service.performAction('notifications', 'demo-notice', 'read', {});
  assert.equal((await service.getRecord('notifications', 'demo-notice')).status, 'READ');
});
