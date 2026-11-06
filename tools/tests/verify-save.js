/* 模拟真机：验证「保存到本机」一定有明确反馈 + 保存路径可见 + 失败不静默 */
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
let modals = [], toasts = [], tabs = [], clipboard = [], storage = {};
let fsFail = false;
let privacyAgreed = true;

function makeFs() {
    const call = (o, okResult) => {
        if (fsFail && o.fail) o.fail({ errMsg: 'mock: write denied' });
        else if (o.success) o.success(okResult || {});
    };
    return {
        mkdir: o => call(o),
        access: o => call(o),
        saveFile: o => call(o, { savedFilePath: o.filePath || 'wxfile://usr/auto-saved.jpg' }),
        copyFile: o => call(o),
        unlink: o => call(o),
        rmdir: o => call(o),
    };
}

global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getSystemInfoSync: () => ({ SDKVersion: '3.5.0' }),
    getFileSystemManager: makeFs,
    getStorageSync: k => storage[k],
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: k => { delete storage[k]; },
    showModal: o => { modals.push(o); if (o.success) o.success({ confirm: true, cancel: false }); },
    showToast: o => { toasts.push(o); },
    switchTab: o => { tabs.push(o); },
    setClipboardData: o => { clipboard.push(o); },
    navigateTo: () => {}, previewImage: () => {}, chooseMedia: () => {},
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

function reset() {
    modals = []; toasts = []; tabs = []; clipboard = []; storage = {}; fsFail = false; privacyAgreed = true;
    page.setData({
        photos: [{ key: 'a', tempFilePath: 'wxfile://tmp/a.jpg', size: 123, photoNo: 1, docType: 'report', typeText: '检查报告', typeIndex: 3, ocrTexts: [], keyword: '激光治疗室预约告知书 8:00', ocrTags: ['激光治疗室预约告知书', '8:00'], ocrDate: '', ocrHint: '', note: '', manualText: '', recognized: false }],
        activeKey: 'a', active: null,
        fileCount: 1, remaining: 8, canAdd: true,
        visitDate: '2026-11-05',
        typeKey: 'report',
        keyword: '', note: '',
        submitting: false,
        savedInfo: '', savedPath: '', savedDir: '', savedCount: 0,
        formError: '', saveHint: '',
        manualOpen: true, manualText: '',
    });
    page.setActive('a');
    page.onLoad();
}

