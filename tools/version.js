#!/usr/bin/env node
'use strict';
// 本地版本管理：发布前自检 / 源码快照 / 一键回退 / 版本清单。
// 纯 Node 内置模块，无 npm 依赖；快照是「目录副本 + sha256 清单」，可直接用文本工具查看。
// tools/ 与 versions/ 已在 project.config.json 的 packOptions.ignore 中排除，不会进小程序代码包。
//
//   node tools/version.js verify              发布前自检（失败时退出码 1）
//   node tools/version.js list               列出版本历史与可回退快照
//   node tools/version.js status             当前构建标记 / 包体积 / 最近快照
//   node tools/version.js snapshot B12 "说明"  把当前源码存一份快照
//   node tools/version.js release B12 "说明"   统一版本标记 + 自检 + 快照（推荐）
//   node tools/version.js rollback B11        回退到某快照（会先自动备份当前代码）

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const VERSIONS = path.join(ROOT, 'versions');
const MANIFEST = path.join(VERSIONS, 'manifest.json');
const BUILD_FILE = path.join(ROOT, 'utils', 'build.js');
const ROOT_FILES = ['app.js', 'app.json', 'app.wxss', 'sitemap.json', 'project.config.json'];
const SOURCE_DIRS = ['pages', 'utils', 'config'];
const SOURCE_EXTS = ['.js', '.json', '.wxml', '.wxss'];
const RED_WORDS = ['诊断', '治疗建议', '用药', '疗效', '问诊', '处方药', '医院', '就诊', '就医', '病情', '医嘱'];
const MAX_PACK_BYTES = 2 * 1024 * 1024;      // 微信主包上限 2MB
const WARN_PACK_BYTES = 1800 * 1024;         // 预留余量
const BIG_FILE_BYTES = 100 * 1024;

function nowStr() {
    const d = new Date();
    const p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function compactTime() {
    return nowStr().replace(/[- :]/g, '');
}

function relOf(abs) {
    return path.relative(ROOT, abs).replace(/\\/g, '/');
}

function walk(dir, out) {
    if (!fs.existsSync(dir)) return out;
    fs.readdirSync(dir).forEach(function (name) {
        if (name === 'node_modules' || name === '.git') return;
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, out);
        else out.push(p);
    });
    return out;
}

function sourceFiles() {
    const out = [];
    ROOT_FILES.forEach(function (f) {
        const p = path.join(ROOT, f);
        if (fs.existsSync(p)) out.push(p);
    });
    SOURCE_DIRS.forEach(function (dir) {
        walk(path.join(ROOT, dir), []).forEach(function (p) {
            if (SOURCE_EXTS.indexOf(path.extname(p).toLowerCase()) >= 0) out.push(p);
        });
    });
    return out.map(relOf).sort();
}

function allProjectFiles() {
    return walk(ROOT, []).map(relOf).filter(function (rel) {
        return rel.indexOf('versions/') !== 0 && rel.indexOf('tools/') !== 0
            && rel.indexOf('.workbuddy/') !== 0;
    });
}

function ignoreRules() {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
        return (cfg.packOptions && cfg.packOptions.ignore) || [];
    } catch (e) { return []; }
}

