const service = require('../../services/index');
const { load, go } = require('../../utils/page');

Page({
  data: { loading: true, error: '', vehicles: [], context: {}, nextAction: null, faqOpen: false },
  onShow() {
    this.refresh();
  },
  refresh() {
    return load(this, () => service.getHome());
  },
  openCatalog() {
    go('/pages/catalog/index');
  },
  openVehicle(event) {
    go('/pages/vehicle/index?vehicleId=' + encodeURIComponent(event.currentTarget.dataset.id));
  },
  openNext() {
    if (this.data.nextAction && this.data.nextAction.url) go(this.data.nextAction.url);
  },
  toggleFaq() {
    this.setData({ faqOpen: !this.data.faqOpen });
  },
});