async function main() {
    console.log('\n[保存成功路径]');
    reset();
    page.save();
    await sleep(120);

    const saved = modals.find(m => m.title === '已保存到本机');
    ok('弹出「已保存到本机」结果弹窗', !!saved, JSON.stringify(modals.map(m => m.title)));
    if (saved) {
        ok('弹窗显示保存目录 /bills/', saved.content.indexOf('/bills/') >= 0, saved.content);
        ok('弹窗显示私有目录根 wxfile://usr', saved.content.indexOf('wxfile://usr') >= 0);
        ok('弹窗显示记录数与照片数', saved.content.indexOf('1 条记录') >= 0 && saved.content.indexOf('1 张照片') >= 0);
        ok('弹窗说明相册/文件管理器看不到', saved.content.indexOf('文件管理器看不到') >= 0);
        ok('弹窗提供「查看单据」按钮', saved.confirmText === '查看单据');
    }
    ok('页面结果卡片保留路径', !!page.data.savedPath && page.data.savedPath.indexOf('bill-') >= 0, page.data.savedPath);
    ok('页面结果卡片有说明文字', page.data.savedInfo.indexOf('已保存') >= 0, page.data.savedInfo);
    ok('保存完成后按钮解锁', page.data.submitting === false);
    ok('临时照片列表已清空', page.data.photos.length === 0);
    ok('记录确实写入本机存储', Array.isArray(storage['medical-bills.records.v1']) && storage['medical-bills.records.v1'].length === 1,
        JSON.stringify(storage['medical-bills.records.v1'] || null));
    ok('确认后跳转单据页', tabs.some(t => t.url === '/pages/index/index'));
    ok('复制路径按钮可用', (function () { try { page.copySavedPath(); return clipboard.length === 1 && clipboard[0].data.indexOf('bill-') >= 0; } catch (e) { return false; } })());

    console.log('\n[保存失败路径]');
    reset();
    fsFail = true;
    page.save();
    await sleep(150);
    const failed = modals.find(m => m.title === '保存失败');
    ok('失败也弹明确错误', !!failed, JSON.stringify(modals.map(m => m.title)));
    ok('失败后按钮解锁', page.data.submitting === false);
    ok('失败后保留已选照片可重试', page.data.photos.length === 1);
    ok('失败时页面有文字提示', page.data.saveHint.indexOf('保存未完成') >= 0, page.data.saveHint);
    ok('失败时不会写入记录', !storage['medical-bills.records.v1'] || storage['medical-bills.records.v1'].length === 0);

    console.log('\n[点击即时反馈 / 隐私不再静默]');
    reset();
    page.save();
    ok('点击后同步就有可见步骤文字（不用等异步）', /[①②]/.test(page.data.saveHint), page.data.saveHint);
    await sleep(120);
    ok('成功后反馈变成第④步', page.data.saveHint.indexOf('④') >= 0, page.data.saveHint);

    reset();
    privacyAgreed = false;
    page.onLoad();
    ok('未同意时吸底栏显示确认入口', page.data.needPrivacy === true);
    page.save();
    await sleep(60);
    ok('未同意点保存有明确文字反馈', page.data.saveHint.indexOf('同意') >= 0, page.data.saveHint);
    ok('未同意点保存会弹 toast 提示', toasts.length > 0, JSON.stringify(toasts.map(t => t.title)));
    ok('未同意时不会写入记录', !storage['medical-bills.records.v1']);
    page.agreePrivacy();
    ok('点同意后确认入口消失', page.data.needPrivacy === false);
    page.save();
    await sleep(120);
    ok('同意后保存成功', !!modals.find(m => m.title === '已保存到本机'));

    console.log('\n[识别不阻塞保存]');
    reset();
    page.setData({ ocrRunning: true });
    page._ocrSettled = false;
    page.save();
    await sleep(120);
    ok('识别进行中点保存会被收尾', page.data.ocrRunning === false);
    ok('识别进行中仍能保存成功', !!modals.find(m => m.title === '已保存到本机'));

    console.log('\n[页内手动输入：不依赖 editable 弹窗]');
    reset();
    page.setData({ ocrRunning: true });
    page._ocrSettled = false;
    ok('文字输入框默认展开（无需额外点击）', page.data.manualOpen === true);
    page.inputTextManually();
    ok('点击可收起文字输入框', page.data.manualOpen === false);
    page.inputTextManually();
    ok('再点可重新展开', page.data.manualOpen === true);
    ok('操作时会收掉挂起的识别状态', page.data.ocrRunning === false);
    ok('展开过程不弹任何 modal', modals.length === 0, JSON.stringify(modals.map(m => m.title)));
    page.onManualInput({ detail: { value: '2026-04-28 激光治疗室预约告知书 2:00 提前三天 1-3个月' } });
    page.submitManual();
    ok('自动提取出图中日期', page.data.active.ocrDate === '2026-04-28', page.data.active.ocrDate);
    ok('自动提取出标题标签', page.data.active.ocrTags.some(t => t.indexOf('告知书') >= 0), JSON.stringify(page.data.active.ocrTags));
    ok('自动提取出关键时间标签', page.data.active.ocrTags.some(t => /提前三天|1-3个月|2:00/.test(t)), JSON.stringify(page.data.active.ocrTags));
    ok('标签自动填入关键字', /告知书/.test(page.data.active.keyword), page.data.active.keyword);
    ok('提交后保持展开且不保留输入原文', page.data.manualOpen === true && page.data.manualText === '');

    console.log('\n[B7 草稿与识别结果兜底]');
    reset();
    page.onManualInput({ detail: { value: '激光治疗室预约告知书 2026-04-28 2:00' } });
    ok('输入时实时暂存草稿', String(storage['medical-bills.manual-draft.v1'] || '').indexOf('告知书') >= 0);
    page.data.manualText = '';
    page.onLoad();
    ok('重进后草稿自动恢复', String(page.data.manualText).indexOf('告知书') >= 0);
    page.clearManual();
    ok('清空会删除草稿', !storage['medical-bills.manual-draft.v1']);

    reset();
    page._ocrSettled = false;
    page.setData({ ocrRunning: true });
    page.onOcrResult(['激光治疗室预约告知书', '2026-04-28 2:00 提前三天 1-3个月'], 'a');
    ok('结果直达会立刻复位识别状态', page.data.ocrRunning === false);
    ok('结果直达会暂存文字行', Array.isArray(storage['medical-bills.ocr-last.v1'])
        && storage['medical-bills.ocr-last.v1'].length === 2);
    await sleep(120);
    ok('随后自动整理出标签', /告知书/.test(page.data.active.keyword), page.data.active.keyword);

    reset();
    storage['medical-bills.ocr-pending.v1'] = Date.now() - 10000;
    storage['medical-bills.ocr-last.v1'] = ['激光治疗室预约告知书', '2:00 提前三天'];
    page.patchPhoto('a', { ocrTexts: [], keyword: '' });
    page.setData({ ocrRunning: true });
    page.onShow();
    ok('重进会自动收掉未完成的识别', page.data.ocrRunning === false);
    ok('重进会清掉卡住标记', !storage['medical-bills.ocr-pending.v1']);
    ok('重进会恢复上次文字并自动出标签', /告知书/.test(page.data.active.keyword), page.data.active.keyword);

    console.log('\n[B8 乱码识别不污染关键字]');
    reset();
    const garbled = '凝光治疗室预约告知书_2820h21个;共门生不行单(时光不肖的:高制厅个月.'
        + '不学加不蹭做，面医<需号仔行鱼家听从上支部，一4 毛市的介成羊一个f和费，'
        + '在享1加号单上时二，护加有不销请验行过中发友, 武上等型发，苦';
    page.patchPhoto('a', { keyword: '预约告知书 2026-04-28' });
    page.applyOcrTexts([garbled]);
    ok('乱码识别不改动已填关键字', page.data.active.keyword === '预约告知书 2026-04-28', page.data.active.keyword);
    ok('乱码识别不生成乱码标签', !page.data.active.ocrTags.some(t => /在享|护加|武上|门生|毛市|凝光/.test(t)), JSON.stringify(page.data.active.ocrTags));
    ok('乱码原文仍可查看', page.data.active.ocrTexts.length === 1);
    ok('乱码有明确可读提示', /文字不清晰/.test(page.data.active.ocrHint) && /未自动填写关键字/.test(page.data.active.ocrHint), page.data.active.ocrHint);
    ok('提示含本机识图完整引导', /两个手指分开长按识别/.test(page.data.active.ocrHint)
        && /选词模式/.test(page.data.active.ocrHint) && /全选/.test(page.data.active.ocrHint)
        && /复制/.test(page.data.active.ocrHint) && /粘贴图中文字/.test(page.data.active.ocrHint), page.data.active.ocrHint);
    ok('不清晰时粘贴框自动展开', page.data.manualOpen === true);
    ok('乱码后仍可直接保存', (function () { try { page.save(); return /[①②]/.test(page.data.saveHint); } catch (e) { return false; } })());
    await sleep(120);
    ok('乱码后保存成功', !!modals.find(m => m.title === '已保存到本机'));

    console.log('\n[B8 手动粘贴仍可提取标签]');
    reset();
    page.patchPhoto('a', { keyword: '' });
    page.onManualInput({ detail: { value: '2026-04-28 激光治疗室预约告知书 2:00 提前三天 1-3个月' } });
    page.submitManual();
    ok('手动粘贴不受乱码闸门影响', page.data.active.ocrDate === '2026-04-28'
        && page.data.active.ocrTags.some(t => /告知书/.test(t)), JSON.stringify(page.data.active.ocrTags));
    ok('手动粘贴自动填入关键字', /告知书/.test(page.data.active.keyword), page.data.active.keyword);

    console.log('\n[B8 备注去重 / 长行不截断成标签]');
    reset();
    page.patchPhoto('a', { ocrTexts: ['预约告知书 8:00 提前三天'], note: '' });
    page.fillNoteFromOcr();
    const noteOnce = page.data.active.note;
    page.fillNoteFromOcr();
    ok('连点两次填入备注不重复', page.data.active.note === noteOnce, page.data.active.note);
    ok('备注内容确实写入', /预约告知书/.test(page.data.active.note));
    reset();
    page.patchPhoto('a', { ocrTags: [], keyword: '' });
    page.addTagFromLine({ currentTarget: { dataset: { line: garbled } } });
    ok('超长乱码行不再截断成标签', page.data.active.ocrTags.length === 0 && page.data.active.keyword === '', JSON.stringify(page.data.active.ocrTags));
    page.addTagFromLine({ currentTarget: { dataset: { line: '预约告知书' } } });
    ok('短文字行仍可手动加标签', page.data.active.ocrTags.indexOf('预约告知书') >= 0);

    console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
