// 标签词库与全局管理（借鉴 Stack Overflow 的标签机制，但全部数据仍只存本机）。
//
// 借鉴的几点：
//   1) 输入标签时按「出现频次」自动补全已有标签，优先复用而不是制造同义词；
//   2) 有完整的标签词库视图：搜索、按热度 / 名称 / 最近使用排序、显示条数；
//   3) 重新打标签：改名 / 合并同义词 / 删除，改动落到所有相关记录；
//   4) 收藏（置顶）与忽略标签，影响首页标签栏的显示。
//
// 标签本身不单独存表，永远是记录里 keyword 字符串按空格分出的词。
// 本文件里除了偏好读写，其余都是纯函数，便于离线回归。

var tagKit = require('./tag-kit');

var PREFS_KEY = 'medical-bills.tagPrefs.v1';
var MAX_SUGGESTIONS = 8;
var MAX_MERGE_CANDIDATES = 12;
var KEYWORD_MAX = tagKit.KEYWORD_MAX;

// SO 建议标签避免标点；中文场景放宽连字符 / 下划线 / 点（日期标签会用到）
var BAD_CHARS = /[,;:!?。，、；：！？()（）\[\]{}《》<>"'`~@#$%^&*+=|\\/]/;

function normalizeName(value) {
    return tagKit.normalizeTag(value);
}

function validateName(value, options) {
    var opts = options || {};
    var name = normalizeName(value);
    if (!name) return { ok: false, message: '请输入标签文字' };
    if (BAD_CHARS.test(name)) return { ok: false, message: '标签里不要带标点符号' };
    if (name.length > tagKit.TAG_MAX_LEN) {
        return { ok: false, message: '最多 ' + tagKit.TAG_MAX_LEN + ' 个字' };
    }
    if (opts.original && name === opts.original) {
        return { ok: false, message: '新名称和原来一样' };
    }
    if (opts.taken && opts.taken.indexOf(name) >= 0) {
        return { ok: false, message: '已有同名标签，请改用「合并」' };
    }
    return { ok: true, value: name };
}

function emptyPrefs() {
    return { pinned: {}, hidden: {} };
}

// 偏好存本机；读不到或格式坏了都按空偏好处理，绝不抛错
function readPrefs() {
    var prefs = emptyPrefs();
    try {
        var value = wx.getStorageSync(PREFS_KEY);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return prefs;
        ['pinned', 'hidden'].forEach(function (key) {
            var map = value[key];
            if (!map || typeof map !== 'object' || Array.isArray(map)) return;
            Object.keys(map).forEach(function (name) {
                if (map[name] && typeof name === 'string' && name) prefs[key][name] = true;
            });
        });
    } catch (e) { /* 存储不可用时按空偏好展示 */ }
    return prefs;
}

function writePrefs(prefs) {
    try {
        wx.setStorageSync(PREFS_KEY, {
            pinned: prefs.pinned || {},
            hidden: prefs.hidden || {},
        });
        return true;
    } catch (e) { return false; }
}

function movePref(prefs, from, to) {
    ['pinned', 'hidden'].forEach(function (key) {
        if (prefs[key][from]) {
            delete prefs[key][from];
            if (to) prefs[key][to] = true;
        }
    });
    return prefs;
}

function dropPref(prefs, name) {
    delete prefs.pinned[name];
    delete prefs.hidden[name];
    return prefs;
}

function joinWords(words) {
    var seen = {};
    var out = [];
    words.forEach(function (word) {
        if (!word || seen[word]) return;
        seen[word] = true;
        out.push(word);
    });
    return out.join(' ').slice(0, KEYWORD_MAX);
}

// 汇总词库：每个标签出现几次、最近在哪条记录里用过
function collect(records, prefs) {
    var map = {};
    (records || []).forEach(function (record) {
        var at = Number(record && record.createdAt) || 0;
        tagKit.words(record && record.keyword).forEach(function (word) {
            if (!map[word]) map[word] = { tag: word, count: 0, latest: 0 };
            map[word].count += 1;
            if (at > map[word].latest) map[word].latest = at;
        });
    });
    var p = prefs || emptyPrefs();
    return Object.keys(map).map(function (tag) {
        return {
            tag: tag,
            count: map[tag].count,
            latest: map[tag].latest,
            pinned: !!p.pinned[tag],
            hidden: !!p.hidden[tag],
        };
    });
}

function sortTags(list, mode) {
    var arr = list.slice();
    arr.sort(function (a, b) {
        if (mode === 'name') {
            if (a.tag !== b.tag) return a.tag < b.tag ? -1 : 1;
            return b.count - a.count;
        }
        if (mode === 'recent') {
            if (b.latest !== a.latest) return b.latest - a.latest;
            if (b.count !== a.count) return b.count - a.count;
            return a.tag < b.tag ? -1 : 1;
        }
        // popular：次数优先，其次最近使用（与 SO 标签页按问题数排序一致）
        if (b.count !== a.count) return b.count - a.count;
        if (b.latest !== a.latest) return b.latest - a.latest;
        return a.tag < b.tag ? -1 : 1;
    });
    return arr;
}

function filterTags(list, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return list.slice();
    return list.filter(function (item) {
        return item.tag.toLowerCase().indexOf(q) >= 0;
    });
}

// SO 的 tag completer：输入时列出已有标签，按频次排序；以输入开头的排前面。
// 空输入时给出最常用标签，方便直接点选复用。
function suggestions(records, query, limit, options) {
    var opts = options || {};
    var exclude = {};
    (opts.exclude || []).forEach(function (tag) { exclude[tag] = true; });
    var q = String(query || '').trim().toLowerCase();
    var list = collect(records, opts.prefs || emptyPrefs()).filter(function (item) {
        if (exclude[item.tag] || item.hidden) return false;
        return !q || item.tag.toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (a, b) {
        if (q) {
            var aStart = a.tag.toLowerCase().indexOf(q) === 0;
            var bStart = b.tag.toLowerCase().indexOf(q) === 0;
            if (aStart !== bStart) return aStart ? -1 : 1;
        }
        if (b.count !== a.count) return b.count - a.count;
        if (b.latest !== a.latest) return b.latest - a.latest;
        return a.tag < b.tag ? -1 : 1;
    });
    return list.slice(0, limit || MAX_SUGGESTIONS);
}

function mergeCandidates(records, fromTag, query, limit) {
    var q = String(query || '').trim().toLowerCase();
    return collect(records, emptyPrefs())
        .filter(function (item) {
            return item.tag !== fromTag && (!q || item.tag.toLowerCase().indexOf(q) >= 0);
        })
        .sort(function (a, b) { return b.count - a.count; })
        .slice(0, limit || MAX_MERGE_CANDIDATES);
}

// 以下函数只返回「需要写回的记录补丁」，不碰存储，由页面一次性提交，便于测试与回滚。
function rewrite(records, transform) {
    var patches = [];
    (records || []).forEach(function (record) {
        var before = record && record.keyword ? record.keyword : '';
        var words = tagKit.words(before);
        var next = transform(words.slice(), record);
        if (!next) return; // 未命中，保持原字符串（也不顺手改空格）
        var keyword = joinWords(next);
        if (keyword !== before) patches.push({ id: record.id, keyword: keyword });
    });
    return patches;
}

function renamePatches(records, from, to) {
    return rewrite(records, function (words) {
        var i = words.indexOf(from);
        if (i < 0) return null;
        words[i] = to;
        return words;
    });
}

function mergePatches(records, from, to) {
    return renamePatches(records, from, to); // joinWords 去重，天然完成合并
}

function removePatches(records, tag) {
    return rewrite(records, function (words) {
        if (words.indexOf(tag) < 0) return null;
        return words.filter(function (word) { return word !== tag; });
    });
}

function addPatches(records, tag, ids) {
    var wanted = {};
    (ids || []).forEach(function (id) { wanted[id] = true; });
    return rewrite(records, function (words, record) {
        if (!wanted[record.id] || words.indexOf(tag) >= 0) return null;
        words.push(tag);
        return words;
    });
}

module.exports = {
    PREFS_KEY: PREFS_KEY,
    MAX_SUGGESTIONS: MAX_SUGGESTIONS,
    KEYWORD_MAX: KEYWORD_MAX,
    normalizeName: normalizeName,
    validateName: validateName,
    readPrefs: readPrefs,
    writePrefs: writePrefs,
    movePref: movePref,
    dropPref: dropPref,
    collect: collect,
    sortTags: sortTags,
    filterTags: filterTags,
    suggestions: suggestions,
    mergeCandidates: mergeCandidates,
    renamePatches: renamePatches,
    mergePatches: mergePatches,
    removePatches: removePatches,
    addPatches: addPatches,
};
