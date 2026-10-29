const service = require('../../services/index');
const { load, go, toastError } = require('../../utils/page');

Page({
  data: {
    loading: true,
    error: '',
    vehicle: null,
    plans: [],
    report: null,
    selectedPlan: null,
    showConditions: false,
    showReport: false,
  },
  onLoad(options) {
    this.vehicleId = options.vehicleId || options.id;
  },
  onShow() {
    this.refresh();
  },
  refresh() {
    return load(this, async () => {
      if (!this.vehicleId) throw new Error('缺少车辆编号，请返回选车页重新选择。');
      const result = await service.getVehicle(this.vehicleId);
      const plans = result.plans || [];
      const previousId = this.data.selectedPlan && this.data.selectedPlan.id;
      const selectedPlan =
        plans.find((plan) => plan.id === previousId && plan.available) ||
        plans.find((plan) => plan.available) ||
        null;
      return { ...result, plans, selectedPlan };
    });
  },
  selectPlan(event) {
    const selectedPlan = this.data.plans.find(
      (plan) => plan.id === event.currentTarget.dataset.id && plan.available,
    );
    if (selectedPlan) this.setData({ selectedPlan });
  },
  toggleConditions() {
    this.setData({ showConditions: !this.data.showConditions });
  },
  toggleReport() {
    this.setData({ showReport: !this.data.showReport });
  },
  previewReport(event) {
    const images = (this.data.report && this.data.report.images) || [];
    const current = event.currentTarget.dataset.src;
    if (!images.includes(current)) return;
    wx.previewImage({
      current,
      urls: images,
      fail: () => toastError(new Error('资料图片暂时无法打开，请稍后重试。')),
    });
  },
  openCatalog() {
    go('/pages/catalog/index');
  },
  apply() {
    if (
      !this.data.vehicle ||
      !this.data.vehicle.available ||
      !this.data.selectedPlan ||
      !this.data.selectedPlan.available
    )
      return;
    go(
      '/pages/application/index?vehicleId=' +
        encodeURIComponent(this.data.vehicle.id) +
        '&planId=' +
        encodeURIComponent(this.data.selectedPlan.id),
    );
  },
});
