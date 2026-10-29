// 默认只读取本地 Mock。后台验收完成后，手动改 mode 为 api 并填 apiBase。
// API 模式仅开放匿名 catalog GET；不回退 Mock，不读取管理端 Cookie/令牌。
module.exports = Object.freeze({
  mode: 'mock',
  apiBase: '',
  requestTimeout: 10000,
  mockDelay: 160,
  storageKey: 'ev-subscription:miniprogram:mock:v1',
  sourceVersion: 'f8ed944030646bb697c4724e9071b1151e64e5ef',
});
