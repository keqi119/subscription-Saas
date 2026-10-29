const { money, date } = require('../utils/format');
function error(message, code) {
  return Object.assign(new Error(message), { code });
}
function validateBase(value) {
  const base = String(value || '').replace(/\/$/, '');
  if (!/^https:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(base) && base !== 'http://127.0.0.1:3310')
    throw error(
      '请在 config.js 填写已验收的 API 源地址；本机仅支持 http://127.0.0.1:3310。',
      'CONFIG',
    );
  return base;
}
function createApi(options, request) {
  function get(path) {
    return new Promise((resolve, reject) => {
      let base;
      try {
        base = validateBase(options.apiBase);
      } catch (failure) {
        reject(failure);
        return;
      }
      request({
        url: `${base}/api/portal/catalog${path}`,
        method: 'GET',
        timeout: options.requestTimeout || 10000,
        header: { Accept: 'application/json' },
        success(response) {
          if (response.statusCode === 200) resolve(response.data);
          else
            reject(
              error(
                response.statusCode === 404
                  ? '车辆或公开资料暂不可用，请返回列表刷新。'
                  : '后台暂时无法处理请求，请稍后重试。',
                `HTTP_${response.statusCode}`,
              ),
            );
        },
        fail() {
          reject(error('无法连接后台，请确认服务已就绪和请求地址可达。', 'NETWORK'));
        },
      });
    });
  }
  function media(value) {
    if (typeof value !== 'string') return '';
    const base = validateBase(options.apiBase);
    if (value.startsWith('/api/portal/catalog/vehicles/') && !value.includes('..'))
      return base + value;
    if (value.startsWith(base + '/api/portal/catalog/vehicles/') && !value.includes('..'))
      return value;
    return '';
  }
  function vehicle(row) {
    if (!row || typeof row.id !== 'string') throw error('后台车辆数据格式不符合约定。', 'RESPONSE');
    const mileage = row.currentMileageKm ?? row.mileageKm;
    return {
      id: row.id,
      name:
        row.displayName ||
        row.customerModelDisplayName ||
        row.modelDisplayName ||
        [row.brand, row.series, row.model].filter(Boolean).join(' ') ||
        '车型待确认',
      brand: row.brand || '其他品牌',
      city: row.city || '城市待确认',
      registrationText: row.registrationDate
        ? date(row.registrationDate) + ' 上牌'
        : '上牌时间待确认',
      mileageText: Number.isFinite(mileage)
        ? `${mileage.toLocaleString('en-US')} km`
        : '里程待确认',
      rangeText: Number.isFinite(row.estimatedRangeKm)
        ? `参考续航 ${row.estimatedRangeKm} km`
        : '续航待披露',
      bodyType: row.model || '具体配置见车辆资料',
      available: row.available === true,
      statusText: row.statusLabel || (row.available === true ? '可申请' : '暂不可申请'),
      imageUrl: media(row.coverImageUrl) || '/assets/car-placeholder.png',
      minFeeAmount: Number.isSafeInteger(row.monthlyFeeFromAmount)
        ? row.monthlyFeeFromAmount
        : null,
      minFeeText: money(row.monthlyFeeFromAmount),
      tagline: row.subtitle || row.conditionSummary || '详情以客户可见资料和最终方案为准。',
    };
  }
  function plan(row) {
    if (!row || typeof row.planId !== 'string')
      throw error('后台套餐数据格式不符合约定。', 'RESPONSE');
    return {
      id: row.planId,
      title: row.planName || row.planNo || '预设订阅套餐',
      termMonths: row.subscriptionPeriodMonths ?? null,
      monthlyFeeAmount: Number.isSafeInteger(row.monthlyFeeAmount) ? row.monthlyFeeAmount : null,
      monthlyFeeText: money(row.monthlyFeeAmount),
      mileageText: row.mileageDescription || '里程条件待确认',
      energyText: row.energyDescription || '能源条件待确认',
      benefits: row.benefitDescription ? [row.benefitDescription] : [],
      depositText: row.depositDescription || '审核后确认',
      notes:
        [row.monthlyFeeDescription, row.displayRemark, row.packageSummary]
          .filter((item) => typeof item === 'string')
          .join('；') || '预估月费，最终金额以审核后的方案及合同为准。',
      available: row.canSubmit === true,
    };
  }
  async function getVehicles(filters = {}) {
    const rows = await get('/vehicles');
    if (!Array.isArray(rows)) throw error('后台目录应返回车辆数组。', 'RESPONSE');
    const all = rows.map(vehicle);
    const query = String(filters.query || '')
      .trim()
      .toLowerCase();
    return {
      items: all.filter(
        (item) =>
          (!filters.brand || filters.brand === '全部' || item.brand === filters.brand) &&
          (!query || `${item.name} ${item.brand} ${item.city}`.toLowerCase().includes(query)),
      ),
      brands: [...new Set(all.map((item) => item.brand))],
    };
  }
  async function getVehicle(id) {
    if (typeof id !== 'string' || !id) throw error('缺少车辆标识，请从列表进入。', 'VALIDATION');
    const row = await get(`/vehicles/${encodeURIComponent(id)}`);
    const mapped = vehicle(row);
    const rows = Array.isArray(row.subscriptionPlans)
      ? row.subscriptionPlans
      : await get(`/vehicles/${encodeURIComponent(id)}/subscription-plans`);
    if (!Array.isArray(rows)) throw error('后台套餐数据格式不符合约定。', 'RESPONSE');
    const report = {
      summary: row.conditionSummary || '车况资料待披露',
      items: [],
      images: [],
      notice: '未披露信息不表示无事故、无损伤或电池健康；以客户可见报告为准。',
    };
    if (row.conditionDisplayMode === 'SOURCE_DOCUMENT') {
      report.summary = '原始车况与配置资料';
      report.images = Object.values(row.sourceDocuments || {})
        .filter(Boolean)
        .map((doc) => media(doc.previewUrl))
        .filter(Boolean);
      report.items = [{ label: '资料类型', value: '原始图片资料' }];
    } else if (row.conditionDisplayMode === 'STRUCTURED_REPORT') {
      // 仅有明确结构化报告时请求此接口；404 不能被伪造为无事故。
      try {
        const detail = await get(`/vehicles/${encodeURIComponent(id)}/condition-report`);
        report.summary = detail.customerSummary || detail.summary || report.summary;
        report.items = [
          { label: '检测日期', value: date(detail.inspectionDate) },
          { label: '总体等级', value: detail.overallGrade || '待披露' },
          ...(Array.isArray(detail.items) ? detail.items : []).map((item) => ({
            label: item.title || item.partName || '检查项',
            value: item.description || item.result || '待披露',
          })),
        ];
      } catch (failure) {
        if (failure.code !== 'HTTP_404') throw failure;
        report.notice = '结构化报告暂不可访问；不能据此判断车况正常，请等待资料更新。';
      }
    }
    return { vehicle: mapped, plans: rows.map(plan), report };
  }
  return {
    getVehicles,
    getVehicle,
    getModelDefinitions: async () => {
      const rows = await get('/model-definitions');
      if (!Array.isArray(rows)) throw error('车型标记数据格式不符合约定。', 'RESPONSE');
      return rows;
    },
    getHome: async () => ({
      vehicles: (await getVehicles({})).items.slice(0, 2),
      context: { mode: 'api', scenario: 'new', fault: 'none', profile: null },
      nextAction: null,
    }),
  };
}
module.exports = { createApi, validateBase };
