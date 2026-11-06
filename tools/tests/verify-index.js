/* 离线回归：首页日期分段筛选 + 高频标签排序 + 四条件组合筛选 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ROOT_POSIX = ROOT.replace(/\\/g, '/');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass += 1; console.log('  PASS ' + name); }
    else { fail += 1; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, actual, expected) {
    ok(name, actual === expected, '实际 ' + JSON.stringify(actual) + ' / 期望 ' + JSON.stringify(expected));
}

const dateFilter = require(path.join(ROOT, 'utils', 'date-filter'));
const tagRank = require(path.join(ROOT, 'utils', 'tag-rank'));

console.log('\n[1] 日期归一化与分段');
[
    ['2026-04-28', '2026-04-28'],
    ['2026-4-28', '2026-04-28'],
    ['2026/4/8', '2026-04-08'],
    ['2026.4.28', '2026-04-28'],
    ['2026年4月28日', '2026-04-28'],
    ['2026-04', '2026-04'],
    ['2026 年', '2026'],
    ['2026', '2026'],
    ['2026-13-01', ''],
    ['2026-04-40', '2026-04'],
    ['不是日期', ''],
    ['', ''],
].forEach(function (item) { eq('normalizeDate ' + JSON.stringify(item[0]), dateFilter.normalizeDate(item[0]), item[1]); });

eq('按年段', dateFilter.bucketOf('2026-4-28', 'year'), '2026');
eq('按年月段', dateFilter.bucketOf('2026-4-28', 'month'), '2026-04');
eq('按某天段', dateFilter.bucketOf('2026-4-28', 'day'), '2026-04-28');
eq('只有年不能按天筛', dateFilter.bucketOf('2026', 'day'), '');
eq('只有年可以按年筛', dateFilter.bucketOf('2026', 'year'), '2026');
eq('按年 picker 返回 YYYY', dateFilter.bucketFromPicker('year', '2026'), '2026');
eq('按年 picker 也可能返回完整日期', dateFilter.bucketFromPicker('year', '2026-04-28'), '2026');
eq('按月 picker 返回 YYYY-MM', dateFilter.bucketFromPicker('month', '2026-04'), '2026-04');
eq('按月 picker 返回完整日期也能收敛', dateFilter.bucketFromPicker('month', '2026-04-28'), '2026-04');
eq('按天 picker', dateFilter.bucketFromPicker('day', '2026-04-28'), '2026-04-28');
eq('picker value 补齐为完整日期', dateFilter.pickerValue('year', '2026', '2026-11-06'), '2026-01-01');
eq('picker value 无段值用今天', dateFilter.pickerValue('day', '', '2026-11-06'), '2026-11-06');
eq('中文描述 年', dateFilter.describe('year', '2026'), '2026 年');
eq('中文描述 年月', dateFilter.describe('month', '2026-04'), '2026 年 4 月');
eq('中文描述 某天', dateFilter.describe('day', '2026-04-28'), '2026 年 4 月 28 日');
ok('2026-01 不误命中 2026-10', dateFilter.matchDate('2026-10-02', 'month', '2026-01') === false);
ok('手写日期也能被标准段命中', dateFilter.matchDate('2026-4-28', 'day', '2026-04-28') === true);
ok('空段不筛选', dateFilter.matchDate('乱写', 'day', '') === true);
ok('无效日期不会误命中', dateFilter.matchDate('不是日期', 'year', '2026') === false);
const range = dateFilter.pickerRange('2026-11-06');
eq('picker start', range.start, '2000-01-01');
eq('picker end', range.end, '2027-12-31');

console.log('\n[2] 标签频次统计');
const recs = [
    { id: 'r1', visitDate: '2026-04-28', keyword: '体检 发票', docType: 'report', note: '年度', images: [], createdAt: 1000 },
    { id: 'r2', visitDate: '2026-4-28', keyword: '体检 清单', docType: 'list', note: '', images: [], createdAt: 2000 },
    { id: 'r3', visitDate: '2026-05-03', keyword: '体检', docType: 'invoice', note: '报销', images: [], createdAt: 3000 },
    { id: 'r4', visitDate: '2025-12-31', keyword: '发票 其他', docType: 'other', note: '', images: [], createdAt: 4000 },
    { id: 'r5', visitDate: '2026-10-02', keyword: '', docType: 'body', note: '无关键字', images: [], createdAt: 5000 },
];
const ranked = tagRank.rank(recs, 12);
eq('标签数量', ranked.length, 4);
eq('最高频标签', ranked[0].tag, '体检');
eq('最高频次数', ranked[0].count, 3);
eq('次高频标签', ranked[1].tag, '发票');
eq('次高频次数', ranked[1].count, 2);
eq('同频按最近使用排', ranked[2].tag, '其他');
eq('同频末位', ranked[3].tag, '清单');
eq('限制条数生效', tagRank.rank(recs, 2).length, 2);
eq('同一记录内重复词只算一次', tagRank.rank([{ keyword: '体检 体检', createdAt: 1 }], 12)[0].count, 1);
eq('超长词不进标签栏', tagRank.rank([{ keyword: '一二三四五六七八九十一二三四五六七', createdAt: 1 }], 12).length, 0);
ok('完整词匹配', tagRank.matches({ keyword: '体检 发票' }, '体检'));
ok('不做子串匹配', tagRank.matches({ keyword: 'CT室' }, 'CT') === false);
ok('空标签不筛选', tagRank.matches({ keyword: '' }, ''));

console.log('\n[3] 快捷日期段按条数排序');
const days = dateFilter.quickBuckets(recs, 'day', 8);
eq('按天段数', days.length, 4);
eq('按天最高频段', days[0].bucket, '2026-04-28');
eq('按天最高频条数（含手写日期）', days[0].count, 2);
const months = dateFilter.quickBuckets(recs, 'month', 8);
eq('按月最高频段', months[0].bucket, '2026-04');
eq('按月最高频条数', months[0].count, 2);
const years = dateFilter.quickBuckets(recs, 'year', 8);
eq('按年段数', years.length, 2);
eq('按年最高频段', years[0].bucket, '2026');
eq('按年最高频条数', years[0].count, 4);
eq('快捷项中文标签', days[0].label, '2026 年 4 月 28 日');

console.log('\n[4] 首页页面逻辑（模拟 wx + Page）');
let page = null;
const storage = { 'medical-bills.records.v1': recs };
global.wx = {
    getStorageSync: function (k) { return storage[k]; },
    setStorageSync: function (k, v) { storage[k] = v; },
    removeStorageSync: function (k) { delete storage[k]; },
    navigateTo: function () {}, switchTab: function () {},
    getSystemInfoSync: function () { return { SDKVersion: '3.5.0' }; },
};
global.getApp = function () { return {}; };
global.Page = function (o) { page = o; };

const src = fs.readFileSync(path.join(ROOT, 'pages/index/index.js'), 'utf8')
    .replace(/require\(['"]\.\.\/\.\.\/(utils|config)\//g, "require('" + ROOT_POSIX + "/$1/");
const tmp = path.join(os.tmpdir(), 'bill-index-under-test.js');
fs.writeFileSync(tmp, src, 'utf8');
delete require.cache[require.resolve(tmp)];
require(tmp);
ok('Page 已注册', !!page);
page.setData = function (o, cb) {
    Object.keys(o).forEach(function (k) {
        if (k.indexOf('.') >= 0) {
            const parts = k.split('.');
            page.data[parts[0]][parts[1]] = o[k];
        } else page.data[k] = o[k];
    });
    if (typeof cb === 'function') cb.call(page);
};
page.allRecords = [];
page.onLoad();
page.onShow();

(async function () {
    await new Promise(function (r) { setTimeout(r, 10); });
    eq('初始记录数', page.data.totalCount, 5);
    eq('初始标签条数（全部按钮单独渲染）', page.data.tagChips.length, 4);
    eq('标签栏第一项', page.data.tagChips[0].tag, '体检');
    eq('标签栏第一项次数', page.data.tagChips[0].count, 3);
    eq('默认全部匹配', page.data.tagMatchMode, 'all');
    eq('初始按天快捷项', page.data.quickDates[0].bucket, '2026-04-28');
    eq('初始按天快捷项条数', page.data.quickDates[0].count, 2);
    eq('搜索框占位不再写日期', fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8').indexOf('搜索关键字 / 类型 / 备注 / 日期') < 0, true);

    page.onKeywordInput({ detail: { value: '报销' } });
    eq('文字搜备注', page.data.totalCount, 1);
    page.onKeywordInput({ detail: { value: '2026-04-28' } });
    eq('文字搜索不再命中日期', page.data.totalCount, 0);
    page.onClearKeyword();

    page.onDateChange({ detail: { value: '2026-04-28' } });
    eq('按某天筛选', page.data.totalCount, 2);
    eq('日期段值规范化', page.data.dateBucket, '2026-04-28');
    eq('日期中文提示', page.data.dateText, '2026 年 4 月 28 日');
    ok('筛选摘要含日期', page.data.filterSummary.indexOf('日期') >= 0);
    ok('hasFilters 为真', page.data.hasFilters);
    page.onClearDate();
    eq('清除日期', page.data.totalCount, 5);

    page.onDateGranularityTap({ currentTarget: { dataset: { key: 'month' } } });
    eq('切粒度清空段值', page.data.dateBucket, '');
    eq('切粒度同步 fields', page.data.dateFields, 'month');
    eq('按月快捷项', page.data.quickDates[0].bucket, '2026-04');
    page.onQuickDateTap({ currentTarget: { dataset: { bucket: '2026-04' } } });
    eq('按月快捷筛选', page.data.totalCount, 2);
    page.onDateGranularityTap({ currentTarget: { dataset: { key: 'year' } } });
    page.onQuickDateTap({ currentTarget: { dataset: { bucket: '2026' } } });
    eq('按年快捷筛选', page.data.totalCount, 4);
    page.onDateGranularityTap({ currentTarget: { dataset: { key: 'day' } } });
    page.onDateChange({ detail: { value: '2026-4-28' } });
    eq('picker 返回非标准日期也能收敛', page.data.dateBucket, '2026-04-28');

    page.onClearAll();
    page.onTagTap({ currentTarget: { dataset: { tag: '体检' } } });
    eq('单标签筛选', page.data.totalCount, 3);
    ok('筛选摘要含标签', page.data.filterSummary.indexOf('标签 体检') >= 0);
    page.onTagTap({ currentTarget: { dataset: { tag: '发票' } } });
    eq('多标签全部匹配（AND）', page.data.totalCount, 1);
    eq('已选中两个标签', page.data.activeTags.length, 2);
    ok('摘要含两个标签', page.data.filterSummary.indexOf('体检 + 发票') >= 0);
    page.onTagModeTap();
    eq('切到任一匹配', page.data.tagMatchMode, 'any');
    eq('多标签任一匹配（OR）', page.data.totalCount, 4);
    page.onTagModeTap();
    eq('切回全部匹配', page.data.totalCount, 1);
    page.onTagTap({ currentTarget: { dataset: { tag: '发票' } } });
    eq('取消其中一个标签', page.data.totalCount, 3);
    page.onClearTags();
    eq('清空标签', page.data.totalCount, 5);

    page.onTypeChange({ detail: { value: '4' } });
    eq('类型 picker 选中 report', page.data.activeType, 'report');
    eq('类型筛选结果', page.data.totalCount, 1);

    page.onClearAll();
    page.onTagTap({ currentTarget: { dataset: { tag: '体检' } } });
    page.onDateGranularityTap({ currentTarget: { dataset: { key: 'month' } } });
    page.onQuickDateTap({ currentTarget: { dataset: { bucket: '2026-04' } } });
    page.onKeywordInput({ detail: { value: '年度' } });
    eq('标签+日期+文字三条件取交集', page.data.totalCount, 1);
    page.onClearAll();
    eq('重置全部筛选', page.data.totalCount, 5);
    eq('重置后 hasFilters 为假', page.data.hasFilters, false);

    page.setData({ activeTags: ['已被删掉的标签'] });
    page.applyFilter();
    eq('失效标签自动取消选中', page.data.activeTags.length, 0);

    storage['medical-bills.tagPrefs.v1'] = { pinned: { '发票': true }, hidden: { '清单': true } };
    page.applyFilter();
    eq('置顶标签排到最前', page.data.tagChips[0].tag, '发票');
    ok('忽略标签不出现在首页', !page.data.tagChips.some(function (c) { return c.tag === '清单'; }));
    delete storage['medical-bills.tagPrefs.v1'];

    eq('列表日期已归一化', page.data.groups[0].items.length >= 1, true);
    const groupDates = page.data.groups.map(function (g) { return g.date; });
    ok('手写日期与标准日期归入同一组', groupDates.indexOf('2026-04-28') >= 0);

    console.log('\n结果：' + pass + ' 项通过 / ' + fail + ' 项失败');
    process.exitCode = fail ? 1 : 0;
})();
