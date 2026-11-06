/* 模拟真机：详情页「单张照片」保存后补识别 / 改标签 / 改备注（修复 B13 反馈） */
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
let toasts = [], modals = [], storage = {};

function makeFs() {
    const call = (o, okResult) => { if (o && o.success) o.success(okResult || {}); };
    return {
        mkdir: call, access: call, saveFile: o => call(o, { savedFilePath: (o && o.filePath) || 'p' }),
        copyFile: call, unlink: call, rmdir: call,
    };
}
global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getSystemInfoSync: () => ({ SDKVersion: '3.17.6' }),
    getFileSystemManager: makeFs,
    getStorageSync: k => storage[k],
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: k => { delete storage[k]; },
    showToast: o => { toasts.push(o); },
    showModal: o => { modals.push(o); if (o && o.success) o.success({ confirm: true, cancel: false }); },
    previewImage: () => {}, navigateBack: () => {}, switchTab: () => {},
};
global.Page = o => { page = o; };

// 用可预测的桩替换端侧 OCR，避免依赖真机相机 / VKSession
const ocrPath = path.join(ROOT, 'utils/ocr.js');
require.cache[ocrPath] = {
    id: ocrPath, filename: ocrPath, loaded: true,
    exports: {
        isSupported: () => true,
        recognize: (src, cb) => Promise.resolve(['抽血 08:00', '2026-04-28 复查', '第 1 页 / 共 2 页']),
        analyze: (texts, opts) => ({
            date: '2026-04-28', title: '', times: ['08:00'],
            tags: ['抽血', '复查'], quality: { garbled: false },
        }),
        cancel() {}, extractDate() {}, extractTimes() {}, extractTags() {},
        assessQuality() {}, versionAtLeast() {}, MAX_TAGS: 8,
    },
};

