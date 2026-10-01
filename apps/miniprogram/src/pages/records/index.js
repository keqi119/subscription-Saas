const services = require('../../services/index');
const { load, go } = require('../../utils/page');
const TITLES = {
  orders: '订阅与订单',
  contracts: '合同文件',
  bills: '账单',
  payments: '支付记录',
  deposits: '押金流水',
  entitlements: '权益明细',
  notifications: '消息通知',
  services: '服务记录',
};
Page({
  data: { type: '', title: '记录', loading: true, error: '', items: [] },
  onLoad(options) {
    const type = options.type || 'orders';
    this.setData({ type, title: TITLES[type] || '记录' });
    wx.setNavigationBarTitle({ title: this.data.title });
  },
  onShow() {
    this.reload();
  },
  reload() {
    return load(this, async () => {
      if (!TITLES[this.data.type]) throw new Error('无法识别记录类型，请从“我的”重新进入。');
      return { items: await services.getRecords(this.data.type) };
    });
  },
  openRecord(e) {
    go(
      '/pages/record/index?type=' +
        this.data.type +
        '&id=' +
        encodeURIComponent(e.currentTarget.dataset.id),
    );
  },
  openMine() {
    go('/pages/mine/index');
  },
});
