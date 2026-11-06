/* 模拟真机：详情页编辑已保存记录（关键字 / 拍照日期 / 类型 / 备注） */
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

const src = fs.readFileSync(path.join(ROOT, 'pages/detail/detail.js'), 'utf8')
    .replace(/require\(['"]\.\.\/\.\.\/utils\//g, "require('" + ROOT + "/utils/");
const tmp = path.join(os.tmpdir(), 'bill-detail-under-test.js');
fs.writeFileSync(tmp, src);
delete require.cache[tmp];
require(tmp);
page.setData = function (o) { Object.assign(page.data, o); };

const STORE = 'medical-bills.records.v1';

function seed() {
    storage = {};
    toasts = []; modals = [];
    storage[STORE] = [{
        id: 'r-1',
        visitDate: '2026-11-06',
        keyword: '凝光治疗室预约告知书_2 预约告知书 2026-04-28',
        docType: 'report',
        note: '凝光治疗室预约告知书_2820h21个;共门生不行单(时光不肖的:高制厅个月 · 凝光治疗室预约告知书_2820h21个;共门生不行单(时光不肖的:高制厅个月',
        images: [{ path: 'wxfile://usr/bills/bill-1.jpg', size: 133000, addedAt: 1 }],
        createdAt: 1793916100435,
        updatedAt: 1793916100435,
    }];
    page.data.loading = true;
    page.data.notFound = false;
    page.data.editing = false;
    page.data.saving = false;
    page.onLoad({ id: 'r-1' });
}

async function main() {
    console.log('\n[详情页读取与编辑入口]');
    await seed();
    await sleep(30);
    ok('记录读取成功', page.data.loading === false && page.data.notFound === false);
    ok('显示类型名称', page.data.record.docType === '检查报告', page.data.record.docType);
    ok('显示原关键字', /凝光/.test(page.data.record.keyword));
    ok('照片路径可读', page.data.images.length === 1 && /bill-1\.jpg/.test(page.data.images[0].path));

    page.startEdit();
    ok('点编辑进入编辑态', page.data.editing === true);
    ok('编辑框带入原关键字（不是占位文案）', /凝光/.test(page.data.editKeyword), page.data.editKeyword);
    ok('编辑框带入原备注', /2820h21/.test(page.data.editNote));
    ok('编辑框带入原拍照日期', page.data.editDate === '2026-11-06');
    ok('类型默认选中原分类', page.data.editTypeText === '检查报告', page.data.editTypeText);
    ok('进入编辑态有可见提示', /保存修改/.test(page.data.editHint), page.data.editHint);

    console.log('\n[清理乱码并保存]');
    page.onEditKeywordInput({ detail: { value: '预约告知书 2026-04-28' } });
    page.clearEditNote();
    ok('清空备注即时生效', page.data.editNote === '');
    page.onEditDateChange({ detail: { value: '2026-04-28' } });
    page.onEditTypeChange({ detail: { value: '1' } });
    ok('切换类型生效', page.data.editTypeText === '我的清单', page.data.editTypeText);
    page.saveEdit();
    await sleep(80);
    const rec = (storage[STORE] || [])[0] || {};
    ok('关键字已改正', rec.keyword === '预约告知书 2026-04-28', rec.keyword);
    ok('备注已清空', rec.note === '', rec.note);
    ok('拍照日期已更新', rec.visitDate === '2026-04-28', rec.visitDate);
    ok('类型已按 key 保存', rec.docType === 'list', rec.docType);
    ok('照片未被改动', rec.images && rec.images.length === 1 && rec.images[0].path === 'wxfile://usr/bills/bill-1.jpg');
    ok('保存成功后退出编辑态', page.data.editing === false);
    ok('保存成功有 toast', toasts.some(t => /修改已保存/.test(t.title)), JSON.stringify(toasts.map(t => t.title)));
    ok('页面数据已刷新', page.data.record.keyword === '预约告知书 2026-04-28' && page.data.record.docType === '我的清单');

    console.log('\n[取消 / 校验 / 保留原文]');
    await seed();
    await sleep(30);
    page.startEdit();
    page.onEditKeywordInput({ detail: { value: '不该被保存' } });
    page.cancelEdit();
    ok('取消后不写入', storage[STORE][0].keyword.indexOf('不该被保存') < 0);
    ok('取消后退出编辑态', page.data.editing === false);

    await seed();
    await sleep(30);
    page.startEdit();
    page.onEditDateChange({ detail: { value: '' } });
    page.saveEdit();
    ok('缺拍照日期有明确提示', /拍照日期/.test(page.data.editHint), page.data.editHint);
    ok('缺拍照日期不写入', storage[STORE][0].visitDate === '2026-11-06');

    console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
