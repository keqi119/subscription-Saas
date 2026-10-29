const services = require('../../services/index');
const { load, go, toastError } = require('../../utils/page');
Page({
  data: {
    type: 'rescue',
    title: '道路救援',
    loading: true,
    error: '',
    subscription: null,
    location: '',
    description: '',
    mobile: '',
    attachments: [],
    busy: false,
    choosing: false,
    submitted: null,
  },
  onLoad(options) {
    this.invalidType = options.type && !['rescue', 'accident'].includes(options.type);
    const type = options.type === 'accident' ? 'accident' : 'rescue';
    this.setData({ type, title: type === 'accident' ? '事故报案' : '道路救援' });
    wx.setNavigationBarTitle({ title: this.data.title });
    this.reload();
  },
  reload() {
    return load(this, async () => {
      if (this.invalidType) throw new Error('无法识别服务类型，请从用车页重新进入。');
      const dashboard = await services.getDashboard();
      return {
        subscription: dashboard.subscription || null,
        mobile: (services.getContext().profile || {}).mobile || '',
      };
    });
  },
  input(e) {
    const key = e.currentTarget.dataset.field;
    if (['location', 'description', 'mobile'].includes(key))
      this.setData({ [key]: e.detail.value });
  },
  async chooseAttachments() {
    if (this.data.busy || this.data.choosing) return;
    if (this.data.attachments.length >= 4) return toastError(new Error('最多添加 4 个本地附件'));
    this.setData({ choosing: true });
    try {
      const result = await new Promise((resolve, reject) =>
        wx.chooseMedia({
          count: 4 - this.data.attachments.length,
          mediaType: ['image'],
          sourceType: ['album', 'camera'],
          success: resolve,
          fail: reject,
        }),
      );
      const files = result.tempFiles || [];
      if (files.some((file) => file.size > 20 * 1024 * 1024))
        throw new Error('单张图片请小于 20 MB');
      this.setData({
        attachments: this.data.attachments.concat(
          files.map((file, index) => ({
            name: '本地图片 ' + (this.data.attachments.length + index + 1),
            size: file.size || 0,
            type: 'image',
            localOnly: true,
          })),
        ),
      });
    } catch (error) {
      if (!/cancel/i.test(error.errMsg || error.message || '')) toastError(error);
    } finally {
      this.setData({ choosing: false });
    }
  },
  removeAttachment(e) {
    if (!this.data.busy)
      this.setData({
        attachments: this.data.attachments.filter(
          (_, index) => index !== Number(e.currentTarget.dataset.index),
        ),
      });
  },
  async submit() {
    if (this.data.busy || this.data.choosing || this.data.submitted) return;
    if (!this.data.subscription) return toastError(new Error('当前没有可办理服务的订阅'));
    const location = this.data.location.trim();
    const description = this.data.description.trim();
    const mobile = this.data.mobile.trim();
    if (location.length < 2) return toastError(new Error('请填写具体位置'));
    if (description.length < 5) return toastError(new Error('请至少用 5 个字描述情况'));
    if (!/^1[3-9]\d{9}$/.test(mobile)) return toastError(new Error('请填写 11 位示例手机号'));
    this.setData({ busy: true });
    try {
      const submitted = await services.submitService({
        type: this.data.type,
        location,
        description,
        mobile,
        attachments: this.data.attachments,
      });
      this.setData({ submitted });
    } catch (error) {
      toastError(error);
    } finally {
      this.setData({ busy: false });
    }
  },
  openRecord() {
    if (this.data.submitted)
      go('/pages/record/index?type=services&id=' + encodeURIComponent(this.data.submitted.id));
  },
  openUse() {
    go('/pages/use/index');
  },
});
