function money(cents) {
  if (!Number.isSafeInteger(cents)) return '待确认';
  const absolute = Math.abs(cents);
  const whole = String(Math.floor(absolute / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}¥${whole}.${String(absolute % 100).padStart(2, '0')}`;
}
function date(value) {
  if (!value) return '待确认';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '待确认';
}
module.exports = { money, date };
