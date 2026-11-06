// 本机备份 / 恢复。
//
// 设计前提：小程序不联网、不上传服务器、不引入第三方 SDK。
// 备份产物是一段 JSON 文本，由用户自己复制 / 保存 / 粘回来；含照片时把照片
// 以 base64 写进文本（FileSystemManager.readFile 的 encoding:'base64'）。
// 用户主动「分享到自己的聊天」属于微信客户端行为，本工具不发起网络请求。
//
// 安全性：恢复时先把所有照片写到私有目录，全部成功之后才写记录。
// 任何一步失败都只删除本次新写的照片，已有记录与照片一律不动。

const storeModule = require('./bill-store');
const billStore = storeModule.billStore;
const STORAGE_KEY = storeModule.STORAGE_KEY;
const fileStore = require('./file-store');
const typeStore = require('./type-store');

const APP_ID = 'my-body-bills';
const FORMAT_VERSION = 1;
const MAX_RECORDS = 2000;
const MAX_IMAGES = 9;

function pad(value) {
    return value < 10 ? '0' + value : String(value);
}

function timeText(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function baseName(path) {
    const raw = String(path || '').split('/').pop().split('\\').pop();
    const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, '');
    return safe.slice(-60) || 'photo.jpg';
}

function cleanText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// ---------- 纯逻辑：校验 / 统计 / 合并（可单独测试，不依赖 wx） ----------

function parseBackup(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, message: '备份内容为空，请先粘贴或选择备份文件' };
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch (e) {
        return { ok: false, message: '这不是有效的备份内容（格式解析失败）' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, message: '这不是有效的备份内容' };
    }
    if (payload.app !== APP_ID) {
        return { ok: false, message: '这不是「我的身体单据」的备份内容' };
    }
    if (payload.version !== FORMAT_VERSION) {
        return { ok: false, message: '备份版本不兼容（v' + String(payload.version) + '）' };
    }
    if (!Array.isArray(payload.records)) {
        return { ok: false, message: '备份内容缺少记录列表' };
    }
    if (payload.records.length > MAX_RECORDS) {
        return { ok: false, message: '备份记录数超出上限' };
    }
    const records = [];
    for (let i = 0; i < payload.records.length; i += 1) {
        const item = payload.records[i];
        if (!item || typeof item !== 'object'
            || typeof item.id !== 'string' || !item.id
            || typeof item.visitDate !== 'string' || !item.visitDate
            || !Array.isArray(item.images)) {
            return { ok: false, message: '第 ' + (i + 1) + ' 条记录格式不对，已停止恢复' };
        }
        const images = item.images.slice(0, MAX_IMAGES).map(function (image) {
            const source = image && typeof image === 'object' ? image : {};
            return {
                name: baseName(source.name),
                size: Number(source.size) || 0,
                addedAt: Number(source.addedAt) || 0,
                // 精简备份里 data 为空字符串，恢复时跳过写图
                data: typeof source.data === 'string' ? source.data : '',
            };
        });
        records.push({
            id: item.id.slice(0, 80),
            visitDate: cleanText(item.visitDate, 10),
            keyword: cleanText(item.keyword, 80),
            docType: typeStore.normalizeKey(item.docType),
            note: cleanText(item.note, 200),
            createdAt: Number(item.createdAt) || 0,
            updatedAt: Number(item.updatedAt) || 0,
            images: images,
        });
    }
    return {
        ok: true,
        message: '',
        payload: {
            app: APP_ID,
            version: FORMAT_VERSION,
            createdAt: cleanText(payload.createdAt, 30),
            includeImages: !!payload.includeImages,
            types: payload.types && typeof payload.types === 'object' ? payload.types : null,
            records: records,
        },
    };
}

function summaryOf(payload) {
    const records = (payload && payload.records) || [];
    let images = 0;
    let withPhoto = 0;
    records.forEach(function (record) {
        (record.images || []).forEach(function (image) {
            images += 1;
            if (image.data) withPhoto += 1;
        });
    });
    return {
        records: records.length,
        images: images,
        withPhoto: withPhoto,
        createdAt: (payload && payload.createdAt) || '',
        includeImages: !!(payload && payload.includeImages),
    };
}

