/* 离线回归：Stack Overflow 式标签管理（词库 / 自动补全 / 改名合并删除 / 批量添加 / 首页偏好） */
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
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); };

const storage = {};
let page = null;
const toasts = [];
global.wx = {
    getStorageSync: function (k) { return storage[k]; },
    setStorageSync: function (k, v) { storage[k] = v; },
    removeStorageSync: function (k) { delete storage[k]; },
    showToast: function (o) { toasts.push(o); },
    navigateTo: function () {}, navigateBack: function () {},
    getSystemInfoSync: function () { return { SDKVersion: '3.5.0' }; },
};
global.getApp = function () { return {}; };
global.Page = function (o) { page = o; };

const tagStore = require(path.join(ROOT, 'utils', 'tag-store'));
const storeModule = require(path.join(ROOT, 'utils', 'bill-store'));
const billStore = storeModule.billStore;

console.log('\n[1] 标签命名校验');
ok('正常中文标签', tagStore.validateName('体检报告').ok);
eq('去空白', tagStore.validateName('  发票  ').value, '发票');
ok('空标签被拒', !tagStore.validateName('   ').ok);
ok('标点被拒', !tagStore.validateName('体检,报告').ok);
ok('逗号被拒', !tagStore.validateName('体检，报告').ok);
ok('连字符允许（日期标签）', tagStore.validateName('2026-04-28').ok);
ok('重名被拒', !tagStore.validateName('发票', { taken: ['发票'] }).ok);
ok('改名同名被拒', !tagStore.validateName('发票', { original: '发票' }).ok);

console.log('\n[2] 词库统计与排序');
const recs = [
    { id: 'r1', keyword: '体检 发票', visitDate: '2026-04-28', docType: 'report', note: '', images: [], createdAt: 1000 },
    { id: 'r2', keyword: '体检 清单', visitDate: '2026-4-28', docType: 'list', note: '', images: [], createdAt: 2000 },
    { id: 'r3', keyword: '体检', visitDate: '2026-05-03', docType: 'invoice', note: '', images: [], createdAt: 3000 },
    { id: 'r4', keyword: '发票 其他', visitDate: '2025-12-31', docType: 'other', note: '', images: [], createdAt: 4000 },
];
const prefs = { pinned: { '清单': true }, hidden: { '其他': true } };
const lib = tagStore.collect(recs, prefs);
eq('词库标签数', lib.length, 4);
const find = function (name) { return lib.filter(function (i) { return i.tag === name; })[0]; };
eq('体检出现 3 次', find('体检').count, 3);
eq('体检最近时间', find('体检').latest, 3000);
ok('置顶标记', find('清单').pinned === true);
ok('忽略标记', find('其他').hidden === true);
eq('按次数排序第一', tagStore.sortTags(lib, 'popular')[0].tag, '体检');
eq('按次数排序第二', tagStore.sortTags(lib, 'popular')[1].tag, '发票');
eq('按名称排序第一', tagStore.sortTags(lib, 'name')[0].tag, '体检');
eq('按最近排序第一（同时间看次数）', tagStore.sortTags(lib, 'recent')[0].tag, '发票');
eq('搜索过滤', tagStore.filterTags(lib, '发').length, 1);
eq('搜索大小写不敏感', tagStore.filterTags([{ tag: 'CT' }], 'ct').length, 1);

console.log('\n[3] 自动补全（按频次 / 前缀优先 / 排除已有与忽略）');
eq('空输入给最常用标签', tagStore.suggestions(recs, '', 8, { prefs: prefs })[0].tag, '体检');
ok('忽略的标签不进补全', !tagStore.suggestions(recs, '', 8, { prefs: prefs })
    .some(function (i) { return i.tag === '其他'; }));
eq('输入前缀优先', tagStore.suggestions(recs, '发', 8, {})[0].tag, '发票');
ok('exclude 生效', !tagStore.suggestions(recs, '', 8, { exclude: ['体检'] })
    .some(function (i) { return i.tag === '体检'; }));
eq('补全条数上限', tagStore.suggestions(recs, '', 2, {}).length, 2);
eq('合并候选排除自身', tagStore.mergeCandidates(recs, '发票', '', 12)
    .filter(function (i) { return i.tag === '发票'; }).length, 0);
eq('合并候选按频次', tagStore.mergeCandidates(recs, '发票', '', 12)[0].tag, '体检');

