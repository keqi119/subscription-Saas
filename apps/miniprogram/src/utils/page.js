async function load(page, loader) {
  const revision = (page._loadRevision || 0) + 1;
  page._loadRevision = revision;
  page.setData({ loading: true, error: '' });
  try {
    const result = await loader();
    if (page._loadRevision === revision)
      page.setData(Object.assign({}, result || {}, { loading: false, error: '' }));
    return result;
  } catch (error) {
    if (page._loadRevision === revision)
      page.setData({ loading: false, error: error.message || '暂时无法加载，请重试。' });
    return null;
  }
}
function go(url) {
  if (typeof url !== 'string' || !url.startsWith('/pages/')) return;
  const tabs = [
    '/pages/home/index',
    '/pages/catalog/index',
    '/pages/use/index',
    '/pages/mine/index',
  ];
  const path = url.split('?')[0];
  const method = tabs.includes(path) ? 'switchTab' : 'navigateTo';
  wx[method]({
    url: method === 'switchTab' ? path : url,
    fail() {
      wx.showToast({ title: '页面暂时无法打开', icon: 'none' });
    },
  });
}
function toastError(error) {
  wx.showToast({
    title: typeof error === 'string' ? error : error.message || '操作失败，请重试',
    icon: 'none',
    duration: 2600,
  });
}
function confirm(title, content) {
  return new Promise((resolve) =>
    wx.showModal({
      title,
      content,
      confirmColor: '#252723',
      success: (result) => resolve(Boolean(result.confirm)),
      fail: () => resolve(false),
    }),
  );
}
module.exports = { load, go, toastError, confirm };
