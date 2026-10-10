const services = require('../../services/index');
const { load, toastError } = require('../../utils/page');
Page({
  data: {
    loading: true,
    error: '',
    name: '',
    mobile: '',
    drivingYears: '',
    busy: false,
    message: '',
    mode: 'mock',
  },
  onLoad() {
    this.reload();
  },
  reload() {
    return load(this, async () => {
      const context = services.getContext();
      return Object.assign(
        { name: '', mobile: '', drivingYears: '', mode: context.mode },
        context.profile || {},
      );
    });
  },
  input(e) {
    const key = e.currentTarget.dataset.field;
    if (['name', 'mobile', 'drivingYears'].includes(key))
      this.setData({ [key]: e.detail.value, message: '' });
  },
  async submit() {
    if (this.data.busy) return;
    const name = this.data.name.trim();
    const mobile = this.data.mobile.trim();
    const drivingYears = Number(this.data.drivingYears);
    if (!name || name.length > 30) return toastError(new Error('请填写不超过 30 字的示例姓名'));
    if (!/^1[3-9]\d{9}$/.test(mobile)) return toastError(new Error('请填写 11 位示例手机号'));
    if (
      String(this.data.drivingYears).trim() === '' ||
      !Number.isInteger(drivingYears) ||
      drivingYears < 0 ||
      drivingYears > 70
    )
      return toastError(new Error('驾龄请输入 0–70 的整数'));
    this.setData({ busy: true, message: '' });
    try {
      await services.saveProfile({ name, mobile, drivingYears });
      this.setData({ message: '示例资料已保存在本机，未上传真实证件或建立登录会话。' });
    } catch (error) {
      toastError(error);
    } finally {
      this.setData({ busy: false });
    }
  },
});