console.log('\n[4] 全局操作补丁（改名 / 合并 / 删除 / 批量添加）');
const renamed = tagStore.renamePatches(recs, '清单', '明细');
eq('改名只影响含该标签的记录', renamed.length, 1);
eq('改名结果', renamed[0].keyword, '体检 明细');
const merged = tagStore.mergePatches(recs, '清单', '发票');
eq('合并结果去重', merged[0].keyword, '体检 发票');
const removed = tagStore.removePatches(recs, '体检');
eq('删除影响 3 条', removed.length, 3);
eq('删除后保留其它标签', removed[0].keyword, '发票');
const added = tagStore.addPatches(recs, '新标签', ['r3', 'r4']);
eq('批量添加 2 条', added.length, 2);
ok('已含该标签的记录不重复加', tagStore.addPatches(recs, '体检', ['r1', 'r3']).length === 0);
const spaced = [{ id: 's1', keyword: '甲  乙', images: [] }];
eq('未命中记录不被顺手改空格', tagStore.renamePatches(spaced, '不存在', '新').length, 0);

console.log('\n[5] 偏好读写与迁移');
const p = tagStore.readPrefs();
eq('空偏好', Object.keys(p.pinned).length, 0);
p.pinned['发票'] = true;
tagStore.writePrefs(p);
ok('偏好已落本机', tagStore.readPrefs().pinned['发票'] === true);
tagStore.movePref(p, '发票', '票据');
ok('改名迁移置顶', !p.pinned['发票'] && p.pinned['票据'] === true);
tagStore.dropPref(p, '票据');
ok('删除标签清偏好', !p.pinned['票据']);