const src = fs.readFileSync(path.join(ROOT, 'pages/detail/detail.js'), 'utf8')
    .replace(/require\(['"]\.\.\/\.\.\/utils\//g, "require('" + ROOT + "/utils/");
const tmp = path.join(os.tmpdir(), 'bill-detail-item-under-test.js');
fs.writeFileSync(tmp, src);
delete require.cache[tmp];
require(tmp);
page.setData = function (o) { Object.assign(page.data, o); };

const STORE = 'medical-bills.records.v1';

function seed() {
    storage = {};
    toasts = []; modals = [];
    storage[STORE] = [{
        id: 'r-2',
        visitDate: '2026-11-06',
        keyword: '激光治疗室预约告知书 预约告知书',
        docType: 'report',
        note: '',
        images: [
            { path: 'wxfile://usr/bills/bill-a.jpg', size: 133000, addedAt: 1 },
            { path: 'wxfile://usr/bills/bill-b.jpg', size: 98000, addedAt: 2 },
        ],
        items: [
            { photoNo: 1, tags: ['激光治疗室', '预约告知书'], note: '第 1 页' },
            { photoNo: 2, tags: [], note: '' }, // 第二张当时没识别
        ],
        createdAt: 1793916100435,
        updatedAt: 1793916100435,
    }];
    page.data.loading = true;
    page.data.notFound = false;
    page.data.editing = false;
    page.data.itemEditOpen = false;
    page.onLoad({ id: 'r-2' });
}

async function main() {
    console.log('\n[详情页按张展示]');
    await seed();
    await sleep(30);
    ok('读取成功且有 items', page.data.hasItems === true && page.data.itemsView.length === 2);
    ok('照片 1 有标签、照片 2 无标签', page.data.itemsView[0].hasTags === true && page.data.itemsView[1].hasTags === false);
    ok('本机路径已记录（供重新识别）', Array.isArray(page._imagePaths) && page._imagePaths.length === 2);

    console.log('\n[单张编辑：给没识别的第二张补标签]');
    page.editItem({ currentTarget: { dataset: { idx: '1' } } });
    ok('打开第二张编辑器', page.data.itemEditOpen === true && page.data.itemEditIndex === 1);
    ok('编辑器带入为空标签', page.data.itemEditKeyword === '' && page.data.itemEditTags.length === 0);
    page.onItemKeywordInput({ detail: { value: '复查 抽血 08:00' } });
    ok('输入即拆成标签', page.data.itemEditTags.length === 3, JSON.stringify(page.data.itemEditTags));
    page.onItemNoteInput({ detail: { value: '第二张：门诊复查单' } });
    ok('备注输入生效', page.data.itemEditNote === '第二张：门诊复查单');
    page.saveItemEdit();
    await sleep(80);
    const rec = (storage[STORE] || [])[0] || {};
    ok('第二张标签已写回 items', rec.items[1].tags.indexOf('复查') >= 0 && rec.items[1].tags.indexOf('抽血') >= 0, JSON.stringify(rec.items[1].tags));
    ok('照片编号未被打乱', rec.items[0].photoNo === 1 && rec.items[1].photoNo === 2);
    ok('整条关键字按并集刷新', /激光治疗室/.test(rec.keyword) && /复查/.test(rec.keyword), rec.keyword);
    ok('整条备注按拼接刷新', /门诊复查单/.test(rec.note), rec.note);
    ok('保存后退出单张编辑态', page.data.itemEditOpen === false);
    ok('保存成功 toast', toasts.some(t => /这张已保存/.test(t.title)), JSON.stringify(toasts.map(t => t.title)));

    console.log('\n[单张重新识别：对第二张跑端侧 OCR]');
    await seed();
    await sleep(30);
    page.editItem({ currentTarget: { dataset: { idx: '1' } } });
    page.reOcrItem({ currentTarget: { dataset: { idx: '1' } } });
    await sleep(80);
    ok('识别后标签被合并进第二张', page.data.itemEditTags.indexOf('抽血') >= 0 && page.data.itemEditTags.indexOf('复查') >= 0, JSON.stringify(page.data.itemEditTags));
    ok('识别结果有提示', /识别完成|已识别/.test(page.data.itemOcrHint) || page.data.itemEditHint.indexOf('保存这张') >= 0, page.data.itemOcrHint + '|' + page.data.itemEditHint);
    page.saveItemEdit();
    await sleep(80);
    const rec2 = (storage[STORE] || [])[0] || {};
    ok('重新识别的标签已持久化', rec2.items[1].tags.indexOf('抽血') >= 0, JSON.stringify(rec2.items[1].tags));
    ok('第一张原有标签不受影响', rec2.items[0].tags.indexOf('激光治疗室') >= 0, JSON.stringify(rec2.items[0].tags));

    console.log('\n[从备注文字提取标签（修复 B15 反馈）]');
    await seed();
    await sleep(30);
    page.editItem({ currentTarget: { dataset: { idx: '1' } } });
    page.onItemNoteInput({ detail: { value: '门诊复查 2026-04-28 抽血 08:00' } });
    page.extractTagsFromNote();
    ok('从备注提取出标签', page.data.itemEditTags.indexOf('抽血') >= 0 && page.data.itemEditTags.indexOf('复查') >= 0, JSON.stringify(page.data.itemEditTags));
    ok('提取后提示点保存', /保存这张/.test(page.data.itemEditHint), page.data.itemEditHint);
    ok('备注文字本身保留', page.data.itemEditNote.indexOf('门诊复查') >= 0);
    page.saveItemEdit();
    await sleep(80);
    const rec3 = (storage[STORE] || [])[0] || {};
    ok('提取的标签已持久化', rec3.items[1].tags.indexOf('抽血') >= 0 && rec3.items[1].tags.indexOf('复查') >= 0, JSON.stringify(rec3.items[1].tags));
    ok('第一张标签不受影响', rec3.items[0].tags.indexOf('激光治疗室') >= 0, JSON.stringify(rec3.items[0].tags));

    // 追加模式：已有标签应保留，新标签也加进
    await seed();
    await sleep(30);
    page.editItem({ currentTarget: { dataset: { idx: '1' } } });
    page.onItemKeywordInput({ detail: { value: '已存在标签' } });
    page.onItemNoteInput({ detail: { value: '复查 抽血' } });
    page.extractTagsFromNote();
    ok('追加模式：原有标签保留', page.data.itemEditTags.indexOf('已存在标签') >= 0, JSON.stringify(page.data.itemEditTags));
    ok('追加模式：新标签也加进', page.data.itemEditTags.indexOf('抽血') >= 0, JSON.stringify(page.data.itemEditTags));

    // 空备注降级
    await seed();
    await sleep(30);
    page.editItem({ currentTarget: { dataset: { idx: '1' } } });
    toasts = [];
    page.onItemNoteInput({ detail: { value: '' } });
    page.extractTagsFromNote();
    ok('空备注不提取并提示', toasts.some(t => /空的/.test(t.title)), JSON.stringify(toasts.map(t => t.title)));

    console.log('\n[取消不落盘 / 不支持时降级]');
    await seed();
    await sleep(30);
    page.editItem({ currentTarget: { dataset: { idx: '1' } } });
    page.onItemKeywordInput({ detail: { value: '不应被保存' } });
    page.cancelItemEdit();
    ok('取消后编辑态关闭', page.data.itemEditOpen === false);
    ok('取消不写入', (storage[STORE][0].items[1].tags || []).indexOf('不应被保存') < 0);

    // 临时把 isSupported 关掉，验证降级提示不崩
    require.cache[ocrPath].exports.isSupported = () => false;
    await seed();
    await sleep(30);
    page.editItem({ currentTarget: { dataset: { idx: '1' } } });
    let crashed = false;
    try { page.reOcrItem({ currentTarget: { dataset: { idx: '1' } } }); } catch (e) { crashed = true; }
    ok('不支持识别时不崩溃', crashed === false);
    ok('不支持时弹提示', modals.some(m => /本机识别不可用/.test(m.title)), JSON.stringify(modals.map(m => m.title)));
    require.cache[ocrPath].exports.isSupported = () => true;

    console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
