const config = require('../config');
const mock = require('./mock');
const { createApi } = require('./api');
function pending() {
  return Promise.reject(
    Object.assign(
      new Error('当前仅接入公开选车目录。客户会话与此功能需在后台准入后联调，未发送请求。'),
      { code: 'INTEGRATION_PENDING' },
    ),
  );
}
function readonlySetting() {
  throw new Error('API 模式不能切换或写入演示场景。');
}
if (config.mode === 'mock') module.exports = mock;
else if (config.mode === 'api') {
  const api = createApi(config, (options) => wx.request(options));
  module.exports = {
    ...api,
    getContext: () => ({ mode: 'api', scenario: 'new', fault: 'none', profile: null }),
    getDashboard: pending,
    getApplication: pending,
    submitApplication: pending,
    getRecords: pending,
    getRecord: pending,
    performAction: pending,
    saveProfile: pending,
    submitService: pending,
    submitMileage: pending,
    submitHandover: pending,
    setScenario: readonlySetting,
    setFault: readonlySetting,
    resetDemo: readonlySetting,
  };
} else throw new Error('未知数据模式，请检查 config.js；不会自动回退 Mock。');
