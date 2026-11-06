// 首页「高频检索标签」：统计每条记录的关键字（按空格分词）出现次数，按频率降序展示。
// 数据源仍然是记录里的 keyword 字符串，不额外存一份标签表，改记录后自动更新。
// 纯函数，便于离线回归。

var tagKit = require('./tag-kit');

var MAX_CHIPS = 12;
var MAX_WORD_LENGTH = 16; // 旧记录里可能有长句或乱码，不让它占满标签栏

function rank(records, limit) {
    var counts = {};
    var latest = {};
    (records || []).forEach(function (record) {
        var createdAt = Number(record && record.createdAt) || 0;
        tagKit.words(record && record.keyword).forEach(function (word) {
            if (!word || word.length > MAX_WORD_LENGTH) return;
            counts[word] = (counts[word] || 0) + 1;
            if (createdAt > (latest[word] || 0)) latest[word] = createdAt;
        });
    });
    var list = Object.keys(counts).map(function (word) {
        return {
            key: 'tag:' + word,
            tag: word,
            label: word.length > 8 ? word.slice(0, 8) + '…' : word,
            count: counts[word],
            latest: latest[word] || 0,
        };
    });
    list.sort(function (a, b) {
        if (b.count !== a.count) return b.count - a.count;
        if (b.latest !== a.latest) return b.latest - a.latest;
        return a.tag < b.tag ? -1 : (a.tag > b.tag ? 1 : 0);
    });
    return list.slice(0, limit || MAX_CHIPS);
}

// 点标签按「完整词」精确筛选，不做子串匹配，避免「CT」命中「CT室」以外的词。
function matches(record, tag) {
    if (!tag) return true;
    return tagKit.words(record && record.keyword).indexOf(tag) >= 0;
}

module.exports = {
    rank: rank,
    matches: matches,
    MAX_CHIPS: MAX_CHIPS,
    MAX_WORD_LENGTH: MAX_WORD_LENGTH,
};
