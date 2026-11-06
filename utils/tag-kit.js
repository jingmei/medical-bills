// 标签 = 「关键字」输入框按空格切出的词。只维护一份数据（keyword 字符串），
// 标签条是它的可视化视图，因此用户可以：
//   1) 直接在关键字里打字，标签条实时跟着变；
//   2) 点标签改字、点 × 删除、点 ＋ 手动新增，写回同一个关键字字符串。
// 所有函数都是纯函数，不碰页面与存储，便于单独测试。

var MAX_TAGS = 8;
var TAG_MAX_LEN = 12;
var KEYWORD_MAX = 80;

function clean(text) {
    return String(text === null || text === undefined ? '' : text)
        .replace(/\s+/g, ' ')
        .trim();
}

// 空格是标签分隔符，所以单个标签内部不允许空白
function normalizeTag(text) {
    return clean(text).replace(/\s+/g, '').slice(0, TAG_MAX_LEN);
}

function words(keyword) {
    var seen = {};
    var list = [];
    clean(keyword).split(/\s+/).forEach(function (word) {
        if (!word || seen[word]) return;
        seen[word] = true;
        list.push(word);
    });
    return list;
}

function joinWords(list) {
    var seen = {};
    var out = [];
    list.forEach(function (word) {
        if (!word || seen[word]) return;
        seen[word] = true;
        out.push(word);
    });
    return out.join(' ').slice(0, KEYWORD_MAX);
}

// 手输标签的校验：非空、长度、重复、数量上限
function validate(value, list, editingIndex) {
    var tag = normalizeTag(value);
    if (!tag) return { ok: false, message: '请先输入标签文字' };
    for (var i = 0; i < list.length; i += 1) {
        if (i !== editingIndex && list[i] === tag) {
            return { ok: false, message: '这个标签已经有了' };
        }
    }
    if (editingIndex < 0 && list.length >= MAX_TAGS) {
        return { ok: false, message: '最多 ' + MAX_TAGS + ' 个标签' };
    }
    return { ok: true, value: tag };
}

// 返回新的 keyword 字符串；失败时给出可读原因，不改动任何数据
function add(keyword, value) {
    var list = words(keyword);
    var check = validate(value, list, -1);
    if (!check.ok) return check;
    list.push(check.value);
    return { ok: true, keyword: joinWords(list), value: check.value };
}

function edit(keyword, oldTag, value) {
    var list = words(keyword);
    var index = list.indexOf(oldTag);
    if (index < 0) return { ok: false, message: '这个标签已不存在，请刷新后重试' };
    var check = validate(value, list, index);
    if (!check.ok) return check;
    list[index] = check.value;
    return { ok: true, keyword: joinWords(list), value: check.value };
}

function remove(keyword, tag) {
    var list = words(keyword).filter(function (word) { return word !== tag; });
    return { ok: true, keyword: joinWords(list) };
}

module.exports = {
    words: words,
    normalizeTag: normalizeTag,
    validate: validate,
    add: add,
    edit: edit,
    remove: remove,
    MAX_TAGS: MAX_TAGS,
    TAG_MAX_LEN: TAG_MAX_LEN,
    KEYWORD_MAX: KEYWORD_MAX,
};
