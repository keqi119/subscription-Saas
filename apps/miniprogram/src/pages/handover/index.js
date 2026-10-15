const services = require('../../services/index');
const { load, go, toastError } = require('../../utils/page');
Page({
  data: {
    loading: true,
    error: '',
    subscription: null,
    decision: 'confirm',
    name: '',
    note: '',
    evidenceOpen: false,
    evidenceRead: false,
    accepted: false,
    busy: false,
    submitted: null,
  },
  onLoad() {
    this.reload();
  },
  reload() {
    return load(this, async () => ({
      subscription: (await services.getDashboard()).subscription || null,
      name: (services.getContext().profile || {}).name || '',
    }));
  },
  input(e) {
    const key = e.currentTarget.dataset.field;
    if (['name', 'note'].includes(key)) this.setData({ [key]: e.detail.value });
  },
  selectDecision(e) {
    if (!this.data.busy && ['confirm', 'dispute'].includes(e.currentTarget.dataset.value))
      this.setData({ decision: e.currentTarget.dataset.value, accepted: false });
  },
  showEvidence() {
    this.setData({ evidenceOpen: !this.data.evidenceOpen });
  },
  acknowledgeEvidence() {
    if (this.data.evidenceOpen) this.setData({ evidenceRead: true });
  },
  consent(e) {
    this.setData({ accepted: e.detail.value.includes('accepted') });
  },
  async submit() {
    if (this.data.busy || this.data.submitted) return;
    if (!this.data.subscription) return toastError(new Error('当前没有可确认的交接'));
    if (!this.data.evidenceRead) return toastError(new Error('请先展开并阅读交接证据'));
    const name = this.data.name.trim();
    const note = this.data.note.trim();
    if (!name) return toastError(new Error('请填写示例确认人姓名'));
    if (this.data.decision === 'dispute' && note.length < 5)
      return toastError(new Error('请至少用 5 个字说明异议'));
    if (!this.data.accepted) return toastError(new Error('请勾选当前意见确认'));
    this.setData({ busy: true });
    try {
      const submitted = await services.submitHandover({
        decision: this.data.decision,
        name,
        note,
        evidenceRead: this.data.evidenceRead,
        accepted: this.data.accepted,
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
