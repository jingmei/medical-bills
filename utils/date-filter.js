// 拍照日期筛选：按年 / 按年月 / 按某天三种粒度。
//
// 组件用的是微信原生 picker（mode="date" + fields="year|month|day"），
// 这是小程序内置表单组件，不需要 npm、第三方组件库、服务器域名或网络请求，
// 因此「所有数据仅保存在本机，不上传」的隐私口径不变。
// 本文件全部是纯函数，方便在 Node 里离线回归。

var GRANULARITIES = [
    { key: 'year', label: '按年', fields: 'year' },
    { key: 'month', label: '按月', fields: 'month' },
    { key: 'day', label: '按天', fields: 'day' },
];

var START_DATE = '2000-01-01';

function pad2(n) {
    var v = Number(n);
    return v < 10 ? '0' + v : String(v);
}

function granularityOf(key) {
    for (var i = 0; i < GRANULARITIES.length; i += 1) {
        if (GRANULARITIES[i].key === key) return GRANULARITIES[i];
    }
    return GRANULARITIES[2];
}

// 把各种手写日期统一成 YYYY / YYYY-MM / YYYY-MM-DD。
// 兼容：2026-4-28、2026/4/28、2026.4.28、2026年4月28日、2026-04、2026 年。
// 不合法（月份 > 12、日 > 31）返回空串，绝不猜测。
function normalizeDate(text) {
    var s = String(text === null || text === undefined ? '' : text).trim();
    if (!s) return '';
    var onlyYear = s.match(/^(\d{4})\s*(?:年)?\s*$/);
    if (onlyYear) return onlyYear[1];
    var m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2}))?/);
    if (!m) return '';
    var month = Number(m[2]);
    if (month < 1 || month > 12) return '';
    var year = m[1] + '-' + pad2(month);
    if (!m[3]) return year;
    var day = Number(m[3]);
    if (day < 1 || day > 31) return year;
    return year + '-' + pad2(day);
}

// 一条记录的拍照日期落在哪个「段」里；粒度不匹配的（如只有年、却按天筛）返回 ''。
function bucketOf(dateText, granularity) {
    var d = normalizeDate(dateText);
    if (!d) return '';
    if (granularity === 'year') return d.slice(0, 4);
    if (granularity === 'month') return d.length >= 7 ? d.slice(0, 7) : '';
    return d.length >= 10 ? d.slice(0, 10) : '';
}

// picker 的 value 必须是 YYYY-MM-DD；段值可能只有年或年月，这里补齐。
function pickerValue(granularity, bucket, today) {
    var base = bucket || today || '';
    var m = String(base).match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
    if (!m) return START_DATE;
    var y = m[1];
    var mo = Number(m[2] || 1);
    var d = Number(m[3] || 1);
    if (mo < 1 || mo > 12) mo = 1;
    if (d < 1 || d > 31) d = 1;
    return y + '-' + pad2(mo) + '-' + pad2(d);
}

// 不同基础库 / 机型对 fields=year|month 的返回值格式不完全一致（YYYY / YYYY-MM / YYYY-MM-DD 都见过），
// 统一收敛成当前粒度的段值。
function bucketFromPicker(granularity, value) {
    var s = String(value === null || value === undefined ? '' : value).trim();
    var m = s.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
    if (!m) return '';
    var y = m[1];
    var mo = Number(m[2] || 1);
    var d = Number(m[3] || 1);
    if (mo < 1 || mo > 12) mo = 1;
    if (d < 1 || d > 31) d = 1;
    var full = y + '-' + pad2(mo) + '-' + pad2(d);
    if (granularity === 'year') return y;
    if (granularity === 'month') return full.slice(0, 7);
    return full;
}

function describe(granularity, bucket) {
    if (!bucket) return '';
    var m = String(bucket).match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
    if (!m) return String(bucket);
    var text = m[1] + ' 年';
    if (granularity === 'year' || !m[2]) return text;
    text += ' ' + Number(m[2]) + ' 月';
    if (granularity === 'month' || !m[3]) return text;
    return text + ' ' + Number(m[3]) + ' 日';
}

// 精确按段匹配，不做子串匹配，避免「2026-1」误命中「2026-10」。
function matchDate(dateText, granularity, bucket) {
    if (!bucket) return true;
    return bucketOf(dateText, granularity) === bucket;
}

// 有记录的日期段，按记录条数从多到少排；同条数时近的在前。
// 这是「年月日分段」的快捷入口，用户不用非得打开滚轮选择器。
function quickBuckets(records, granularity, limit) {
    var counts = {};
    (records || []).forEach(function (record) {
        var bucket = bucketOf(record && record.visitDate, granularity);
        if (bucket) counts[bucket] = (counts[bucket] || 0) + 1;
    });
    var list = Object.keys(counts).map(function (bucket) {
        return { bucket: bucket, label: describe(granularity, bucket), count: counts[bucket] };
    });
    list.sort(function (a, b) {
        if (b.count !== a.count) return b.count - a.count;
        if (a.bucket !== b.bucket) return a.bucket < b.bucket ? 1 : -1;
        return 0;
    });
    return list.slice(0, limit || 8);
}

function pickerRange(today) {
    var y = Number(String(today || '').slice(0, 4));
    if (!y || y < 2000) y = new Date().getFullYear();
    return { start: START_DATE, end: (y + 1) + '-12-31' };
}

module.exports = {
    GRANULARITIES: GRANULARITIES,
    START_DATE: START_DATE,
    granularityOf: granularityOf,
    normalizeDate: normalizeDate,
    bucketOf: bucketOf,
    pickerValue: pickerValue,
    bucketFromPicker: bucketFromPicker,
    describe: describe,
    matchDate: matchDate,
    quickBuckets: quickBuckets,
    pickerRange: pickerRange,
};
