// 日期、时间线分组、体积格式化等纯函数。
// 单据类型的名称由 utils/type-store.js 统一管理（支持用户自定义），本文件不再保存类型常量。

const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) {
    return n < 10 ? '0' + String(n) : String(n);
}

function toDateStr(value) {
    const d = value instanceof Date ? value : new Date(value);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function todayStr() {
    return toDateStr(new Date());
}

// 手动构造日期，避免 iOS 下 new Date('YYYY-MM-DD') 解析不一致
function parseDateStr(text) {
    const parts = String(text || '').split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
}

function dateLabel(text) {
    const d = parseDateStr(text);
    if (!d) return String(text || '');
    return text + ' · ' + WEEK_NAMES[d.getDay()];
}

function formatDateTime(timestamp) {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return '';
    return toDateStr(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function groupByDate(records) {
    const buckets = {};
    const keys = [];
    records.forEach(function (record) {
        const key = record.visitDate || '';
        if (!buckets[key]) {
            buckets[key] = [];
            keys.push(key);
        }
        buckets[key].push(record);
    });
    keys.sort(function (a, b) {
        if (a === b) return 0;
        return a < b ? 1 : -1;
    });
    return keys.map(function (key) {
        return { date: key, label: dateLabel(key), items: buckets[key] };
    });
}

module.exports = {
    toDateStr,
    todayStr,
    dateLabel,
    formatDateTime,
    humanSize,
    groupByDate,
};
