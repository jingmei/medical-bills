/* 离线校验：JS 语法 / JSON / WXML 绑定 / OCR 提取规则 / 端侧会话兜底 / 保存反馈 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass += 1; console.log('  PASS ' + name); }
    else { fail += 1; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

function walk(dir, out) {
    fs.readdirSync(dir).forEach(function (name) {
        if (name === 'node_modules' || name === '.git') return;
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, out);
        else out.push(p);
    });
    return out;
}

console.log('\n[1] 语法与结构');
const all = walk(ROOT, []).filter(function (f) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    return rel.indexOf('tools/') !== 0 && rel.indexOf('versions/') !== 0;
});
const jsFiles = all.filter(f => f.endsWith('.js'));
jsFiles.forEach(function (f) {
    try { cp.execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); ok('JS ' + path.relative(ROOT, f), true); }
    catch (e) { ok('JS ' + path.relative(ROOT, f), false, String(e.stderr || e)); }
});
all.filter(f => f.endsWith('.json')).forEach(function (f) {
    try { JSON.parse(fs.readFileSync(f, 'utf8')); ok('JSON ' + path.relative(ROOT, f), true); }
    catch (e) { ok('JSON ' + path.relative(ROOT, f), false, e.message); }
});
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
appJson.pages.forEach(function (p) {
    ['js', 'wxml', 'json', 'wxss'].forEach(function (ext) {
        ok('四件套 ' + p + '.' + ext, fs.existsSync(path.join(ROOT, p + '.' + ext)));
    });
});
(appJson.tabBar && appJson.tabBar.list || []).forEach(function (t) {
    ok('tabBar ' + t.pagePath, appJson.pages.indexOf(t.pagePath) >= 0);
});

console.log('\n[2] WXML 事件绑定一致性');
const uploadJs = fs.readFileSync(path.join(ROOT, 'pages/upload/upload.js'), 'utf8');
const uploadWxml = fs.readFileSync(path.join(ROOT, 'pages/upload/upload.wxml'), 'utf8');
const handlers = new Set();
let m;
const re = /\b(?:bind|catch)(?:tap|change|input|blur|confirm|longpress)\s*=\s*"([^"]+)"/g;
while ((m = re.exec(uploadWxml)) !== null) handlers.add(m[1]);
handlers.forEach(function (h) {
    ok('方法 ' + h, new RegExp('(^|\\n)\\s*' + h + '\\s*\\(', 'm').test(uploadJs));
});
ok('无残留 B3 页面标记', !fs.readFileSync(path.join(ROOT, 'pages/upload/upload.wxml'), 'utf8').includes('B3')
    && !fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8').includes('B3')
    && !fs.readFileSync(path.join(ROOT, 'pages/mine/mine.wxml'), 'utf8').includes('B3'));
ok('上传页不再使用 wx.showLoading 遮罩', !/wx\.showLoading\s*\(/.test(uploadJs));
ok('上传页不再调用 wx.hideLoading', !/wx\.hideLoading\s*\(/.test(uploadJs));
ok('保存成功会展示路径', /reportSaved/.test(uploadJs) && /savedPath/.test(uploadWxml));
ok('B5 吸底保存栏存在', /class="save-dock"/.test(uploadWxml) && /dock-btn/.test(uploadWxml));
ok('保存按钮不再有 disabled', !/dock-btn[^>]*disabled=/.test(uploadWxml));
ok('点击第一瞬间写可见反馈', /① 已收到点击/.test(uploadJs));
ok('隐私确认改为页内按钮', /agreePrivacy/.test(uploadJs) && /agreePrivacy/.test(uploadWxml));
ok('保存路径不再被隐私弹窗拦截', !/title: '隐私说明'/.test(uploadJs));
ok('识别有可见等待秒数', /startOcrTicker/.test(uploadJs) && /已等待/.test(uploadJs));
ok('构建标记为 B15', /构建 B15/.test(uploadWxml)
    && fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8').indexOf('构建 B15') >= 0
    && fs.readFileSync(path.join(ROOT, 'utils/build.js'), 'utf8').indexOf("tag: 'B15'") >= 0);
ok('粘贴框默认展开且支持长文本', /manualOpen:\s*true/.test(uploadJs) && /maxlength="2000"/.test(uploadWxml));
ok('不清晰提示含完整本机识图步骤', /两个手指分开长按识别/.test(uploadJs)
    && /选词模式/.test(uploadJs) && /全选/.test(uploadJs) && /复制/.test(uploadJs)
    && /粘贴图中文字.{0,4}框/.test(uploadJs));
ok('不清晰时自动展开粘贴框', /if \(garbled\)[\s\S]{0,900}manualOpen:\s*true/.test(uploadJs));
ok('粘贴框说明也写了操作步骤', /两个手指分开长按/.test(uploadWxml) && /全选/.test(uploadWxml));
ok('保留一键自动识别（普通用户主路径）', /识别图中文字（本机自动）/.test(uploadWxml)
    && /class="ocr-btn[^"]*" catchtap="runOcr"/.test(uploadWxml));
ok('文字草稿可恢复', /manual-draft\.v1/.test(uploadJs) && /getStorageSync\('medical-bills\.manual-draft\.v1'\)/.test(uploadJs));
ok('清空文字方法存在', /clearManual\s*\(/.test(uploadJs) && /catchtap="clearManual"/.test(uploadWxml));
ok('识别结果直达回调', /onOcrResult\s*\(/.test(uploadJs) && /ocr\.recognize\(src,\s*function/.test(uploadJs));
ok('卡住标记与重进兜底', /ocr-pending\.v1/.test(uploadJs) && /stuck/.test(uploadJs));
ok('识别文字可暂存并在重进后恢复', /ocr-last\.v1/.test(uploadJs));
ok('会话清理不再在原生回调栈里同步执行', /pendingSession/.test(fs.readFileSync(path.join(ROOT, 'utils/ocr.js'), 'utf8'))
    && /setTimeout\(function \(\) \{[\s\S]{0,300}pendingSession\.off/.test(fs.readFileSync(path.join(ROOT, 'utils/ocr.js'), 'utf8')));
ok('正则提取有循环上限', /guard\s*>\s*500/.test(fs.readFileSync(path.join(ROOT, 'utils/ocr.js'), 'utf8')));
ok('识别按钮改为 catchtap 视图', /class="ocr-btn[^"]*" catchtap="runOcr"/.test(uploadWxml)
    && /class="ocr-stop" wx:if="\{\{ocrRunning\}\}" catchtap="stopOcr"/.test(uploadWxml));
ok('手动输入改为页内输入框', /manualOpen/.test(uploadJs) && /class="manual-box"/.test(uploadWxml)
    && !/title:\s*'手动输入图中文字'/.test(uploadJs));
ok('手动输入新增三个处理方法', /onManualInput\s*\(/.test(uploadJs)
    && /submitManual\s*\(/.test(uploadJs) && /closeManual\s*\(/.test(uploadJs));
ok('识别启动前让出一帧', /_ocrLaunchTimer\s*=\s*setTimeout/.test(uploadJs) && /,\s*800\)/.test(uploadJs));
ok('停止识别会取消底层会话', /ocr\.cancel\(\)/.test(uploadJs) && /cancel:\s*cancel/.test(fs.readFileSync(path.join(ROOT, 'utils/ocr.js'), 'utf8')));
ok('帧最大边压到 512', /MAX_SIDE\s*=\s*512/.test(fs.readFileSync(path.join(ROOT, 'utils/ocr.js'), 'utf8')));

// B8：乱码闸门 / 备注去重 / 详情页可编辑
const ocrSrc = fs.readFileSync(path.join(ROOT, 'utils/ocr.js'), 'utf8');
const detailJs = fs.readFileSync(path.join(ROOT, 'pages/detail/detail.js'), 'utf8');
const detailWxml = fs.readFileSync(path.join(ROOT, 'pages/detail/detail.wxml'), 'utf8');
const detailWxss = fs.readFileSync(path.join(ROOT, 'pages/detail/detail.wxss'), 'utf8');
ok('识别质量评估已导出', /assessQuality:\s*assessQuality/.test(ocrSrc) && /function assessQuality/.test(ocrSrc));
ok('乱码不切碎片标签', /var blocked = !trusted && quality\.garbled/.test(ocrSrc) && /if \(!blocked\)/.test(ocrSrc));
ok('用户粘贴文字 trusted 不受闸门影响', /analyze\(texts, \{ trusted: trusted \}\)/.test(uploadJs)
    && /applyOcrTexts\(lines, \{[\s\S]*trusted: true/.test(uploadJs));
ok('乱码时页面明确提示且不写关键字', /未自动填写关键字/.test(uploadJs) && /const garbled = !trusted/.test(uploadJs));
ok('长文字行不再截断成标签', /raw\.length > 24/.test(uploadJs) && /这行文字太长/.test(uploadJs));
ok('填入备注去重', /已在备注里/.test(uploadJs) && /current\.indexOf\(joined\.slice\(0, 20\)\)/.test(uploadJs));
ok('详情页有编辑入口与表单', /catchtap="startEdit"/.test(detailWxml) && /catchtap="saveEdit"/.test(detailWxml)
    && /catchtap="cancelEdit"/.test(detailWxml) && /catchtap="clearEditNote"/.test(detailWxml));
ok('详情页编辑复用本机 update', /billStore\.update\(this\.recordId/.test(detailJs));
ok('详情页编辑有可见反馈与失败兜底', /修改未保存/.test(detailJs) && /修改已保存/.test(detailJs) && /editHint/.test(detailWxml));
ok('详情页编辑样式齐全', /\.edit-entry/.test(detailWxss) && /\.edit-btn\.confirm/.test(detailWxss) && /\.edit-textarea/.test(detailWxss));
// 详情页 WXML 事件绑定一致性
const detailHandlers = new Set();
const dre = /\b(?:bind|catch)(?:tap|change|input|blur|confirm|longpress)\s*=\s*"([^"]+)"/g;
while ((m = dre.exec(detailWxml)) !== null) detailHandlers.add(m[1]);
detailHandlers.forEach(function (h) {
    ok('详情页方法 ' + h, new RegExp('(^|\\n)\\s*' + h + '\\s*\\(', 'm').test(detailJs));
});

console.log('\n[3] 红线词扫描');
const red = ['诊断', '治疗建议', '用药', '疗效', '问诊', '处方药', '医院', '就诊', '就医', '病情', '医嘱'];
all.filter(f => /\.(wxml|js|json)$/.test(f)).forEach(function (f) {
    const text = fs.readFileSync(f, 'utf8');
    const hit = red.filter(w => text.indexOf(w) >= 0);
    ok('合规 ' + path.relative(ROOT, f), hit.length === 0, hit.join(','));
});

console.log('\n[4] OCR 提取规则：真实单据文本');
const ocrPath = path.join(ROOT, 'utils/ocr.js');
delete require.cache[require.resolve(ocrPath)];
global.wx = {};
const ocr = require(ocrPath);

// 工具 A：放大分区后由视觉模型逐行转录的「近似 OCR 行」
const visualLines = [
    '激光治疗室预约告知书',
    '尊敬的 郝美 先生/女士：',
    '您在我科预约的治疗时间是：26 年 4 月 22 日 8:00（★请先来排队）',
    '先来先做（晚来需重新预约）治疗项目为 果酸 ★预约当天请预留半天时间',
    '请勿安排其他重要事宜，如您有事无法按时抵达，至少提前三天打电话取消预约或改约',
    '★联系电话 83923333 转 8527 改约的时间可能会推后 1-3 个月，请知悉',
    '一、初诊',
    '★治疗当天请携带好门诊医生开具的治疗单（已缴费/未缴）准时到 30 登记室门口排队登记',
    '★治疗前后一个月请勿暴晒，做好保湿防晒',
    '二、复诊',
    '开好治疗单且已缴费者，听从护士安排：交单—洗脸—拍照—31 观察室等待治疗',
    '未开治疗单或治疗单超过一个月未缴费者，需在 30 登记室找护士拿加号单',
    '三、护理',
    '（31 观察室）',
];
const a = ocr.analyze(visualLines);
console.log('  工具A 结果:', JSON.stringify({ date: a.date, title: a.title, times: a.times, tags: a.tags }, null, 0));
ok('A 标题命中', a.title.indexOf('告知书') >= 0, a.title);
ok('A 关键时间 1-3 个月', a.times.some(t => /1\s*-\s*3\s*个?月/.test(t)), JSON.stringify(a.times));
ok('A 关键时间 8:00 或 2:00', a.times.some(t => /[:：]/.test(t)), JSON.stringify(a.times));
ok('A 时间标签进入 tags', a.tags.some(t => /1\s*-\s*3\s*个?月/.test(t)), JSON.stringify(a.tags));
ok('A 标题标签进入 tags', a.tags.indexOf(a.title) >= 0);
ok('A 不把房间号当时间', !a.times.some(t => /^\d+\s*(登记室|观察室)/.test(t)), JSON.stringify(a.times));
ok('A 标签不超过 8 个', a.tags.length <= 8, String(a.tags.length));

// 工具 B：完整日期版（模拟另一台设备 OCR 把年份识别全）
const fullDateLines = [
    '激光治疗室预约告知书',
    '2026年4月22日 8:00 预约治疗',
    '至少提前三天打电话取消预约或改约',
    '改约的时间可能会推后 1-3 个月，请知悉',
    '治疗前后一个月请勿暴晒',
    '联系电话 83923333',
];
const b = ocr.analyze(fullDateLines);
console.log('  工具B 结果:', JSON.stringify({ date: b.date, title: b.title, times: b.times, tags: b.tags }, null, 0));
ok('B 提取完整日期 2026-04-22', b.date === '2026-04-22', b.date);
ok('B 日期进入标签', b.tags.indexOf('2026-04-22') >= 0);
ok('B 标题正确', b.title.indexOf('告知书') >= 0, b.title);
ok('B 关键时间进入标签', b.tags.some(t => /1\s*-\s*3\s*个?月/.test(t)) && b.tags.some(t => /8:00/.test(t)), JSON.stringify(b.tags));

// 工具 C：用户手动输入的一行文字（showModal editable 单行）
const manual = ['2026-04-28 激光治疗室预约告知书 2:00 1-3个月 提前三天'];
const c = ocr.analyze(manual);
console.log('  工具C 结果:', JSON.stringify({ date: c.date, title: c.title, times: c.times, tags: c.tags }, null, 0));
ok('C 手动输入也能提取日期', c.date === '2026-04-28', c.date);
ok('C 手动输入也能提取时间', c.times.some(t => /2:00/.test(t)), JSON.stringify(c.times));
ok('C 手动输入也有标题标签', c.tags.some(t => t.indexOf('告知书') >= 0), JSON.stringify(c.tags));

// 工具 D：模拟端侧 OCR 常见的碎片化输出（短行、断行、错字、乱序）
const fragmentedLines = [
    '激光治疗室预约告知书',
    '尊敬的 先生/女士',
    '您在我科预约的治疗时间是',
    '26 年 4 月 22 日',
    '8:00',
    '★请先来排队',
    '电话 83923333 转 8527',
    '改约的时间可能会推后 1-3 个月',
    '至少提前三天打电话取消预约',
    '治疗前后一个月请勿暴晒',
    '30 登记室',
    '31 观察室',
];
const d = ocr.analyze(fragmentedLines);
console.log('  工具D 结果:', JSON.stringify({ date: d.date, title: d.title, times: d.times, tags: d.tags }, null, 0));
ok('D 碎片行仍有标题', d.title.indexOf('告知书') >= 0, d.title);
ok('D 碎片行仍有时刻', d.times.some(t => /8:00/.test(t)), JSON.stringify(d.times));
ok('D 碎片行仍有 1-3 个月', d.times.some(t => /1\s*-\s*3\s*个?月/.test(t)), JSON.stringify(d.times));
ok('D 碎片行仍有提前三天', d.times.some(t => /提前三天/.test(t)), JSON.stringify(d.times));
ok('D 碎片行不把房间号当时间', !d.times.some(t => /登记室|观察室/.test(t)), JSON.stringify(d.times));
ok('D 标签里同时有标题与时间', d.tags.some(t => t.indexOf('告知书') >= 0) && d.tags.some(t => /8:00/.test(t)), JSON.stringify(d.tags));

// 工具 E：真机自动识别返回的整行乱码（用户 06:00 截图原文）
const garbledLine = '凝光治疗室预约告知书_2820h21个;共门生不行单(时光不肖的:高制厅个月.'
    + '不学加不蹭做，面医<需号仔行鱼家听从上支部，一4 毛市的介成羊一个f和费，'
    + '在享1加号单上时二，护加有不销请验行过中发友, 武上等型发，苦';
const e = ocr.analyze([garbledLine]);
console.log('  工具E 结果:', JSON.stringify({ garbled: e.quality.garbled, score: e.quality.score, tags: e.tags }, null, 0));
ok('E 整行乱码被识别为低质量', e.quality.garbled === true, JSON.stringify(e.quality));
ok('E 乱码不产生碎片标签', !e.tags.some(t => /在享|护加|武上|门生|毛市/.test(t)), JSON.stringify(e.tags));
ok('E 乱码不猜标题', e.title === '', e.title);
ok('E 质量评估给出可读原因', e.quality.reason.length > 0, e.quality.reason);
const eTrusted = ocr.analyze([garbledLine], { trusted: true });
ok('E 用户主动粘贴时不套用闸门', eTrusted.tags.length >= e.tags.length,
    JSON.stringify({ trusted: eTrusted.tags, blocked: e.tags }));
ok('E 干净长文本不会被误判', ocr.assessQuality(visualLines).garbled === false,
    JSON.stringify(ocr.assessQuality(visualLines)));
ok('E 碎片化 OCR 不会被误判', ocr.assessQuality(fragmentedLines).garbled === false);
ok('E 手动一行输入不会被误判', ocr.assessQuality(manual).garbled === false);
ok('E 汉字夹数字不再成为标签', !ocr.extractTags(['在享1加号单上时二', '30 登记室']).tags.includes('在享1加号单上时二'));

// 边界：空输入、纯数字、手写年份不全
ok('空文本不崩', ocr.analyze([]).tags.length === 0 && ocr.analyze([]).date === '');
ok('年份不全部猜测', ocr.extractDate(['20?年4月28日 2:00']) === '', ocr.extractDate(['20?年4月28日 2:00']));
ok('非法日期不输出', ocr.extractDate(['2026年13月45日']) === '', ocr.extractDate(['2026年13月45日']));
ok('纯数字行不作为标签', !ocr.extractTags(['83923333', '123456']).tags.includes('83923333'));
ok('版本比较', ocr.versionAtLeast('2.27.0', [2, 27, 0]) && !ocr.versionAtLeast('2.26.9', [2, 27, 0]));

console.log('\n[5] 端侧会话：单路轻帧 / 超时 / 空白帧');
// 压缩所有长定时器，让超时分支在测试里快速走完
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn, ms) {
    const args = Array.prototype.slice.call(arguments, 2);
    // 分层压缩：外层硬超时必须明显长于内层会话超时，否则会误抢先触发
    let scaled = ms;
    if (ms >= 8000) scaled = 900;
    else if (ms >= 3000) scaled = 150;
    else if (ms >= 100) scaled = 30;
    return realSetTimeout.apply(global, [fn, scaled].concat(args));
};

function makeWx(behavior) {
    const calls = { versions: [], src: null, destroyed: 0 };
    const canvas = {
        createImage: function () {
            const img = { onload: null, onerror: null, set src(v) { calls.src = v; realSetTimeout(() => img.onload && img.onload(), 0); }, get src() { return calls.src; } };
            return img;
        },
        getContext: function () {
            return {
                clearRect: function () {}, drawImage: function () {},
                getImageData: function (x, y, w, h) {
                    const arr = new Uint8ClampedArray(w * h * 4);
                    if (!behavior.blank) { for (let i = 0; i < arr.length; i += 4) { arr[i] = 30 + (i % 200); arr[i + 3] = 255; } }
                    return { data: arr };
                },
            };
        },
    };
    global.wx = {
        getSystemInfoSync: function () { return { SDKVersion: '3.0.0' }; },
        createVKSession: function (options) {
            calls.versions.push(options.version || '(none)');
            const attemptIndex = calls.versions.length - 1;
            const listeners = {};
            return {
                on: function (evt, cb) { listeners[evt] = cb; },
                off: function (evt) { delete listeners[evt]; },
                start: function (cb) {
                    realSetTimeout(function () {
                        if (behavior.startErrno) { cb(behavior.startErrno); return; }
                        cb(null);
                        if (behavior.replyAt === attemptIndex && listeners.updateAnchors) {
                            listeners.updateAnchors([{ text: '激光治疗室预约告知书' }, { text: '2026年4月22日 8:00' }]);
                        }
                    }, 0);
                },
                runOCR: function () {},
                destroy: function () { calls.destroyed += 1; },
            };
        },
        createOffscreenCanvas: function () { return canvas; },
        getImageInfo: function (o) { o.success({ width: 453, height: 649, path: '/fake/info/path.png' }); },
        env: { USER_DATA_PATH: 'wxfile://usr' },
    };
    return calls;
}

async function run() {
    let calls = makeWx({ replyAt: 0 });
    let texts = [];
    let err = null;
    try { texts = await ocr.recognize('wxfile://tmp/original.png'); } catch (e) { err = e; }
    // B7 起会话清理放到下一个宏任务，等一拍再检查 destroy
    await new Promise(function (r) { realSetTimeout(r, 30); });
    ok('单路成功返回文字', !err && texts.length === 2 && texts[0].indexOf('告知书') >= 0, JSON.stringify(texts) + ' / ' + (err && err.message));
    ok('使用 chooseMedia 原始路径', calls.src === 'wxfile://tmp/original.png', String(calls.src));
    ok('会话已销毁', calls.destroyed >= 1, String(calls.destroyed));
    ok('只跑一路会话，不重复推理', calls.versions.length === 1 && calls.versions[0] === '(none)', JSON.stringify(calls.versions));

    calls = makeWx({ replyAt: -1 });
    err = null;
    try { await ocr.recognize('wxfile://tmp/original.png'); } catch (e) { err = e; }
    ok('无回调会明确失败而非挂死', !!err && /手动输入文字|未返回/.test(err.message), err && err.message);
    ok('失败路径也只跑一路', calls.versions.length === 1, JSON.stringify(calls.versions));

    calls = makeWx({ replyAt: 0, blank: true });
    err = null;
    try { await ocr.recognize('wxfile://tmp/original.png'); } catch (e) { err = e; }
    ok('空白帧给出明确提示', !!err && /解码为空/.test(err.message), err && err.message);

    calls = makeWx({ replyAt: -1 });
    const pending = ocr.recognize('wxfile://tmp/original.png').then(function () { return 'resolved'; }, function (e) { return e.message; });
    realSetTimeout(function () { ocr.cancel(); }, 60);
    const cancelled = await pending;
    await new Promise(function (r) { realSetTimeout(r, 30); });
    ok('cancel 能提前收掉会话', /已停止识别|手动输入文字|未返回/.test(cancelled), cancelled);
    ok('cancel 后会话被销毁', calls.destroyed >= 1, String(calls.destroyed));

    let direct = null;
    calls = makeWx({ replyAt: 0 });
    try {
        await ocr.recognize('wxfile://tmp/original.png', function (t) { direct = t; });
    } catch (e) {}
    ok('结果通过直达回调同步交付', Array.isArray(direct) && direct.length === 2, JSON.stringify(direct));

    global.setTimeout = realSetTimeout;
    console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
}
run().catch(function (e) { console.error('TEST CRASH', e); process.exit(1); });