console.log('\n[6] 数据层批量写入与关键字上限');
storage['medical-bills.records.v1'] = JSON.parse(JSON.stringify(recs));
(async function () {
    const before = JSON.parse(JSON.stringify(recs));
    const r1 = await billStore.applyKeywordPatches([{ id: 'r1', keyword: '体检 票据' }]);
    eq('批量写入返回 1 条', r1.data.updated, 1);
    const listed = await billStore.list();
    eq('r1 关键字已改', listed.data.filter(function (r) { return r.id === 'r1'; })[0].keyword, '体检 票据');
    eq('r2 未被动到', listed.data.filter(function (r) { return r.id === 'r2'; })[0].keyword, before[1].keyword);
    eq('空补丁不改数据', (await billStore.applyKeywordPatches([])).data.updated, 0);
    const longKeyword = 'a1 b2 c3 d4 e5 f6 g7 h8';
    const created = await billStore.create({ visitDate: '2026-11-06', keyword: longKeyword, images: [{ path: 'x' }] });
    ok('创建不再截断关键字', created.data.keyword === longKeyword, created.data.keyword);
    eq('关键字上限与标签一致', storeModule.KEYWORD_MAX, 80);

    console.log('\n[7] 标签管理页（模拟 wx + Page）');
    storage['medical-bills.records.v1'] = JSON.parse(JSON.stringify(recs));
    delete storage['medical-bills.tagPrefs.v1'];
    const src = fs.readFileSync(path.join(ROOT, 'pages/tags/tags.js'), 'utf8')
        .replace(/require\(['"]\.\.\/\.\.\/utils\//g, "require('" + ROOT_POSIX + "/utils/");
    const tmp = path.join(os.tmpdir(), 'bill-tags-under-test.js');
    fs.writeFileSync(tmp, src, 'utf8');
    delete require.cache[require.resolve(tmp)];
    require(tmp);
    ok('标签页已注册', !!page);
    page.setData = function (o, cb) {
        Object.keys(o).forEach(function (k) {
            if (k.indexOf('[') >= 0) {
                const m = k.match(/^(\w+)\[(\d+)\]\.(\w+)$/);
                if (m && page.data[m[1]][Number(m[2])]) page.data[m[1]][Number(m[2])][m[3]] = o[k];
            } else page.data[k] = o[k];
        });
        if (typeof cb === 'function') cb.call(page);
    };
    page.onLoad();
    page.onShow();
    await sleep(10);
    eq('词库统计标签数', page.data.totalTags, 4);
    eq('记录数', page.data.recordsCount, 4);
    eq('默认按次数首项', page.data.tags[0].tag, '体检');
    eq('首项次数', page.data.tags[0].count, 3);

    page.onQueryInput({ detail: { value: '发' } });
    eq('搜索只剩 1 个', page.data.tags.length, 1);
    page.onClearQuery();
    page.onSortTap({ currentTarget: { dataset: { key: 'name' } } });
    eq('切换按名称排序', page.data.sortMode, 'name');
    page.onSortTap({ currentTarget: { dataset: { key: 'popular' } } });

    page.onActionTap({ currentTarget: { dataset: { tag: '清单', action: 'pin' } } });
    eq('置顶计数', page.data.pinnedCount, 1);
    ok('置顶偏好已保存', tagStore.readPrefs().pinned['清单'] === true);
    page.onActionTap({ currentTarget: { dataset: { tag: '其他', action: 'hide' } } });
    eq('忽略计数', page.data.hiddenCount, 1);
    page.onActionTap({ currentTarget: { dataset: { tag: '其他', action: 'hide' } } });
    eq('取消忽略', page.data.hiddenCount, 0);

    page.onActionTap({ currentTarget: { dataset: { tag: '清单', action: 'rename' } } });
    eq('改名面板展开', page.data.expandedTag, '清单');
    eq('改名预填原标签', page.data.inputText, '清单');
    page.onActionInput({ detail: { value: '明细' } });
    page.confirmAction();
    await sleep(10);
    const afterRename = (await billStore.list()).data;
    ok('改名同步到所有记录', afterRename.every(function (r) { return r.keyword.indexOf('清单') < 0; }));
    ok('新标签已存在', afterRename.some(function (r) { return r.keyword.indexOf('明细') >= 0; }));
    ok('置顶偏好随改名迁移', tagStore.readPrefs().pinned['明细'] === true);

    page.onActionTap({ currentTarget: { dataset: { tag: '明细', action: 'merge' } } });
    ok('合并候选非空', page.data.mergeList.length > 0);
    page.tapMergeTarget({ currentTarget: { dataset: { tag: '发票' } } });
    eq('点候选填入目标', page.data.inputText, '发票');
    page.confirmAction();
    await sleep(10);
    const afterMerge = (await billStore.list()).data;
    ok('合并后旧标签消失', afterMerge.every(function (r) { return r.keyword.indexOf('明细') < 0; }));
    ok('合并后不产生重复词', afterMerge.every(function (r) {
        return r.keyword.split(/\s+/).filter(function (w) { return w === '发票'; }).length <= 1;
    }));

    page.onActionTap({ currentTarget: { dataset: { tag: '其他', action: 'delete' } } });
    page.confirmAction();
    eq('删除需二次确认', page.data.confirmDelete, true);
    page.confirmAction();
    await sleep(10);
    const afterDelete = (await billStore.list()).data;
    ok('删除标签但保留记录', afterDelete.length === 4
        && afterDelete.every(function (r) { return r.keyword.indexOf('其他') < 0; }));

    page.openNewTag();
    ok('新建区有按频次的热门候选', page.data.newSuggestions.length > 0);
    ok('热门候选是高频标签（体检或发票）',
        ['体检', '发票'].indexOf(page.data.newSuggestions[0].tag) >= 0,
        page.data.newSuggestions[0].tag);
    page.onNewTagInput({ detail: { value: '发' } });
    eq('输入后补全收敛', page.data.newSuggestions[0].tag, '发票');
    page.tapSuggestion({ currentTarget: { dataset: { tag: '发票' } } });
    eq('点补全填入输入框', page.data.newTagText, '发票');
    page.onNewTagInput({ detail: { value: '新词' } });
    page.submitNewTag();
    eq('批量添加面板打开', page.data.pickOpen, true);
    eq('待选记录数', page.data.pickItems.length, 4);
    page.togglePick({ currentTarget: { dataset: { id: 'r3' } } });
    eq('勾选计数', page.data.pickedCount, 1);
    page.confirmPick();
    await sleep(10);
    const afterAdd = (await billStore.list()).data;
    ok('新标签已加到勾选记录', afterAdd.filter(function (r) { return r.id === 'r3'; })[0].keyword.indexOf('新词') >= 0);
    ok('未勾选记录不加', afterAdd.filter(function (r) { return r.id === 'r4'; })[0].keyword.indexOf('新词') < 0);

    console.log('\n[8] 静态接线检查');
    const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
    ok('app.json 已注册标签页', appJson.pages.indexOf('pages/tags/tags') >= 0);
    ok('我的页有入口', /goTags/.test(fs.readFileSync(path.join(ROOT, 'pages/mine/mine.wxml'), 'utf8')));
    const indexWxml = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8');
    ok('首页有管理入口', /goTags/.test(indexWxml));
    ok('首页有全部/任一匹配切换', /onTagModeTap/.test(indexWxml));
    ['pages/upload/upload.wxml', 'pages/detail/detail.wxml'].forEach(function (f) {
        ok('自动补全 UI ' + f, /tag-suggest-chip/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    });
    ['pages/upload/upload.js', 'pages/detail/detail.js'].forEach(function (f) {
        const js = fs.readFileSync(path.join(ROOT, f), 'utf8');
        ok('补全逻辑 ' + f, /tapTagSuggestion/.test(js) && /buildTagSuggestions/.test(js));
    });
    ok('共享样式已加入 app.wxss', /\.tag-suggest-chip/.test(fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')));
    const uploadJs = fs.readFileSync(path.join(ROOT, 'pages/upload/upload.js'), 'utf8');
    ok('保存流程未被改动（吸底保存仍在）', /save-dock|① 已收到点击/.test(uploadJs));

    console.log('\n结果：' + pass + ' 项通过 / ' + fail + ' 项失败');
    process.exitCode = fail ? 1 : 0;
})();
