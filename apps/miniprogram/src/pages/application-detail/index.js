const service = require('../../services/index');
const { load, go, toastError, confirm } = require('../../utils/page');

Page({
  data: {
    loading: true,
    error: '',
    busy: false,
    application: null,
    planRead: false,
    actionMessage: '',
    actionError: '',
  },
  onLoad(options) {
    this.applicationId = options.id;
  },
  onShow() {
    this.refresh();
  },
  refresh() {
    return load(this, async () => {
      const application = await service.getApplication(this.applicationId);
      return { application, planRead: false };
    });
  },
  onPlanRead(event) {
    this.setData({ planRead: event.detail.value.includes('read'), actionError: '' });
  },
  openCatalog() {
    go('/pages/catalog/index');
  },
  openUse() {
    go('/pages/use/index');
  },
  async confirmPlan() {
    return this.act('confirm');
  },
  async rejectPlan() {
    return this.act('reject');
  },
  async cancelApplication() {
    const application = this.data.application;
    if (
      this.data.busy ||
      !application ||
      !['SUBMITTED', 'AWAITING_CONFIRMATION'].includes(application.status)
    )
      return;
    this.setData({ busy: true, actionError: '', actionMessage: '' });
    try {
      const accepted = await confirm(
        '取消这份演示申请？',
        '取消后将停止当前申请流程。此操作只更新本机演示记录；之后可以重新选择车辆和套餐申请。',
      );
      if (!accepted) return;
      const result = await service.performAction('application', application.id, 'cancel');
      this.setData({ actionMessage: result.message || '演示申请已取消。' });
      await this.refresh();
    } catch (error) {
      this.setData({ actionError: error.message || '取消失败，请稍后重试。' });
      toastError(error);
    } finally {
      this.setData({ busy: false });
    }
  },
  async act(action) {
    const application = this.data.application;
    if (
      this.data.busy ||
      !application ||
      application.status !== 'AWAITING_CONFIRMATION' ||
      !application.finalPlan
    )
      return;
    if (action === 'confirm' && !this.data.planRead) {
      this.setData({ actionError: '请先阅读并勾选确认最终方案内容。' });
      return;
    }
    this.setData({ busy: true, actionError: '', actionMessage: '' });
    try {
      const accepted = await confirm(
        action === 'confirm' ? '确认这份最终方案？' : '暂不接受这份方案？',
        action === 'confirm'
          ? '你将确认当前展示的方案版本。本地演示随后进入待签约流程，不会真实签约或扣款。'
          : '本地演示将记录你暂不接受当前方案，不会生成该方案的订单。',
      );
      if (!accepted) return;
      const result = await service.performAction('application', application.id, action, {
        revision: application.finalPlan.revision,
      });
      this.setData({ actionMessage: result.message || '演示处理已保存。' });
      await this.refresh();
    } catch (error) {
      this.setData({
        actionError: error.message || '操作失败，请刷新方案后重试。',
        planRead: false,
      });
      toastError(error);
    } finally {
      this.setData({ busy: false });
    }
  },
});
