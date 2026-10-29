const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApi, validateBase } = require('../src/services/api');
const vehicle = {
  id: 'v1',
  displayName: '真实字段样例',
  brand: '品牌',
  available: true,
  statusLabel: '可申请',
  monthlyFeeFromAmount: null,
  coverImageUrl: '/api/portal/catalog/vehicles/v1/media/m1/preview',
  currentMileageKm: 0,
};
const options = { apiBase: 'http://127.0.0.1:3310', requestTimeout: 100 };
test('适配原始数组，保留未知金额与零里程，解析同源媒体', async () => {
  let called;
  const api = createApi(options, (request) => {
    called = request;
    request.success({ statusCode: 200, data: [vehicle] });
  });
  const result = await api.getVehicles({});
  assert.equal(result.items[0].minFeeText, '待确认');
  assert.equal(result.items[0].mileageText, '0 km');
  assert.equal(result.items[0].imageUrl, options.apiBase + vehicle.coverImageUrl);
  assert.equal(called.url, options.apiBase + '/api/portal/catalog/vehicles');
  assert.equal(called.method, 'GET');
  assert.equal(called.header.Authorization, undefined);
});
test('套餐必须显式canSubmit；无价格不当零，详情无报告不发报告GET', async () => {
  const calls = [];
  const api = createApi(options, (request) => {
    calls.push(request.url);
    request.success({
      statusCode: 200,
      data: {
        ...vehicle,
        conditionDisplayMode: 'NONE',
        subscriptionPlans: [
          {
            planId: 'p1',
            planName: '预设方案',
            monthlyFeeAmount: null,
            canSubmit: false,
            subscriptionPeriodMonths: 6,
          },
        ],
      },
    });
  });
  const result = await api.getVehicle('v1');
  assert.equal(result.plans[0].available, false);
  assert.equal(result.plans[0].monthlyFeeText, '待确认');
  assert.equal(calls.length, 1);
});
test('错误不回退样例，不接受猜测的数据包装', async () => {
  const bad = createApi(options, (request) =>
    request.success({ statusCode: 200, data: { data: [vehicle] } }),
  );
  await assert.rejects(bad.getVehicles({}), { code: 'RESPONSE' });
  const offline = createApi(options, (request) => request.fail({ errMsg: 'timeout' }));
  await assert.rejects(offline.getVehicles({}), { code: 'NETWORK' });
});
test('API源要求显式填写，禁止凭据URL、任意http及路径', () => {
  for (const input of [
    '',
    'http://192.168.1.2:3310',
    'https://a:b@example.com',
    'https://example.com/api',
    'file:///x',
  ])
    assert.throws(() => validateBase(input));
  assert.equal(validateBase('https://example.com/'), 'https://example.com');
});
test('原始资料优先，结构化404不能成为车况正常承诺', async () => {
  const calls = [];
  const api = createApi(options, (request) => {
    calls.push(request.url);
    request.success(
      request.url.endsWith('/condition-report')
        ? { statusCode: 404 }
        : {
            statusCode: 200,
            data: { ...vehicle, conditionDisplayMode: 'STRUCTURED_REPORT', subscriptionPlans: [] },
          },
    );
  });
  const result = await api.getVehicle('v1');
  assert.equal(calls.length, 2);
  assert.match(result.report.notice, /不能据此判断/);
});