function isIgnored(rel, rules) {
    const norm = rel.replace(/\\/g, '/');
    return rules.some(function (rule) {
        const v = String(rule.value || '').replace(/\\/g, '/').replace(/^\.\//, '');
        if (!v) return false;
        if (rule.type === 'folder') return norm === v || norm.indexOf(v + '/') === 0;
        return norm === v;
    });
}

function packFiles() {
    const rules = ignoreRules();
    return allProjectFiles().filter(function (rel) { return !isIgnored(rel, rules); });
}

function packBytes() {
    return packFiles().reduce(function (sum, rel) {
        try { return sum + fs.statSync(path.join(ROOT, rel)).size; } catch (e) { return sum; }
    }, 0);
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readBuild() {
    const text = fs.readFileSync(BUILD_FILE, 'utf8');
    return {
        tag: (text.match(/tag:\s*'([^']+)'/) || [])[1] || '',
        time: (text.match(/time:\s*'([^']+)'/) || [])[1] || '',
    };
}

function defaultManifest() {
    return {
        schema: 1,
        appId: 'touristappid',
        current: '',
        updatedAt: nowStr(),
        note: 'B10 及更早版本没有本地源码快照；如需回到这些版本，请在微信公众平台「版本管理」里把已上传的开发版本重新设为体验版。',
        history: [
            { tag: 'B4', at: '2026-11-06 00:09', note: '保存结果弹目录与完整路径、识别可靠性', status: '已发布', snapshot: null },
            { tag: 'B5', at: '2026-11-06 05:15', note: '吸底保存栏 + 点击即反馈（真机验证通过）', status: '已发布', snapshot: null },
            { tag: 'B6', at: '2026-11-06 05:31', note: '识别帧降到 512，避开主线程同步阻塞', status: '已发布', snapshot: null },
            { tag: 'B7', at: '2026-11-06 05:45', note: '修复原生回调栈死锁；拍照→识别→保存全链路打通', status: '已发布', snapshot: null },
            { tag: 'B8', at: '2026-11-06 06:16', note: '乱码质量闸门 + 详情页可编辑', status: '已发布', snapshot: null },
            { tag: 'B9', at: '2026-11-06 06:47', note: '文字不清晰时的两指长按选词引导文案', status: '已发布', snapshot: null },
            { tag: 'B10', at: '2026-11-06 07:01', note: '标签可编辑 / 备份恢复 / 桌面引导 / OCR 模块调研', status: '已发布', snapshot: null },
        ],
        snapshots: [],
    };
}

function readManifest() {
    if (!fs.existsSync(MANIFEST)) return defaultManifest();
    try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
    catch (e) { throw new Error('versions/manifest.json 解析失败：' + e.message); }
}

function writeManifest(m) {
    m.updatedAt = nowStr();
    fs.mkdirSync(VERSIONS, { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n', 'utf8');
}

function copyFile(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}

// ---------- verify ----------
function verify() {
    const results = [];
    const check = function (name, ok, detail) {
        results.push({ name: name, ok: !!ok, detail: detail || '' });
    };

    const files = sourceFiles();
    const jsFiles = files.filter(function (f) { return f.endsWith('.js'); });
    const jsonFiles = files.filter(function (f) { return f.endsWith('.json'); });

    jsFiles.forEach(function (rel) {
        try {
            cp.execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
            check('JS 语法 ' + rel, true);
        } catch (e) { check('JS 语法 ' + rel, false, String(e.stderr || e).slice(0, 200)); }
    });
    jsonFiles.forEach(function (rel) {
        try { JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); check('JSON 合法 ' + rel, true); }
        catch (e) { check('JSON 合法 ' + rel, false, e.message); }
    });

    let appJson = null;
    try { appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')); }
    catch (e) { appJson = null; }
    check('app.json 可读', !!appJson);
    if (appJson) {
        (appJson.pages || []).forEach(function (p) {
            ['js', 'wxml', 'json', 'wxss'].forEach(function (ext) {
                check('四件套 ' + p + '.' + ext, fs.existsSync(path.join(ROOT, p + '.' + ext)));
            });
        });
        ((appJson.tabBar && appJson.tabBar.list) || []).forEach(function (t) {
            check('tabBar 已注册 ' + t.pagePath, (appJson.pages || []).indexOf(t.pagePath) >= 0);
        });
    }

    // WXML 里每个 bind/catch 事件都必须在同页 JS 里有方法
    files.filter(function (f) { return f.endsWith('.wxml'); }).forEach(function (rel) {
        const wxml = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const jsPath = path.join(ROOT, rel.replace(/\.wxml$/, '.js'));
        const js = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';
        const handlers = {};
        let m;
        const re = /\b(?:bind|catch)(?:tap|change|input|blur|confirm|longpress|columnchange)\s*=\s*"([^"]+)"/g;
        while ((m = re.exec(wxml)) !== null) handlers[m[1]] = true;
        Object.keys(handlers).forEach(function (h) {
            check('事件 ' + h + ' @ ' + rel, new RegExp('(^|\\n)\\s*' + h + '\\s*\\(', 'm').test(js));
        });
    });

    files.filter(function (f) { return /\.(wxml|js|json)$/.test(f); }).forEach(function (rel) {
        const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const hit = RED_WORDS.filter(function (w) { return text.indexOf(w) >= 0; });
        check('合规红线 ' + rel, hit.length === 0, hit.join(','));
    });

    const build = readBuild();
    const indexWxml = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8');
    const uploadWxml = fs.readFileSync(path.join(ROOT, 'pages/upload/upload.wxml'), 'utf8');
    const mineWxml = fs.readFileSync(path.join(ROOT, 'pages/mine/mine.wxml'), 'utf8');
    const stamp = '构建 ' + build.tag + ' · ' + build.time;
    check('build.js 有 tag/time', !!build.tag && !!build.time);
    check('首页版本行 = ' + stamp, indexWxml.indexOf(stamp) >= 0);
    check('上传页版本行 = ' + stamp, uploadWxml.indexOf(stamp) >= 0);
    check('我的页版本行 = 构建 ' + build.tag, mineWxml.indexOf('构建 ' + build.tag) >= 0);

    const rules = ignoreRules();
    ['docs', 'assets', 'tools', 'versions', '.workbuddy'].forEach(function (folder) {
        check('打包已排除 ' + folder + '/', rules.some(function (r) {
            return r.type === 'folder' && String(r.value).replace(/\\/g, '/') === folder;
        }));
    });
    ['base.png', 'qrcode.png', 'README.md'].forEach(function (file) {
        check('打包已排除 ' + file, rules.some(function (r) {
            return r.type === 'file' && String(r.value).replace(/\\/g, '/') === file;
        }));
    });

    const packed = packFiles();
    const bytes = packBytes();
    check('上传代码包 < 2MB', bytes < MAX_PACK_BYTES, (bytes / 1024).toFixed(1) + ' KB');
    const sensitive = packed.filter(function (rel) { return /\.(key|pem|p12|pfx)$/i.test(rel); });
    check('密钥/证书未打进代码包', sensitive.length === 0, sensitive.join(','));
    const bigLoose = packed.filter(function (rel) {
        if (SOURCE_EXTS.indexOf(path.extname(rel).toLowerCase()) >= 0) return false;
        try { return fs.statSync(path.join(ROOT, rel)).size > BIG_FILE_BYTES; }
        catch (e) { return false; }
    });
    check('无未排除的大资源文件', bigLoose.length === 0, bigLoose.join(','));

    results.forEach(function (r) {
        console.log((r.ok ? '  PASS ' : '  FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
    });
    const fail = results.filter(function (r) { return !r.ok; }).length;
    console.log('\n自检结果：' + (results.length - fail) + ' 项通过 / ' + fail + ' 项失败');
    console.log('上传代码包约 ' + (bytes / 1024).toFixed(1) + ' KB（上限 2048 KB）'
        + (bytes > WARN_PACK_BYTES ? '  ⚠ 已接近上限' : ''));
    return fail;
}

// ---------- snapshot ----------
function validTag(tag) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(String(tag || ''));
}

function snapshot(tag, note, quiet) {
    if (!validTag(tag)) throw new Error('版本号不合法：' + tag + '（只能用字母、数字、点、下划线、连字符）');
    const dir = path.join(VERSIONS, tag);
    if (fs.existsSync(dir)) throw new Error('快照 ' + tag + ' 已存在，请换一个版本号');
    const files = sourceFiles();
    const list = [];
    fs.mkdirSync(dir, { recursive: true });
    files.forEach(function (rel) {
        const src = path.join(ROOT, rel);
        copyFile(src, path.join(dir, rel));
        list.push({ path: rel, bytes: fs.statSync(src).size, sha256: sha256(src) });
    });
    const meta = {
        tag: tag,
        at: nowStr(),
        note: note || '',
        build: readBuild(),
        files: list,
        bytes: list.reduce(function (s, f) { return s + f.bytes; }, 0),
    };
    fs.writeFileSync(path.join(dir, '_snapshot.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

    const m = readManifest();
    m.snapshots = [meta].concat(m.snapshots.filter(function (s) { return s.tag !== tag; }));
    m.current = tag;
    const history = m.history.filter(function (h) { return h.tag !== tag; });
    history.push({ tag: tag, at: meta.at, note: meta.note, status: '已存快照', snapshot: tag });
    m.history = history;
    writeManifest(m);
    if (!quiet) {
        console.log('已保存快照 ' + tag + '：' + files.length + ' 个源码文件，'
            + (meta.bytes / 1024).toFixed(1) + ' KB → versions/' + tag + '/');
    }
    return meta;
}

// ---------- release ----------
function release(tag, note) {
    if (!validTag(tag)) throw new Error('版本号不合法：' + tag);
    if (!note) throw new Error('请写一句本版改动说明');
    const preFail = verify();
    if (preFail) throw new Error('改动后的代码未通过自检，已停止发布（未修改版本号、未生成快照）');

    const time = nowStr();
    let build = fs.readFileSync(BUILD_FILE, 'utf8');
    build = build.replace(/tag:\s*'[^']*'/, "tag: '" + tag + "'")
        .replace(/time:\s*'[^']*'/, "time: '" + time + "'")
        .replace(/note:\s*'[^']*'/, 'note: ' + JSON.stringify(note));
    fs.writeFileSync(BUILD_FILE, build, 'utf8');

    const stamp = '构建 ' + tag + ' · ' + time;
    [
        ['pages/index/index.wxml', /构建\s+B\d+\s*·\s*[\d-]+\s+[\d:]+/g, stamp],
        ['pages/upload/upload.wxml', /构建\s+B\d+\s*·\s*[\d-]+\s+[\d:]+/g, stamp],
        ['pages/mine/mine.wxml', /构建\s+B\d+/g, '构建 ' + tag],
    ].forEach(function (item) {
        const p = path.join(ROOT, item[0]);
        const text = fs.readFileSync(p, 'utf8');
        const next = text.replace(item[1], item[2]);
        // 用「目标标记是否存在」判断成功，允许同一个版本号重复执行（幂等）
        if (next.indexOf(item[2]) < 0) throw new Error('版本行未更新：' + item[0]);
        fs.writeFileSync(p, next, 'utf8');
    });

    const postFail = verify();
    if (postFail) throw new Error('写入版本号后自检未通过，请检查（快照仍会生成以便排查）');
    snapshot(tag, note);
    console.log('\n版本 ' + tag + ' 已就绪（' + time + '）。');
    console.log('接下来由你本人：应用卡 → 分享 → 体验版「更新」→ 彻底杀掉微信 → 重扫确认「' + stamp + '」。');
}

// ---------- rollback ----------
function rollback(tag) {
    const dir = path.join(VERSIONS, tag);
    const metaFile = path.join(dir, '_snapshot.json');
    if (!fs.existsSync(metaFile)) {
        throw new Error('版本 ' + tag + ' 没有本地源码快照。可用快照：'
            + readManifest().snapshots.map(function (s) { return s.tag; }).join(', '));
    }
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const backupTag = 'pre-' + tag + '-' + compactTime();
    snapshot(backupTag, '回退到 ' + tag + ' 之前自动保存的当前代码', true);
    console.log('已自动备份当前代码 → ' + backupTag);

    let restored = 0;
    meta.files.forEach(function (f) {
        const src = path.join(dir, f.path);
        if (!fs.existsSync(src)) throw new Error('快照缺文件：' + f.path);
        copyFile(src, path.join(ROOT, f.path));
        restored += 1;
    });
    console.log('已恢复 ' + restored + ' 个源码文件 → 版本 ' + tag + '（' + meta.at + '）');

    const m = readManifest();
    m.current = tag;
    m.history.push({ tag: tag, at: nowStr(), note: '从快照回退；回退前状态见 ' + backupTag, status: '已回退', snapshot: tag });
    writeManifest(m);

    const fail = verify();
    console.log('提示：回退只覆盖快照里有的文件，不会删除之后新增的源码文件；不用的新页面可在 app.json 里去掉注册。');
    console.log('回退后仍需你本人到分享面板点体验版「更新」，手机才会换版本。');
    return fail;
}

// ---------- list / status ----------
function list() {
    const m = readManifest();
    console.log('版本历史（当前工作区：' + (m.current || '未标记') + '）');
    m.history.forEach(function (h) {
        console.log('  ' + h.tag.padEnd(22) + h.at.padEnd(18) + (h.snapshot ? '[有快照] ' : '[无快照] ')
            + h.status.padEnd(8) + h.note);
    });
    console.log('\n可回退快照：' + (m.snapshots.length ? m.snapshots.length + ' 个' : '暂无'));
    m.snapshots.forEach(function (s) {
        console.log('  ' + s.tag.padEnd(30) + s.at.padEnd(18) + s.files.length + ' 文件 / '
            + (s.bytes / 1024).toFixed(1) + ' KB  ' + s.note);
    });
    console.log('\n' + m.note);
}

function status() {
    const b = readBuild();
    const m = readManifest();
    console.log('构建标记      ' + b.tag + ' · ' + b.time);
    console.log('版本清单当前  ' + (m.current || '未标记'));
    console.log('可回退快照    ' + m.snapshots.length + ' 个'
        + (m.snapshots.length ? '（最近：' + m.snapshots[0].tag + '）' : ''));
    console.log('源码文件      ' + sourceFiles().length + ' 个');
    console.log('上传代码包    ' + (packBytes() / 1024).toFixed(1) + ' KB / 2048 KB');
    console.log('排除规则      ' + ignoreRules().length + ' 条');
}

function help() {
    console.log('用法：node tools/version.js <命令> [参数]\n');
    console.log('  verify                 发布前自检（语法 / 四件套 / 事件 / 红线词 / 版本行 / 包体积）');
    console.log('  list                   版本历史与可回退快照');
    console.log('  status                 当前构建标记、包体积、快照数量');
    console.log('  release B12 "改动说明"  统一版本标记 + 自检 + 生成快照（推荐）');
    console.log('  snapshot B12 "说明"     只生成源码快照，不改版本号');
    console.log('  rollback B11            回退到指定快照（自动先备份当前代码）');
    console.log('\n详见 docs/RELEASE.md。');
}

function main() {
    const args = process.argv.slice(2);
    const cmd = args[0] || 'help';
    try {
        if (cmd === 'verify') process.exitCode = verify() ? 1 : 0;
        else if (cmd === 'list') list();
        else if (cmd === 'status') status();
        else if (cmd === 'snapshot') snapshot(args[1], args.slice(2).join(' '));
        else if (cmd === 'release') release(args[1], args.slice(2).join(' '));
        else if (cmd === 'rollback') process.exitCode = rollback(args[1]) ? 1 : 0;
        else if (cmd === 'help' || cmd === '--help' || cmd === '-h') help();
        else { console.log('未知命令：' + cmd); help(); process.exitCode = 1; }
    } catch (e) {
        console.error('错误：' + e.message);
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = {
    verify: verify,
    snapshot: snapshot,
    rollback: rollback,
    release: release,
    list: list,
    status: status,
    sourceFiles: sourceFiles,
    packFiles: packFiles,
    packBytes: packBytes,
    readManifest: readManifest,
    readBuild: readBuild,
    ROOT: ROOT,
    VERSIONS: VERSIONS,
};
