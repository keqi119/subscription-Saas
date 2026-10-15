const service = require('../../services/index');
const { load, go } = require('../../utils/page');

Page({
  data: { loading: true, error: '', items: [], brands: [], brand: '', query: '', appliedQuery: '' },
  onShow() {
    this.refresh();
  },
  refresh() {
    const token = (this._loadToken = (this._loadToken || 0) + 1);
    const params = { brand: this.data.brand, query: this.data.query.trim() };
    return load(this, async () => {
      const result = await service.getVehicles(params);
      return token === this._loadToken ? { ...result, appliedQuery: params.query } : {};
    });
  },
  onQuery(event) {
    this.setData({ query: event.detail.value });
  },
  search() {
    this.refresh();
  },
  selectBrand(event) {
    this.setData({ brand: event.currentTarget.dataset.brand || '' });
    this.refresh();
  },
  clearFilters() {
    this.setData({ brand: '', query: '' });
    this.refresh();
  },
  openVehicle(event) {
    go('/pages/vehicle/index?vehicleId=' + encodeURIComponent(event.currentTarget.dataset.id));
  },
});
