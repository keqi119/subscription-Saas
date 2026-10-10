const services = require('../../services/index');
const { load, go, toastError, confirm } = require('../../utils/page');
const TYPES = [
  'orders',
  'contracts',
  'bills',
  'payments',
  'deposits',
  'entitlements',
  'notifications',
  'services',
];
Page({
  data: { type: '', id: '', loading: true, error: '', record: null, busy: false, message: '' },
  onLoad(options) {
    this.setData({ type: options.type || '', id: options.id || '' });
    this.reload();
  },
  reload() {
    return load(this, async () => {
      if (!TYPES.includes(this.data.type) || !this.data.id)
        throw new Error('记录地址不完整，请从记录列表重新进入。');
      return { record: await services.getRecord(this.data.type, this.data.id) };
    });
  },
  async act(e) {
    if (this.data.busy) return;
    const action = (this.data.record.actions || []).find(
      (item) => item.id === e.currentTarget.dataset.action,
    );
    if (!action) return;
    this.setData({ busy: true, message: '' });
    try {
      const accepted = await confirm(
        action.label,
        '本次操作仅作用于本地演示。真实支付、签约与服务处理需要后台接入。',
      );
      if (!accepted) return;
      const result = await services.performAction(this.data.type, this.data.id, action.id, {});
      this.setData({
        message: result.message || '已更新本地演示记录',
        record: result.record || this.data.record,
      });
    } catch (error) {
      toastError(error);
    } finally {
      this.setData({ busy: false });
    }
  },
  openList() {
    go('/pages/records/index?type=' + (TYPES.includes(this.data.type) ? this.data.type : 'orders'));
  },
});