function mergeRecords(current, incoming, mode) {
    if (mode === 'replace') return incoming.slice();
    const seen = {};
    const out = [];
    incoming.forEach(function (record) {
        if (seen[record.id]) return;
        seen[record.id] = true;
        out.push(record);
    });
    (current || []).forEach(function (record) {
        if (!record || typeof record.id !== 'string' || seen[record.id]) return;
        seen[record.id] = true;
        out.push(record);
    });
    return out;
}

// ---------- 默认本机 IO ----------

function fs() {
    return wx.getFileSystemManager();
}

function imageDir() {
    return wx.env.USER_DATA_PATH + '/bills';
}

function ensureDir() {
    return new Promise(function (resolve, reject) {
        if (!fileStore.isAvailable()) {
            reject(new Error('当前环境不支持本机文件保存'));
            return;
        }
        const dir = imageDir();
        fs().mkdir({
            dirPath: dir,
            recursive: true,
            success: function () { resolve(dir); },
            fail: function () {
                fs().access({
                    path: dir,
                    success: function () { resolve(dir); },
                    fail: function () { reject(new Error('无法创建单据目录')); },
                });
            },
        });
    });
}

function defaultReadImage(path) {
    return new Promise(function (resolve, reject) {
        fs().readFile({
            filePath: path,
            encoding: 'base64',
            success: function (res) { resolve(String(res.data || '')); },
            fail: function () { reject(new Error('照片读取失败')); },
        });
    });
}

let restoreCounter = 0;
function defaultWriteImage(name, data) {
    restoreCounter += 1;
    const filePath = imageDir() + '/restore-' + Date.now() + '-' + restoreCounter
        + '-' + baseName(name);
    return new Promise(function (resolve, reject) {
        fs().writeFile({
            filePath: filePath,
            data: data,
            encoding: 'base64',
            success: function () {
                resolve({
                    path: filePath,
                    size: Math.floor(String(data).length * 3 / 4),
                    addedAt: Date.now(),
                });
            },
            fail: function (err) {
                reject(new Error('照片写入失败：' + ((err && err.errMsg) || '请检查存储空间')));
            },
        });
    });
}

function defaultReadRecords() {
    const value = wx.getStorageSync(STORAGE_KEY);
    return Array.isArray(value) ? value : [];
}

function defaultWriteRecords(records) {
    wx.setStorageSync(STORAGE_KEY, records);
}

function defaultSaveLabels(map) {
    return typeStore.saveLabels(map);
}

function defaultRemoveFiles(paths) {
    return fileStore.removeFiles(paths);
}

// ---------- 生成备份 ----------

function buildBackup(options) {
    const opts = options || {};
    const includeImages = opts.includeImages !== false;
    const readImage = opts.readImage || defaultReadImage;
    const getLabels = opts.getLabels || typeStore.getLabels;
    const listRecords = opts.listRecords || function () {
        return billStore.list().then(function (result) {
            if (result.error) throw new Error(result.error.message);
            return result.data;
        });
    };
    let missing = 0;

    return Promise.resolve()
        .then(listRecords)
        .then(function (records) {
            const out = [];
            let chain = Promise.resolve();
            (records || []).forEach(function (record) {
                chain = chain.then(function () {
                    const images = [];
                    let inner = Promise.resolve();
                    (record.images || []).forEach(function (image) {
                        inner = inner.then(function () {
                            const meta = {
                                name: baseName(image.path),
                                size: Number(image.size) || 0,
                                addedAt: Number(image.addedAt) || 0,
                                data: '',
                            };
                            if (!includeImages) {
                                images.push(meta);
                                return;
                            }
                            return Promise.resolve(readImage(image.path))
                                .catch(function () { missing += 1; return ''; })
                                .then(function (data) {
                                    meta.data = data;
                                    images.push(meta);
                                });
                        });
                    });
                    return inner.then(function () {
                        out.push({
                            id: record.id,
                            visitDate: record.visitDate,
                            keyword: record.keyword || '',
                            docType: typeStore.normalizeKey(record.docType),
                            note: record.note || '',
                            createdAt: Number(record.createdAt) || 0,
                            updatedAt: Number(record.updatedAt) || 0,
                            images: images,
                        });
                    });
                });
            });
            return chain.then(function () {
                const payload = {
                    app: APP_ID,
                    version: FORMAT_VERSION,
                    createdAt: timeText(),
                    includeImages: includeImages,
                    types: getLabels(),
                    records: out,
                };
                return {
                    ok: true,
                    text: JSON.stringify(payload),
                    payload: payload,
                    missing: missing,
                };
            });
        })
        .catch(function (error) {
            return { ok: false, message: (error && error.message) || '生成备份失败' };
        });
}

