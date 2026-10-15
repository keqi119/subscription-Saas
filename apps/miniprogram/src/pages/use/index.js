const services = require('../../services/index');
const { load, go } = require('../../utils/page');
Page({
  data: {
    loading: true,
    error: '',
    subscription: null,
    application: null,
    bill: null,
    entitlements: [],
    services: [],
    todos: [],
  },
  onShow() {
    this.reload();
  },
  reload() {
    return load(this, async () =>
      Object.assign(
        {
          subscription: null,
          application: null,
          bill: null,
          entitlements: [],
          services: [],
          todos: [],
        },
        await services.getDashboard(),
      ),
    );
  },
  open(e) {
    go(e.currentTarget.dataset.url);
  },
  openApplication() {
    if (this.data.application)
      go('/pages/application-detail/index?id=' + encodeURIComponent(this.data.application.id));
  },
  openBill() {
    if (this.data.bill)
      go('/pages/record/index?type=bills&id=' + encodeURIComponent(this.data.bill.id));
  },
});
