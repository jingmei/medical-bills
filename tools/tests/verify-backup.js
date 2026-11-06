/* 模拟真机：本机备份 / 恢复全链路，含失败回滚与「大文本不进 data」 */
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

const storage = {};
const clipboard = [];
const toasts = [];
let writeFileShouldFail = false;
let shareShouldFail = false;
function makeFs() {
    return {
        mkdir: o => o.success && o.success(),
        access: o => o.success && o.success(),
        readFile: o => o.success && o.success({ data: 'QUJD' }),
        writeFile: o => (writeFileShouldFail ? (o.fail && o.fail({ errMsg: 'mock: no space' })) : (o.success && o.success())),
        writeFileSync: () => { if (writeFileShouldFail) throw new Error('mock: no space'); },
        unlink: o => o.success && o.success(),
        rmdir: o => o.success && o.success(),
        saveFile: o => o.success && o.success({ savedFilePath: o.filePath }),
        copyFile: o => o.success && o.success(),
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
    setClipboardData: o => { clipboard.push(o); if (o.success) o.success(); },
    chooseMessageFile: o => o.fail && o.fail({ errMsg: 'mock: cancel' }),
    shareFileMessage: o => {
        if (shareShouldFail) { o.fail && o.fail({ errMsg: 'mock: not supported' }); }
        else { o.success && o.success(); }
    },
};
global.getApp = () => ({ hasPrivacyAgreed: () => true });

const backup = require(ROOT + '/utils/backup');
const STORAGE_KEY = require(ROOT + '/utils/bill-store').STORAGE_KEY;
const LABELS = { body: '身体数据', list: '我的清单', invoice: '发票', report: '检查报告', other: '其他' };

function goodPayload() {
    return {
        app: backup.APP_ID,
        version: backup.FORMAT_VERSION,
        createdAt: '2026-11-06 07:00',
        includeImages: true,
        types: LABELS,
        records: [{
            id: 'r-1', visitDate: '2026-11-05', keyword: 'a b', docType: 'report', note: 'n',
            createdAt: 1, updatedAt: 2,
            images: [{ name: 'p1.jpg', size: 3, addedAt: 1, data: 'QUJD' }],
        }],
    };
}

console.log('\n[1] parseBackup 校验');
ok('空内容被拒绝', backup.parseBackup('').ok === false);
ok('非 JSON 被拒绝', backup.parseBackup('hello').ok === false);
ok('别的 app 备份被拒绝', backup.parseBackup(JSON.stringify({ app: 'other', version: 1, records: [] })).ok === false);
ok('版本不兼容被拒绝', backup.parseBackup(JSON.stringify({ app: backup.APP_ID, version: 99, records: [] })).ok === false);
ok('缺记录列表被拒绝', backup.parseBackup(JSON.stringify({ app: backup.APP_ID, version: 1 })).ok === false);
ok('坏记录被拒绝且带行号', /第 1 条/.test(backup.parseBackup(JSON.stringify({
    app: backup.APP_ID, version: 1, records: [{ id: 'x' }],
})).message));
ok('正常备份可解析', backup.parseBackup(JSON.stringify(goodPayload())).ok === true);
ok('图片 data 缺失时按精简备份处理', (function () {
    const p = goodPayload(); p.records[0].images[0].data = '';
    const r = backup.parseBackup(JSON.stringify(p));
    return r.ok && r.payload.records[0].images[0].data === '';
})());

console.log('\n[2] summaryOf / mergeRecords');
const s = backup.summaryOf(goodPayload());
ok('统计记录与照片数', s.records === 1 && s.images === 1 && s.withPhoto === 1, JSON.stringify(s));
ok('合并保留现有并按 id 去重', (function () {
    const merged = backup.mergeRecords([{ id: 'r-1' }, { id: 'old' }], [{ id: 'r-1' }, { id: 'new' }], 'merge');
    return merged.length === 3 && merged[0].id === 'r-1';
})());
ok('覆盖模式只保留备份', backup.mergeRecords([{ id: 'old' }], [{ id: 'r-1' }], 'replace').length === 1);

console.log('\n[3] buildBackup 生成');
const records = [
    { id: 'r-1', visitDate: '2026-11-05', keyword: 'a', docType: 'report', note: '', createdAt: 1, updatedAt: 1,
      images: [{ path: 'wxfile://usr/bills/a.jpg', size: 100, addedAt: 1 }] },
    { id: 'r-2', visitDate: '2026-11-04', keyword: 'b', docType: 'body', note: 'n', createdAt: 2, updatedAt: 2,
      images: [{ path: 'wxfile://usr/bills/b.jpg', size: 200, addedAt: 2 }] },
];

async function main() {
    let built = await backup.buildBackup({
        listRecords: () => Promise.resolve(records),
        readImage: () => Promise.resolve('QUJD'),
        getLabels: () => LABELS,
        includeImages: true,
    });
    ok('含照片备份生成成功', built.ok === true, built.message);
    const parsed = backup.parseBackup(built.text);
    ok('生成的文本可被自己解析', parsed.ok === true);
    ok('两条记录与照片数据都在', parsed.payload.records.length === 2
        && parsed.payload.records[0].images[0].data === 'QUJD');
    ok('类型名称一起备份', parsed.payload.types.report === '检查报告');

    built = await backup.buildBackup({
        listRecords: () => Promise.resolve(records),
        readImage: () => Promise.resolve('QUJD'),
        getLabels: () => LABELS,
        includeImages: false,
    });
    const light = backup.parseBackup(built.text).payload;
    ok('仅文字备份不含图片数据', light.includeImages === false && light.records[0].images[0].data === '');
    ok('仅文字备份仍保留照片条目', light.records[0].images.length === 1);

    const partial = await backup.buildBackup({
        listRecords: () => Promise.resolve(records),
        readImage: p => p.indexOf('b.jpg') >= 0 ? Promise.reject(new Error('missing')) : Promise.resolve('QUJD'),
        getLabels: () => LABELS,
    });
    ok('单张照片读不到不影响整体备份', partial.ok === true && partial.missing === 1);

    console.log('\n[4] restoreBackup 恢复与回滚');
    let writtenImages = [], writtenRecords = null, removed = [], savedLabels = null;
    const io = {
        prepare: () => Promise.resolve(),
        writeImage: (name, data) => {
            writtenImages.push(name);
            return Promise.resolve({ path: 'wxfile://usr/bills/new-' + writtenImages.length + '.jpg', size: 3, addedAt: 1 });
        },
        readRecords: () => [{ id: 'old' }],
        writeRecords: list => { writtenRecords = list; },
        saveLabels: m => { savedLabels = m; return { ok: true }; },
        removeFiles: list => { removed = list; return Promise.resolve(list.length); },
    };
    let result = await backup.restoreBackup(JSON.stringify(goodPayload()), Object.assign({}, io, { mode: 'merge' }));
    ok('合并恢复成功', result.ok === true, result.message);
    ok('照片先写盘', writtenImages.length === 1 && writtenImages[0] === 'p1.jpg');
    ok('记录写到本机且保留旧记录', writtenRecords && writtenRecords.length === 2 && writtenRecords[1].id === 'old', JSON.stringify(writtenRecords && writtenRecords.map(r => r.id)));
    ok('恢复的记录带新照片路径', writtenRecords[0].images[0].path.indexOf('new-1') >= 0);
    ok('类型名称一起恢复', savedLabels && savedLabels.report === '检查报告');
    ok('返回统计含照片数', result.data.photos === 1 && result.data.total === 2);

    writtenRecords = null;
    result = await backup.restoreBackup(JSON.stringify(goodPayload()), Object.assign({}, io, { mode: 'replace' }));
    ok('覆盖模式清掉旧记录', writtenRecords.length === 1 && writtenRecords[0].id === 'r-1');

    writtenImages = []; removed = []; writtenRecords = null;
    const broken = Object.assign({}, io, {
        prepare: () => Promise.resolve(),
        writeImage: () => Promise.reject(new Error('照片写入失败：空间不足')),
        removeFiles: list => { removed = list; return Promise.resolve(0); },
    });
    result = await backup.restoreBackup(JSON.stringify(goodPayload()), broken);
    ok('写照片失败时恢复失败', result.ok === false && /空间不足/.test(result.message), result.message);
    ok('失败时原有记录完全没动', writtenRecords === null);
    ok('失败时清理本次新写的照片', Array.isArray(removed));
    ok('失败提示说明原数据未改动', /原有数据未改动/.test(result.message));

    writtenImages = [];
    const lightPayload = goodPayload();
    lightPayload.records[0].images[0].data = '';
    result = await backup.restoreBackup(JSON.stringify(lightPayload), io);
    ok('精简备份跳过写图但仍恢复记录', result.ok === true && writtenImages.length === 0);

    const badLabels = Object.assign({}, io, { saveLabels: () => ({ ok: false, message: '名称不能重复' }) });
    result = await backup.restoreBackup(JSON.stringify(goodPayload()), badLabels);
    ok('类型名称恢复失败不阻断记录恢复', result.ok === true && /类型名称未恢复/.test(result.data.labelsNote));

    console.log('\n[5] 备份页面：大文本不进 data、两步确认、端到端闭环');
    storage[STORAGE_KEY] = [{
        id: 'r-live', visitDate: '2026-11-06', keyword: '原记录', hospital: '', docType: 'report', note: '',
        images: [{ path: 'wxfile://usr/bills/live.jpg', size: 100, addedAt: 1 }],
        createdAt: 10, updatedAt: 10,
    }];
    let page = null;
    global.Page = o => { page = o; };
    const src = fs.readFileSync(path.join(ROOT, 'pages/backup/backup.js'), 'utf8')
        .replace(/require\(['"]\.\.\/\.\.\/utils\//g, "require('" + ROOT + "/utils/");
    const tmp = path.join(os.tmpdir(), 'bill-backup-under-test.js');
    fs.writeFileSync(tmp, src);
    delete require.cache[tmp];
    require(tmp);
    page.setData = function (patch) { Object.assign(page.data, patch); };
    page.onLoad();

    page.makeBackup();
    await sleep(80);
    ok('页面生成备份成功', page.data.backupReady === true && !!page._backupText, page.data.status);
    ok('完整文本只放实例，不进 data', typeof page._backupText === 'string'
        && JSON.stringify(page.data).indexOf('QUJD') < 0, JSON.stringify(page.data).slice(0, 200));
    ok('页面显示记录数/照片数/体积', page.data.exportSummary.records === 1 && /KB|MB/.test(page.data.sizeText));

    clipboard.length = 0;
    page.copyBackup();
    ok('复制把完整备份交给剪贴板', clipboard.length === 1 && clipboard[0].data === page._backupText);

    shareShouldFail = true;
    page.shareBackupFile();
    ok('导出文件失败时明确引导改用复制', /复制备份内容/.test(page.data.status), page.data.status);
    shareShouldFail = false;

    page._importText = page._backupText;
    page.checkBackup();
    ok('检查备份内容后进入可确认状态', page.data.restoreReady === true && page.data.confirming === false);
    ok('未经二次确认不会写入', /检查通过/.test(page.data.restoreHint));
    page.askRestore();
    ok('第一次确认只展开确认条', page.data.confirming === true);
    page.cancelRestore();
    ok('可以取消恢复', page.data.confirming === false && /已取消/.test(page.data.restoreHint));

    page.askRestore();
    page.doRestore();
    await sleep(120);
    ok('二次确认后完成恢复', /恢复完成/.test(page.data.restoreHint), page.data.restoreHint);
    ok('恢复同一编号的记录不会重复', Array.isArray(storage[STORAGE_KEY])
        && storage[STORAGE_KEY].length === 1 && storage[STORAGE_KEY][0].id === 'r-live',
        JSON.stringify(storage[STORAGE_KEY] && storage[STORAGE_KEY].map(r => r.id)));
    ok('恢复后的记录带可用的照片路径', storage[STORAGE_KEY][0].images
        && storage[STORAGE_KEY][0].images[0].path.indexOf('restore-') >= 0,
        JSON.stringify(storage[STORAGE_KEY][0].images));

    const another = JSON.parse(page._backupText);
    another.records[0].id = 'r-other';
    another.records[0].images[0].data = '';
    page._importText = JSON.stringify(another);
    page.checkBackup();
    page.askRestore();
    page.doRestore();
    await sleep(120);
    ok('不同编号的备份会合并进来', storage[STORAGE_KEY].length === 2,
        JSON.stringify(storage[STORAGE_KEY].map(r => r.id)));

    page.clearPaste();
    ok('清空输入会重置状态', page._importText === '' && page.data.importLength === 0 && page.data.restoreReady === false);
    await sleep(80);
    ok('清空后输入框重新可用', page.data.showPaste === true);

    console.log('\n[6] 入口 / 文案 / 合规');
    const appJson = fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8');
    const mineWxml = fs.readFileSync(path.join(ROOT, 'pages/mine/mine.wxml'), 'utf8');
    const privacyWxml = fs.readFileSync(path.join(ROOT, 'pages/privacy/privacy.wxml'), 'utf8');
    const backupWxml = fs.readFileSync(path.join(ROOT, 'pages/backup/backup.wxml'), 'utf8');
    ok('备份页已注册', /pages\/backup\/backup/.test(appJson));
    ok('我的页有备份入口', /goBackup/.test(mineWxml) && /备份与恢复/.test(mineWxml));
    ok('两处都有添加到桌面引导', /添加到桌面/.test(mineWxml) && /添加到桌面/.test(backupWxml));
    ok('桌面引导区分安卓与 iPhone', /iPhone/.test(mineWxml) && /创建桌面快捷方式/.test(mineWxml));
    ok('桌面引导明确不等于备份', /并不会备份数据/.test(mineWxml));
    ok('隐私页说明备份由用户主动操作', /由你主动操作/.test(privacyWxml) && /不会自动读取剪贴板/.test(privacyWxml));
    ok('隐私页不再说无法恢复', !/数据无法从我们这里恢复，重要单据请另行留存纸质件或自行备份/.test(privacyWxml));
    ok('备份页无医疗红线词', !/诊断|用药|疗效|问诊|医院|就诊|就医|医嘱|病情|治疗/.test(backupWxml));
    ok('备份页不联网声明', /不联网|不上传服务器/.test(backupWxml));

    console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
