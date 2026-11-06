// 单据类型：固定分类 key + 用户可自定义的显示名称。
// 记录里只存 key，改名称不会影响已有记录；旧版记录存的是中文标签，这里做兼容映射。

const STORAGE_KEY = 'medical-bills.typeLabels.v1';
const MAX_LABEL_LENGTH = 8;

const TYPE_KEYS = ['body', 'list', 'invoice', 'report', 'other'];

const DEFAULTS = {
    body: '身体数据',
    list: '我的清单',
    invoice: '发票',
    report: '检查报告',
    other: '其他',
};

// 旧版 docType 直接存中文显示名，映射到固定分类
const LEGACY = {
    '挂号单': 'body',
    '处方': 'list',
    '发票': 'invoice',
    '检查报告': 'report',
    '其他': 'other',
};

let cachedLabels = null;

function cleanLabel(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.replace(/[\r\n\t]/g, '').slice(0, MAX_LABEL_LENGTH);
}

function readCustom() {
    try {
        const value = wx.getStorageSync(STORAGE_KEY);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const result = {};
        TYPE_KEYS.forEach(function (key) {
            const label = cleanLabel(value[key]);
            if (label) result[key] = label;
        });
        return result;
    } catch (error) {
        return {};
    }
}

function getLabels() {
    if (!cachedLabels) {
        const custom = readCustom();
        const labels = {};
        TYPE_KEYS.forEach(function (key) {
            labels[key] = custom[key] || DEFAULTS[key];
        });
        cachedLabels = labels;
    }
    return Object.assign({}, cachedLabels);
}

function getItems() {
    const labels = getLabels();
    return TYPE_KEYS.map(function (key) {
        return { key: key, defaultLabel: DEFAULTS[key], label: labels[key] };
    });
}

function normalizeKey(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (TYPE_KEYS.indexOf(text) >= 0) return text;
    if (Object.prototype.hasOwnProperty.call(LEGACY, text)) return LEGACY[text];
    // 兼容「改过名称之后，旧记录里存的是当时的显示名」
    const labels = getLabels();
    const keys = Object.keys(labels);
    for (let i = 0; i < keys.length; i += 1) {
        if (labels[keys[i]] === text) return keys[i];
    }
    return 'other';
}

function labelOf(value) {
    return getLabels()[normalizeKey(value)] || DEFAULTS.other;
}

function saveLabels(map) {
    const source = map && typeof map === 'object' ? map : {};
    const next = {};
    const seen = {};
    let message = '';
    TYPE_KEYS.forEach(function (key) {
        if (message) return;
        const label = cleanLabel(source[key]);
        if (!label) {
            message = '名称不能为空，最多 ' + MAX_LABEL_LENGTH + ' 个字';
            return;
        }
        if (seen[label]) {
            message = '名称不能重复：' + label;
            return;
        }
        seen[label] = true;
        next[key] = label;
    });
    if (message) return { ok: false, message: message };
    try {
        wx.setStorageSync(STORAGE_KEY, next);
        cachedLabels = null;
        return { ok: true, labels: next };
    } catch (error) {
        return { ok: false, message: '保存失败，请重试' };
    }
}

function resetLabels() {
    try {
        wx.removeStorageSync(STORAGE_KEY);
    } catch (error) {
        // 存储不可用时按默认名称展示即可
    }
    cachedLabels = null;
}

module.exports = {
    TYPE_KEYS: TYPE_KEYS,
    DEFAULTS: DEFAULTS,
    MAX_LABEL_LENGTH: MAX_LABEL_LENGTH,
    getLabels: getLabels,
    getItems: getItems,
    normalizeKey: normalizeKey,
    labelOf: labelOf,
    saveLabels: saveLabels,
    resetLabels: resetLabels,
};
