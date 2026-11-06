/* 离线回归：版本管理（在临时副本上演练，不改动真实工程） */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass += 1; console.log('  PASS ' + name); }
    else { fail += 1; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, actual, expected) {
    ok(name, actual === expected, '实际 ' + JSON.stringify(actual) + ' / 期望 ' + JSON.stringify(expected));
}
function sha(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function copy(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}
function silent(fn) {
    const original = console.log;
    console.log = function () {};
    try { return fn(); } finally { console.log = original; }
}

const real = require(path.join(ROOT, 'tools', 'version.js'));
const tmpRoot = path.join(os.tmpdir(), 'bill-version-test-' + process.pid);
fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.mkdirSync(tmpRoot, { recursive: true });

real.sourceFiles().forEach(function (rel) {
    copy(path.join(ROOT, rel), path.join(tmpRoot, rel));
});
copy(path.join(ROOT, 'tools', 'version.js'), path.join(tmpRoot, 'tools', 'version.js'));
// 造几个「不该进包」的文件，验证排除规则确实生效
copy(path.join(ROOT, 'project.config.json'), path.join(tmpRoot, 'docs', 'dummy.md'));
fs.writeFileSync(path.join(tmpRoot, 'base.png'), Buffer.alloc(120 * 1024), 'binary');

const v = require(path.join(tmpRoot, 'tools', 'version.js'));

console.log('\n[1] 发布前自检');
eq('副本自检 0 失败', silent(function () { return v.verify(); }), 0);
ok('上传包远小于 2MB', v.packBytes() < 2 * 1024 * 1024, (v.packBytes() / 1024).toFixed(1) + ' KB');
ok('源码清单不含 tools/versions/docs', v.sourceFiles().every(function (f) {
    return !/^(tools|versions|docs)\//.test(f);
}));
ok('base.png 未进打包清单', v.packFiles().indexOf('base.png') < 0);
ok('docs/dummy.md 未进打包清单', v.packFiles().indexOf('docs/dummy.md') < 0);
ok('密钥类文件未进打包清单', !v.packFiles().some(function (f) { return /\.(key|pem)$/i.test(f); }));

console.log('\n[2] 源码快照');
const meta = silent(function () { return v.snapshot('TEST-A', '初始基线'); });
ok('快照目录已生成', fs.existsSync(path.join(tmpRoot, 'versions', 'TEST-A', '_snapshot.json')));
ok('快照含 app.json', fs.existsSync(path.join(tmpRoot, 'versions', 'TEST-A', 'app.json')));
eq('快照文件数 = 源码文件数', meta.files.length, real.sourceFiles().length);
ok('快照逐文件 sha256 正确', meta.files.every(function (f) {
    return f.sha256 === sha(path.join(tmpRoot, f.path));
}));
eq('manifest.current', v.readManifest().current, 'TEST-A');
ok('历史里有 TEST-A', v.readManifest().history.some(function (h) { return h.tag === 'TEST-A'; }));

console.log('\n[3] 回退（含自动备份）');
const target = path.join(tmpRoot, 'utils', 'format.js');
const before = sha(target);
fs.appendFileSync(target, '\n// 临时改动\n', 'utf8');
ok('改动后 sha 已变化', sha(target) !== before);
const failAfterRollback = silent(function () { return v.rollback('TEST-A'); });
eq('回退后自检 0 失败', failAfterRollback, 0);
eq('文件已恢复', sha(target), before);
const backups = v.readManifest().snapshots.filter(function (s) { return s.tag.indexOf('pre-TEST-A-') === 0; });
ok('回退前自动备份存在', backups.length === 1, backups.map(function (b) { return b.tag; }).join(','));
ok('备份里保存的是改动后的版本', fs.existsSync(path.join(tmpRoot, 'versions', backups[0].tag, 'utils', 'format.js')));
eq('manifest.current 指向回退目标', v.readManifest().current, 'TEST-A');

console.log('\n[4] release 统一版本标记');
silent(function () { v.release('TEST-B', '测试发布流程'); });
const buildText = fs.readFileSync(path.join(tmpRoot, 'utils', 'build.js'), 'utf8');
const tag = (buildText.match(/tag:\s*'([^']+)'/) || [])[1];
const time = (buildText.match(/time:\s*'([^']+)'/) || [])[1];
eq('build.js tag', tag, 'TEST-B');
ok('build.js time 非空', !!time);
const stamp = '构建 TEST-B · ' + time;
ok('首页版本行同步', fs.readFileSync(path.join(tmpRoot, 'pages/index/index.wxml'), 'utf8').indexOf(stamp) >= 0);
ok('上传页版本行同步', fs.readFileSync(path.join(tmpRoot, 'pages/upload/upload.wxml'), 'utf8').indexOf(stamp) >= 0);
ok('我的页版本行同步', fs.readFileSync(path.join(tmpRoot, 'pages/mine/mine.wxml'), 'utf8').indexOf('构建 TEST-B') >= 0);
ok('release 生成快照', fs.existsSync(path.join(tmpRoot, 'versions', 'TEST-B', '_snapshot.json')));
eq('manifest.current = TEST-B', v.readManifest().current, 'TEST-B');
eq('release 后自检 0 失败', silent(function () { return v.verify(); }), 0);

console.log('\n[5] 参数与边界');
let rejected = false;
try { v.snapshot('../evil', '越界'); } catch (e) { rejected = true; }
ok('拒绝越界版本号', rejected);
let duplicate = false;
try { v.snapshot('TEST-A', '重复'); } catch (e) { duplicate = true; }
ok('拒绝覆盖已有快照', duplicate);
let noSnapshot = false;
try { v.rollback('B4'); } catch (e) { noSnapshot = /没有本地源码快照/.test(e.message); }
ok('无快照版本拒绝本地回退并给出说明', noSnapshot);
silent(function () { v.list(); v.status(); });
ok('list / status 不抛异常', true);

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('\n结果：' + pass + ' 项通过 / ' + fail + ' 项失败');
process.exitCode = fail ? 1 : 0;
