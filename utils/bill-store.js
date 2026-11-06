// 个人单据记录的本机数据层。
//
// 对外契约与官方 list-crud 骨架 / 云数据 createTableAccess 一致：
//   list / create / update / remove 均返回 { data, error }，且永不 reject。
// 这样页面只依赖这四个方法；将来接云端时替换本文件即可，页面无需重写。
// 额外的 get / stats / clear 是本地版为「详情 / 统计 / 清空」提供的扩展。
//
// 字段说明：keyword 是用户自定义关键字。旧版记录里叫 hospital，读取时会兼容映射。
// docType 存的是固定分类 key（见 utils/type-store.js），显示名称由用户自行设定。

const fileStore = require('./file-store');

const STORAGE_KEY = 'medical-bills.records.v1';
const MAX_IMAGES = 9;
// 与 utils/tag-kit.js 的 KEYWORD_MAX 保持一致：最多 8 个标签、每个最多 12 字。
// 旧版这里写 40，会把第 4 个之后的标签截掉，标签管理页批量写入也会丢词。
const KEYWORD_MAX = 80;
let idCounter = 0;

const ERRORS = {
    INVALID_ID: { code: 'INVALID_ID', message: '缺少记录编号' },
    INVALID_DATE: { code: 'INVALID_DATE', message: '请选择拍照日期' },
    NO_IMAGE: { code: 'NO_IMAGE', message: '请至少添加一张单据照片' },
    INVALID_PAYLOAD: { code: 'INVALID_PAYLOAD', message: '没有可保存的内容' },
    NOT_FOUND: { code: 'NOT_FOUND_OR_FORBIDDEN', message: '这条记录可能已被删除' },
};

function safely(executor) {
    return Promise.resolve()
        .then(executor)
        .catch(function (error) {
            return {
                data: null,
                error: {
                    code: 'CLIENT_EXCEPTION',
                    message: (error && error.message) || '本机数据读写失败，请重试',
                },
            };
        });
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidRecord(record) {
    return isPlainObject(record)
        && typeof record.id === 'string'
        && typeof record.visitDate === 'string'
        && Array.isArray(record.images);
}

function normalizeItem(item) {
    if (!isPlainObject(item)) return null;
    const tags = Array.isArray(item.tags)
        ? item.tags.filter(function (t) { return typeof t === 'string' && t !== ''; }).slice(0, 8)
        : [];
    return {
        photoNo: Number(item.photoNo) || 0,
        tags: tags,
        note: typeof item.note === 'string' ? item.note : '',
    };
}

function normalize(record) {
    const images = record.images
        .filter(function (image) { return isPlainObject(image) && typeof image.path === 'string'; })
        .map(function (image) {
            return {
                path: image.path,
                size: Number(image.size) || 0,
                addedAt: Number(image.addedAt) || 0,
            };
        });
    const keyword = typeof record.keyword === 'string'
        ? record.keyword
        : (typeof record.hospital === 'string' ? record.hospital : '');
    // 每张照片的标签/备注快照：旧记录没有 items 时返回空数组（详情页按图片兜底展示）。
    let items = [];
    if (Array.isArray(record.items)) {
        items = record.items.map(normalizeItem).filter(function (it) { return it !== null; });
    }
    const batchId = typeof record.batchId === 'string' ? record.batchId : '';
    return {
        id: record.id,
        visitDate: record.visitDate,
        keyword: keyword,
        docType: typeof record.docType === 'string' ? record.docType : 'other',
        note: typeof record.note === 'string' ? record.note : '',
        images: images,
        items: items,
        batchId: batchId,
        createdAt: Number(record.createdAt) || 0,
        updatedAt: Number(record.updatedAt) || 0,
    };
}

function readAll() {
    const value = wx.getStorageSync(STORAGE_KEY);
    if (!Array.isArray(value)) return [];
    return value.filter(isValidRecord).map(normalize).sort(function (a, b) {
        return b.createdAt - a.createdAt;
    });
}

function writeAll(records) {
    wx.setStorageSync(STORAGE_KEY, records);
}

function findIndexById(records, id) {
    for (let i = 0; i < records.length; i += 1) {
        if (records[i].id === String(id)) return i;
    }
    return -1;
}

function isInvalidId(id) {
    return typeof id !== 'string' || id.trim() === '';
}

function nextId() {
    idCounter = (idCounter + 1) % 1000000;
    return 'r-' + Date.now() + '-' + idCounter;
}

function cleanText(value, maxLength) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.slice(0, maxLength);
}

