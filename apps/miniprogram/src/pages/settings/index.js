const services = require('../../services/index');
const { toastError, confirm, go } = require('../../utils/page');
Page({
  data: {
    mode: 'mock',
    scenario: 'new',
    fault: 'none',
    busy: false,
    error: '',
    message: '',
    scenarios: [
      { id: 'new', title: '新客', description: '浏览车辆，尚未提交申请' },
      { id: 'review', title: '申请审核中', description: '查看审核进度与意向方案' },
      { id: 'confirm', title: '待确认最终方案', description: '核对最终方案并表达意见' },
      { id: 'active', title: '用车中', description: '查看账单，体验服务与交接' },
    ],
    faults: [
      { id: 'none', title: '正常' },
      { id: 'empty', title: '空数据' },
      { id: 'error', title: '加载失败' },
    ],
  },
  onShow() {
    this.refresh();
  },
  refresh() {
    try {
      const context = services.getContext();
      this.setData({
        mode: context.mode,
        scenario: context.scenario,
        fault: context.fault,
        error: '',
      });
    } catch (error) {
      this.setData({ error: error.message || '设置读取失败' });
    }
  },
  async changeScenario(e) {
    if (this.data.busy || this.data.mode !== 'mock') return;
    const scenario = e.currentTarget.dataset.id;
    if (scenario === this.data.scenario) return;
    this.setData({ busy: true });
    try {
      if (
        !(await confirm('切换演示场景', '将切换本机样例流程与记录，继续前请确认已完成当前演示。'))
      )
        return;
      services.setScenario(scenario);
      this.refresh();
      this.setData({ message: '已切换演示场景，返回页面可查看。' });
    } catch (error) {
      toastError(error);
    } finally {
      this.setData({ busy: false });
    }
  },
  changeFault(e) {
    if (this.data.busy || this.data.mode !== 'mock') return;
    this.setData({ busy: true });
    try {
      services.setFault(e.currentTarget.dataset.id);
      this.refresh();
      this.setData({ message: '已更新故障模式。可随时在本页恢复正常。' });
    } catch (error) {
      toastError(error);
    } finally {
      this.setData({ busy: false });
    }
  },
  async reset() {
    if (this.data.busy || this.data.mode !== 'mock') return;
    this.setData({ busy: true });
    try {
      if (
        !(await confirm(
          '重置本地演示',
          '将清除本机演示申请、资料及服务记录，恢复新客与正常模式。此操作不涉及任何后台数据。',
        ))
      )
        return;
      services.resetDemo();
      this.refresh();
      this.setData({ message: '本地演示已重置。' });
    } catch (error) {
      toastError(error);
    } finally {
      this.setData({ busy: false });
    }
  },
  openHome() {
    go('/pages/home/index');
  },
});
