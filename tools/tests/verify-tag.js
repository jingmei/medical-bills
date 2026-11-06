/* 模拟真机：标签可手动新增 / 改字 / 删除，且与关键字输入框双向同步 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass += 1; console.log('  PASS ' + name); }
    else { fail += 1; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const storage = {};
const toasts = [];
function makeFs() {
    const call = (o, result) => { if (o.success) o.success(result || {}); };
    return {
        mkdir: o => call(o), access: o => call(o), unlink: o => call(o),
        rmdir: o => call(o), saveFile: o => call(o, { savedFilePath: o.filePath }),
        copyFile: o => call(o), readFile: o => call(o, { data: '' }),
        writeFile: o => call(o),
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
    showModal: o => { if (o.success) o.success({ confirm: true }); },
    navigateTo: () => {}, switchTab: () => {}, setClipboardData: () => {},
    createVKSession: () => ({}), createOffscreenCanvas: () => ({}), getImageInfo: () => {},
};
global.getApp = () => ({ hasPrivacyAgreed: () => true, setPrivacyAgreed: () => {} });

const pages = [];
global.Page = o => { pages.push(o); };
function load(pagePath) {
    const src = fs.readFileSync(path.join(ROOT, pagePath), 'utf8')
        .replace(/require\(['"]\.\.\/\.\.\/utils\//g, "require('" + ROOT + "/utils/");
    const tmp = path.join(os.tmpdir(), 'tag-' + path.basename(path.dirname(pagePath)) + '-under-test.js');
    fs.writeFileSync(tmp, src);
    delete require.cache[tmp];
    require(tmp);
    const p = pages[pages.length - 1];
    p.setData = function (patch) { Object.assign(p.data, patch); };
    return p;
}

const tagKit = require(ROOT + '/utils/tag-kit');
const upload = load('pages/upload/upload.js');
const detail = load('pages/detail/detail.js');
upload.onLoad();
detail.data.record = { keywordRaw: '预约告知书 2026-04-28', note: '', visitDate: '2026-11-06' };

function evt(tag) { return { currentTarget: { dataset: { tag: tag } } }; }
function input(value) { return { detail: { value: value } }; }

console.log('\n[1] tag-kit 纯函数');
ok('分词去重且保留顺序', JSON.stringify(tagKit.words('b a b c')) === '["b","a","c"]');
ok('标签内部空白被去掉', tagKit.normalizeTag('  提前 三天 ') === '提前三天');
ok('标签长度截断到 12', tagKit.normalizeTag('一二三四五六七八九十十一十二十三').length === 12);
ok('空标签被拒绝', tagKit.add('a b', '   ').ok === false);
ok('重复标签被拒绝', tagKit.add('a b', 'a').ok === false);
ok('新增标签写回 keyword', tagKit.add('a b', 'c').keyword === 'a b c');
ok('编辑标签精确替换', tagKit.edit('a b c', 'b', 'B').keyword === 'a B c');
ok('编辑成已有标签被拒绝', tagKit.edit('a b', 'a', 'b').ok === false);
ok('编辑成自身允许', tagKit.edit('a b', 'a', 'a').ok === true);
ok('删除按完整词匹配', tagKit.remove('观察房间号 房间', '房间').keyword === '观察房间号');
ok('删除不误伤子串', tagKit.remove('a ab c', 'a').keyword === 'ab c');
ok('最多 8 个标签', (function () {
    const full = '1 2 3 4 5 6 7 8';
    return tagKit.add(full, '9').ok === false && tagKit.edit(full, '1', '9').ok === true;
})());
ok('keyword 超长被截断到 80', tagKit.add('x'.repeat(78), 'yy').keyword.length === 80);

console.log('\n[2] 上传页：关键字与标签条双向同步（针对当前编辑的照片）');
upload.setData({ photos: [{ key:'p1', tempFilePath:'f1', size:1, photoNo:1, docType:'body', typeText:'身体数据', typeIndex:0, ocrTexts:[], keyword:'', ocrTags:[], ocrDate:'', ocrHint:'', note:'', manualText:'', recognized:false }], activeKey:'p1', active:null });
upload.setActive('p1');
upload.editActiveKeyword('预约告知书 2026-04-28 8:00');
ok('三组词变三个标签', upload.data.active.ocrTags.length === 3, JSON.stringify(upload.data.active.ocrTags));
upload.editActiveKeyword('提前三天 1-3个月');
ok('直接改输入框标签实时跟着变', upload.data.active.ocrTags.length === 2 && upload.data.active.ocrTags[1] === '1-3个月');

console.log('\n[3] 上传页：点标签改字');
upload.editActiveKeyword('在享1加号单上时二 8:00');
upload.editTag(evt('在享1加号单上时二'));
ok('点标签打开编辑器并带入原值', upload.data.tagEditorOpen === true && upload.data.tagEditorText === '在享1加号单上时二');
upload.onTagEditorInput(input('预约告知书'));
upload.submitTagEditor();
ok('改字后 keyword 与标签都更新', upload.data.active.keyword === '预约告知书 8:00'
    && upload.data.active.ocrTags.indexOf('预约告知书') >= 0, upload.data.active.keyword);
ok('改完自动收起编辑器', upload.data.tagEditorOpen === false);

upload.editActiveKeyword('a b');
upload.editTag(evt('a'));
upload.onTagEditorInput(input('b'));
upload.submitTagEditor();
ok('改成重复标签会拒绝且不改动数据', upload.data.tagEditorOpen === true
    && upload.data.active.keyword === 'a b' && /已经/.test(upload.data.tagEditorHint), upload.data.tagEditorHint);
upload.closeTagEditor();
ok('取消编辑不改数据', upload.data.active.keyword === 'a b' && upload.data.tagEditorOpen === false);

console.log('\n[4] 上传页：手动新增与删除');
upload.editActiveKeyword('');
upload.openTagEditor();
ok('没有识别结果也能打开新增框', upload.data.tagEditorOpen === true && upload.data.tagEditorTag === '');
upload.onTagEditorInput(input('2026-4-28'));
upload.submitTagEditor();
ok('手动新增的标签写入 keyword', upload.data.active.keyword === '2026-4-28' && upload.data.active.ocrTags.length === 1);
upload.openTagEditor();
upload.onTagEditorInput(input(''));
upload.submitTagEditor();
ok('空输入被拒绝', upload.data.tagEditorOpen === true && upload.data.active.keyword === '2026-4-28' && !!upload.data.tagEditorHint);
upload.closeTagEditor();

upload.editActiveKeyword('观察房间号 房间 8:00');
upload.removeOcrTag(evt('房间'));
ok('点 × 只删完整词，不误删长词', upload.data.active.keyword === '观察房间号 8:00', upload.data.active.keyword);
upload.editActiveKeyword('a b');
upload.addTagFromLine({ currentTarget: { dataset: { line: '凝光治疗室预约告知书_2820h21个;共门生不行单(时光不肖的:高制厅个月.不学加不蹭做' } } });
ok('超长文字行仍不作为标签', upload.data.active.keyword === 'a b');
upload.addTagFromLine({ currentTarget: { dataset: { line: '提前三天' } } });
ok('短文字行仍可加为标签', upload.data.active.keyword === 'a b 提前三天');

console.log('\n[5] 详情页编辑模式：同一套标签能力');
detail.startEdit();
ok('进入编辑时从记录派生标签', detail.data.editTags.length === 2 && detail.data.editTags[0] === '预约告知书');
detail.onEditKeywordInput(input('a b c'));
ok('详情页直接改输入框标签同步', detail.data.editTags.length === 3);
detail.editTag(evt('b'));
detail.onTagEditorInput(input('B'));
detail.submitTagEditor();
ok('详情页改字生效', detail.data.editKeyword === 'a B c' && detail.data.editTags.indexOf('B') >= 0);
ok('详情页提示保存修改后生效', /保存修改/.test(detail.data.editHint), detail.data.editHint);
detail.removeEditTag(evt('a'));
ok('详情页删除标签精确', detail.data.editKeyword === 'B c', detail.data.editKeyword);
detail.openTagEditor();
detail.onTagEditorInput(input('补充词'));
detail.submitTagEditor();
ok('详情页手动新增标签', detail.data.editKeyword === 'B c 补充词');
detail.editTag(evt('补充词'));
detail.cancelEdit();
ok('取消编辑会收起标签编辑器', detail.data.tagEditorOpen === false && detail.data.editing === false);

console.log('\n[6] 页面结构');
const uploadWxml = fs.readFileSync(path.join(ROOT, 'pages/upload/upload.wxml'), 'utf8');
const detailWxml = fs.readFileSync(path.join(ROOT, 'pages/detail/detail.wxml'), 'utf8');
const appWxss = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8');
ok('两页都有 ＋ 手动加标签', /＋ 手动加标签/.test(uploadWxml) && /＋ 手动加标签/.test(detailWxml));
ok('两页都能点标签改字', /catchtap="editTag"/.test(uploadWxml) && /catchtap="editTag"/.test(detailWxml));
ok('标签面板常驻，不受识别结果区显示条件限制', /class="field tag-field"/.test(uploadWxml));
ok('不用 button 组件承载标签操作', !/<button[^>]*catchtap="(editTag|openTagEditor|removeOcrTag)/.test(uploadWxml));
ok('标签编辑框是页内输入框，不用 editable 弹窗', (function () {
    const pure = fs.readFileSync(path.join(ROOT, 'pages/upload/upload.js'), 'utf8')
        .split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
    return /class="tag-editor-input"/.test(uploadWxml) && !/editable:\s*true/.test(pure);
})());
ok('共享样式已放入 app.wxss', /\.tag-chip/.test(appWxss) && /\.tag-editor/.test(appWxss));

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