const billStore = {
    list() {
        return safely(function () {
            return { data: readAll(), error: null };
        });
    },

    get(id) {
        if (isInvalidId(id)) {
            return Promise.resolve({ data: null, error: ERRORS.INVALID_ID });
        }
        return safely(function () {
            const records = readAll();
            const index = findIndexById(records, id);
            return { data: index >= 0 ? records[index] : null, error: null };
        });
    },

    create(payload) {
        return safely(function () {
            const source = isPlainObject(payload) ? payload : {};
            const visitDate = cleanText(source.visitDate, 10);
            const images = (Array.isArray(source.images) ? source.images : [])
                .filter(function (image) { return isPlainObject(image) && typeof image.path === 'string'; })
                .slice(0, MAX_IMAGES)
                .map(normalizeImage);

            if (!visitDate) return { data: null, error: ERRORS.INVALID_DATE };
            if (images.length === 0) return { data: null, error: ERRORS.NO_IMAGE };

            const now = Date.now();
            const itemList = Array.isArray(source.items)
                ? source.items.map(normalizeItem).filter(function (it) { return it !== null; })
                : [];
            const record = {
                id: nextId(),
                visitDate: visitDate,
                keyword: cleanText(source.keyword, KEYWORD_MAX) || cleanText(source.hospital, KEYWORD_MAX),
                docType: cleanText(source.docType, 12) || 'other',
                note: cleanText(source.note, 200),
                images: images,
                items: itemList,
                batchId: typeof source.batchId === 'string' ? source.batchId : '',
                createdAt: now,
                updatedAt: now,
            };
            const records = readAll();
            records.unshift(record);
            writeAll(records);
            return { data: record, error: null };
        });
    },

    update(id, patch) {
        if (isInvalidId(id)) {
            return Promise.resolve({ data: null, error: ERRORS.INVALID_ID });
        }
        return safely(function () {
            const source = isPlainObject(patch) ? patch : {};
            const fields = ['visitDate', 'keyword', 'docType', 'note', 'items'];
            const hasField = fields.some(function (key) {
                return Object.prototype.hasOwnProperty.call(source, key);
            });
            if (!hasField) return { data: null, error: ERRORS.INVALID_PAYLOAD };

            const records = readAll();
            const index = findIndexById(records, id);
            if (index < 0) return { data: null, error: ERRORS.NOT_FOUND };

            const current = records[index];
            // 单张照片的标签 / 备注：保存后允许在详情页单独补改，
            // 解决「某张没识别就保存、事后无法再编辑」的问题。
            let items = current.items;
            if (Object.prototype.hasOwnProperty.call(source, 'items')) {
                items = Array.isArray(source.items)
                    ? source.items.map(normalizeItem).filter(function (it) { return it !== null; })
                    : [];
            }
            const next = {
                id: current.id,
                visitDate: Object.prototype.hasOwnProperty.call(source, 'visitDate')
                    ? cleanText(source.visitDate, 10) : current.visitDate,
                keyword: Object.prototype.hasOwnProperty.call(source, 'keyword')
                    ? cleanText(source.keyword, KEYWORD_MAX) : current.keyword,
                docType: Object.prototype.hasOwnProperty.call(source, 'docType')
                    ? cleanText(source.docType, 12) : current.docType,
                note: Object.prototype.hasOwnProperty.call(source, 'note')
                    ? cleanText(source.note, 200) : current.note,
                items: items,
                images: current.images,
                createdAt: current.createdAt,
                updatedAt: Date.now(),
            };
            if (!next.visitDate) return { data: null, error: ERRORS.INVALID_DATE };
            records[index] = next;
            writeAll(records);
            return { data: next, error: null };
        });
    },

    // 标签管理页专用：一次读、一次写，把多条记录的 keyword 改动原子提交，
    // 避免逐条 update 中途失败留下「一半改了、一半没改」的数据。
    applyKeywordPatches(patches) {
        return safely(function () {
            if (!Array.isArray(patches) || patches.length === 0) {
                return { data: { updated: 0 }, error: null };
            }
            const map = {};
            patches.forEach(function (patch) {
                if (!patch || typeof patch.id !== 'string' || typeof patch.keyword !== 'string') return;
                map[patch.id] = patch.keyword.trim().slice(0, KEYWORD_MAX);
            });
            const records = readAll();
            let updated = 0;
            records.forEach(function (record) {
                if (Object.prototype.hasOwnProperty.call(map, record.id)) {
                    record.keyword = map[record.id];
                    updated += 1;
                }
            });
            if (updated) writeAll(records);
            return { data: { updated: updated }, error: null };
        });
    },

    remove(id) {
        if (isInvalidId(id)) {
            return Promise.resolve({ data: null, error: ERRORS.INVALID_ID });
        }
        return safely(function () {
            const records = readAll();
            const index = findIndexById(records, id);
            if (index < 0) return { data: null, error: ERRORS.NOT_FOUND };
            const target = records[index];
            records.splice(index, 1);
            writeAll(records);
            const paths = target.images.map(function (image) { return image.path; });
            return fileStore.removeFiles(paths).then(function (removedFiles) {
                return { data: { removed: 1, removedFiles: removedFiles }, error: null };
            });
        });
    },

    clear() {
        return safely(function () {
            const records = readAll();
            writeAll([]);
            return fileStore.clearAllFiles().then(function (filesCleared) {
                return {
                    data: { removed: records.length, filesCleared: filesCleared },
                    error: null,
                };
            });
        });
    },

    stats() {
        return safely(function () {
            const records = readAll();
            let images = 0;
            let bytes = 0;
            records.forEach(function (record) {
                images += record.images.length;
                record.images.forEach(function (image) { bytes += image.size; });
            });
            const dates = records.map(function (r) { return r.visitDate; })
                .filter(function (d) { return d !== ''; })
                .sort();
            return {
                data: {
                    records: records.length,
                    images: images,
                    bytes: bytes,
                    earliest: dates.length ? dates[0] : '',
                    latest: dates.length ? dates[dates.length - 1] : '',
                },
                error: null,
            };
        });
    },
};

function normalizeImage(image) {
    return {
        path: image.path,
        size: Number(image.size) || 0,
        addedAt: Number(image.addedAt) || Date.now(),
    };
}

module.exports = {
    billStore,
    STORAGE_KEY,
    MAX_IMAGES,
    KEYWORD_MAX,
};
