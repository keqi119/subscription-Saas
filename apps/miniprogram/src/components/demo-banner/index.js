const service = require('../../services/index');
Component({
  data: { demo: true },
  lifetimes: {
    attached() {
      this.setData({ demo: service.getContext().mode === 'mock' });
    },
  },
  pageLifetimes: {
    show() {
      this.setData({ demo: service.getContext().mode === 'mock' });
    },
  },
  methods: {
    openSettings() {
      wx.navigateTo({ url: '/pages/settings/index' });
    },
  },
});