// ---------- 恢复备份 ----------

function restoreBackup(text, options) {
    const opts = options || {};
    const parsed = parseBackup(text);
    if (!parsed.ok) return Promise.resolve(parsed);
    const payload = parsed.payload;
    const mode = opts.mode === 'replace' ? 'replace' : 'merge';
    const writeImage = opts.writeImage || defaultWriteImage;
    const readRecords = opts.readRecords || defaultReadRecords;
    const writeRecords = opts.writeRecords || defaultWriteRecords;
    const saveLabels = opts.saveLabels || defaultSaveLabels;
    const removeFiles = opts.removeFiles || defaultRemoveFiles;
    const written = [];
    const restored = [];

    const prepare = opts.prepare || function () {
        return fileStore.isAvailable() ? ensureDir() : Promise.resolve();
    };

    let chain = Promise.resolve().then(prepare);
    payload.records.forEach(function (record, recordIndex) {
        chain = chain.then(function () {
            const images = [];
            let inner = Promise.resolve();
            record.images.forEach(function (image, imageIndex) {
                inner = inner.then(function () {
                    if (!image.data) return;
                    return Promise.resolve(writeImage(image.name, image.data, recordIndex + '-' + imageIndex))
                        .then(function (saved) {
                            written.push(saved.path);
                            images.push({
                                path: saved.path,
                                size: Number(saved.size) || Number(image.size) || 0,
                                addedAt: Number(image.addedAt) || Date.now(),
                            });
                        });
                });
            });
            return inner.then(function () {
                restored.push({
                    id: record.id,
                    visitDate: record.visitDate,
                    keyword: record.keyword,
                    docType: record.docType,
                    note: record.note,
                    images: images,
                    createdAt: record.createdAt || Date.now(),
                    updatedAt: record.updatedAt || Date.now(),
                });
            });
        });
    });

    return chain.then(function () {
        const merged = mergeRecords(readRecords(), restored, mode);
        writeRecords(merged);
        let labelsNote = '';
        try {
            if (payload.types) {
                const result = saveLabels(payload.types);
                if (result && result.ok === false) labelsNote = '；类型名称未恢复：' + result.message;
            }
        } catch (e) {
            labelsNote = '；类型名称未恢复，可在「我的」页自行设置';
        }
        let photos = 0;
        restored.forEach(function (record) { photos += record.images.length; });
        return {
            ok: true,
            message: '',
            data: {
                records: restored.length,
                photos: photos,
                total: merged.length,
                mode: mode,
                labelsNote: labelsNote,
            },
        };
    }).catch(function (error) {
        // 记录只在上面全部成功后才写；失败时清掉本次新照片即可，原数据完全不动。
        return Promise.resolve()
            .then(function () { return removeFiles(written); })
            .catch(function () {})
            .then(function () {
                return {
                    ok: false,
                    message: ((error && error.message) || '恢复失败') + '，原有数据未改动',
                };
            });
    });
}

module.exports = {
    APP_ID: APP_ID,
    FORMAT_VERSION: FORMAT_VERSION,
    parseBackup: parseBackup,
    summaryOf: summaryOf,
    mergeRecords: mergeRecords,
    buildBackup: buildBackup,
    restoreBackup: restoreBackup,
    timeText: timeText,
};
