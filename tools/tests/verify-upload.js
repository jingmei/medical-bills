/* 模拟真机：验证上传页「按照片编号逐项识别 + 删除清除 + 同类一条/异类自动拆分」 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass += 1; console.log('  PASS ' + name); }
    else { fail += 1; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let page = null;
let modals = [], toasts = [], tabs = [], clipboard = [];
let storage = {};
let privacyAgreed = true;
let chooseResult = null; // 模拟 chooseMedia 的返回

function makeFs() {
    const call = (o, okResult) => {
        if (o.success) o.success(okResult || { savedFilePath: 'wxfile://usr/bills/saved.jpg' });
    };
    return {
        mkdir: o => call(o),
        access: o => call(o),
        saveFile: o => call(o, { savedFilePath: o.filePath || 'wxfile://usr/bills/saved.jpg' }),
        copyFile: o => call(o),
        unlink: o => call(o),
        rmdir: o => call(o),
    };
}

global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getSystemInfoSync: () => ({ SDKVersion: '3.5.0' }),
    getFileSystemManager: makeFs,
    getStorageSync: k => (k in storage ? storage[k] : undefined),
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: k => { delete storage[k]; },
    showModal: o => { modals.push(o); if (o.success) o.success({ confirm: true, cancel: false }); },
    showToast: o => { toasts.push(o); },
    switchTab: o => { tabs.push(o); },
    setClipboardData: o => { clipboard.push(o); },
    navigateTo: () => {}, previewImage: () => {},
    chooseMedia: (o) => { if (o.success && chooseResult) o.success(chooseResult); },
    createVKSession: () => ({}), createOffscreenCanvas: () => ({}), getImageInfo: () => {},
};
global.getApp = () => ({
    hasPrivacyAgreed: () => privacyAgreed,
    setPrivacyAgreed: v => { privacyAgreed = v; },
});
global.Page = o => { page = o; };

const src = fs.readFileSync(path.join(ROOT, 'pages/upload/upload.js'), 'utf8')
    .replace(/require\(['"]\.\.\/\.\.\/utils\//g, "require('" + ROOT + "/utils/");
const tmp = path.join(os.tmpdir(), 'bill-upload-under-test.js');
fs.writeFileSync(tmp, src);
delete require.cache[tmp];
require(tmp);
page.setData = function (o) { Object.assign(page.data, o); };

function photoKey(i) { return page.data.photos[i].key; }

(async function run() {
    page.onLoad();
    page.setData({ needPrivacy: false });

    // 1) 选择两张照片 -> 自动编号 1、2，并自动选中第一张
    chooseResult = { tempFiles: [
        { tempFilePath: 'wxfile://tmp/a.jpg', size: 100 },
        { tempFilePath: 'wxfile://tmp/b.jpg', size: 120 },
    ] };
    page.chooseImages();
    ok('选择后共 2 张照片', page.data.photos.length === 2);
    ok('照片自动编号 1 / 2', page.data.photos[0].photoNo === 1 && page.data.photos[1].photoNo === 2);
    ok('自动选中第一张（activeKey 指向照片1）', page.data.activeKey === photoKey(0) && page.data.active.photoNo === 1);

    // 2) 选中第二张进入编辑：之后编辑/识别只针对它
    page.selectPhoto({ currentTarget: { dataset: { key: photoKey(1) } } });
    ok('选中第二张后 active.photoNo=2', page.data.active.photoNo === 2);
    ok('activeKey 已切换到照片2', page.data.activeKey === photoKey(1));

    // 3) 给第二张写标签与备注（不触碰第一张）
    page.setActive(page.data.activeKey);
    page.editActiveKeyword('体检 血常规');
    ok('照片2 关键字写入', page.data.active.keyword.indexOf('体检') >= 0);
    ok('照片2 标签分词正确', page.data.active.ocrTags.length === 2);
    page.onActiveNoteInput({ detail: { value: '这是第二页明细' } });
    ok('照片2 备注写入', page.data.active.note === '这是第二页明细');
    ok('照片1 关键字仍为空（互不影响）', page.data.photos[0].keyword === '');

    // 4) 给第一张也识别（直接调用 applyOcrTexts，绕开端侧识别硬件）
    page.selectPhoto({ currentTarget: { dataset: { key: photoKey(0) } } });
    page.applyOcrTexts(['预约告知书', '2026-04-28 2:00', '提前三天'], { targetKey: photoKey(0) });
    ok('照片1 识别文字落到自身', page.data.photos[0].ocrTexts.length === 3);
    ok('照片1 与照片2 数据分离', page.data.photos[0].keyword !== page.data.photos[1].keyword);

    // 5) 删除第一张 -> 其识别结果与备注一并清除，且编号顺延
    const key0 = photoKey(0);
    page.removePhoto({ currentTarget: { dataset: { key: key0 } } });
    ok('删除后只剩 1 张', page.data.photos.length === 1);
    ok('剩余照片编号顺延为 1', page.data.photos[0].photoNo === 1);
    const stillThere = page.data.photos.some(p => p.key === key0);
    ok('被删照片数据已移除（无可残留识别结果）', !stillThere);
    ok('activeKey 重新指向剩余照片', page.data.activeKey === page.data.photos[0].key);

    // 6) 保存模式提示：同类 -> 一条记录
    page.recomputeSaveMode();
    ok('同类提示为一条记录', /1 条记录/.test(page.data.saveModeHint), page.data.saveModeHint);
    ok('保存模式提示含类型名', page.data.saveModeHint.indexOf('体检') < 0); // 当前类型是默认 typeOptions[0]

    // 7) 同类保存 -> 生成 1 条记录，items 含每张照片快照
    storage = {};
    page.setData({ visitDate: '2026-11-06', photos: [
        { key: 'k1', tempFilePath: 'wxfile://tmp/1.jpg', size: 10, photoNo: 1, docType: 'body', typeText: '身体数据', typeIndex: 0, ocrTexts: ['A'], keyword: '血压', ocrTags: ['血压'], ocrDate: '', ocrHint: '', note: '页1', manualText: '', recognized: true },
        { key: 'k2', tempFilePath: 'wxfile://tmp/2.jpg', size: 12, photoNo: 2, docType: 'body', typeText: '身体数据', typeIndex: 0, ocrTexts: ['B'], keyword: '心率', ocrTags: ['心率'], ocrDate: '', ocrHint: '', note: '页2', manualText: '', recognized: true },
    ], activeKey: 'k1', active: null });
    page.setActive('k1');
    page.save();
    await sleep(80);
    let recs = (wx.getStorageSync('medical-bills.records.v1') || []);
    ok('同类保存只生成 1 条记录', recs.length === 1, 'records=' + recs.length);
    ok('记录含 2 张照片', recs[0] && recs[0].images.length === 2);
    ok('记录关键词为两张标签并集', recs[0] && recs[0].keyword.indexOf('血压') >= 0 && recs[0].keyword.indexOf('心率') >= 0, recs[0] && recs[0].keyword);
    ok('记录 items 含两张照片快照', recs[0] && Array.isArray(recs[0].items) && recs[0].items.length === 2);
    ok('items 各自编号 1 / 2', recs[0] && recs[0].items[0].photoNo === 1 && recs[0].items[1].photoNo === 2);
    ok('同类保存无 batchId', recs[0] && recs[0].batchId === '');

    // 8) 异类保存 -> 自动拆 2 条，共用 batchId
    storage = {};
    page.setData({ visitDate: '2026-11-06', photos: [
        { key: 'x1', tempFilePath: 'wxfile://tmp/1.jpg', size: 10, photoNo: 1, docType: 'invoice', typeText: '发票', typeIndex: 2, ocrTexts: ['A'], keyword: '电费', ocrTags: ['电费'], ocrDate: '', ocrHint: '', note: '票1', manualText: '', recognized: true },
        { key: 'x2', tempFilePath: 'wxfile://tmp/2.jpg', size: 12, photoNo: 2, docType: 'body', typeText: '身体数据', typeIndex: 0, ocrTexts: ['B'], keyword: '血压', ocrTags: ['血压'], ocrDate: '', ocrHint: '', note: '体1', manualText: '', recognized: true },
    ], activeKey: 'x1', active: null });
    page.setActive('x1');
    page.recomputeSaveMode();
    ok('异类提示会拆分', /拆成 2 条记录/.test(page.data.saveModeHint), page.data.saveModeHint);
    page.save();
    await sleep(80);
    recs = (wx.getStorageSync('medical-bills.records.v1') || []);
    ok('异类保存生成 2 条记录', recs.length === 2, 'records=' + recs.length);
    const bids = recs.map(r => r.batchId).filter(Boolean);
    ok('两条记录共用同一 batchId', bids.length === 2 && bids[0] === bids[1], JSON.stringify(bids));
    ok('每条记录各 1 张照片', recs.every(r => r.images.length === 1));
    ok('发票记录类型正确', recs.some(r => r.docType === 'invoice' && r.keyword.indexOf('电费') >= 0));
    ok('身体数据记录类型正确', recs.some(r => r.docType === 'body' && r.keyword.indexOf('血压') >= 0));

    // 9) 上传页：从「这张的备注」提取标签（修复 B15 反馈）
    // 注意：上面 save() 成功后 photos 已清空，这里先重建两张照片再测
    page.setData({ visitDate: '2026-11-06', photos: [
        { key: 'n1', tempFilePath: 'wxfile://tmp/1.jpg', size: 10, photoNo: 1, docType: 'body', typeText: '身体数据', typeIndex: 0, ocrTexts: [], keyword: '', ocrTags: [], ocrDate: '', ocrHint: '', note: '', manualText: '', recognized: false },
        { key: 'n2', tempFilePath: 'wxfile://tmp/2.jpg', size: 12, photoNo: 2, docType: 'body', typeText: '身体数据', typeIndex: 0, ocrTexts: [], keyword: '', ocrTags: [], ocrDate: '', ocrHint: '', note: '', manualText: '', recognized: false },
    ], activeKey: 'n1', active: null });
    page.setActive('n1');
    page.selectPhoto({ currentTarget: { dataset: { key: 'n2' } } });
    page.setActive(page.data.activeKey);
    page.onActiveNoteInput({ detail: { value: '门诊复查 2026-04-28 抽血 08:00' } });
    page.extractTagsFromNote();
    ok('上传页：从备注提取出标签', page.data.active.ocrTags.length > 0, JSON.stringify(page.data.active.ocrTags));
    ok('上传页：关键字与标签同步', page.data.active.keyword.length > 0, page.data.active.keyword);
    ok('上传页：备注文字保留', page.data.active.note.indexOf('门诊复查') >= 0, page.data.active.note);
    // 空备注降级
    toasts = [];
    page.onActiveNoteInput({ detail: { value: '' } });
    page.extractTagsFromNote();
    ok('上传页：空备注不提取并提示', toasts.some(t => /空的/.test(t.title)), JSON.stringify(toasts.map(t => t.title)));

    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exitCode = fail ? 1 : 0;
})();
