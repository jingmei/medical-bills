const storeModule = require('../../utils/bill-store');
const billStore = storeModule.billStore;
const fileStore = require('../../utils/file-store');
const fmt = require('../../utils/format');
const typeStore = require('../../utils/type-store');
const ocr = require('../../utils/ocr');
const tagKit = require('../../utils/tag-kit');
const tagStore = require('../../utils/tag-store');
const build = require('../../utils/build');

const MAX_IMAGES = storeModule.MAX_IMAGES;
const OCR_WATCHDOG_MS = 12000;  // 页面级看门狗：Promise 不回调也强制收尾
const SAVE_WATCHDOG_MS = 25000; // 保存全流程看门狗
const SAVE_STUCK_MS = 15000;    // 超过这个时长的「正在保存」视为卡死，允许强制解锁

// 把一组照片的关键字按词取并集，避免同词重复；结果用于记录级 keyword（搜索用）。
function unionKeywords(photos) {
    const merged = (photos || []).map(function (p) {
        return p.keyword || '';
    }).join(' ');
    return tagKit.words(merged).join(' ').slice(0, tagKit.KEYWORD_MAX);
}

// 同组照片的备注拼接成一条记录备注，便于归档时保留每张的说明。
function joinNotes(photos) {
    return (photos || []).map(function (p) {
        return String(p.note || '').trim();
    }).filter(function (t) { return t !== ''; }).join(' · ').slice(0, 200);
}

// 按类型把照片分成若干组；同类型并在一组，异类型各自成组。
function groupByType(photos) {
    const map = {};
    (photos || []).forEach(function (p) {
        const key = p.docType || 'other';
        if (!map[key]) map[key] = { docType: key, photos: [] };
        map[key].photos.push(p);
    });
    return Object.keys(map).map(function (k) { return map[k]; });
}

Page({
    data: {
        photos: [],
        activeKey: '',
        active: null,        // 当前编辑照片的可绑定镜像（ocrTexts/ocrTags/keyword/note/类型等）
        fileCount: 0,
        remaining: MAX_IMAGES,
        canAdd: true,
        maxImages: MAX_IMAGES,
        visitDate: '',
        typeOptions: [],     // 类型选项（全局共用，每张照片各自记录所选）
        typeKeys: [],
        ocrSupported: false,
        ocrRunning: false,
        manualOpen: true,
        manualText: '',
        tagEditorOpen: false,
        tagEditorTag: '',
        tagEditorText: '',
        tagEditorTitle: '',
        tagEditorHint: '',
        tagSuggestions: [],
        saveModeHint: '',    // 保存模式提示：同类一条 / 异类自动拆分
        submitting: false,
        formError: '',
        saveHint: '',
        savedInfo: '',
        savedDir: '',
        savedPath: '',
        needPrivacy: false,
        envLine: '',
    },

    // ---- 照片数据读写：单一数据源是 photos[]，active 仅用于 WXML 绑定 ----
    photoIndex(key) {
        const list = this.data.photos;
        for (let i = 0; i < list.length; i += 1) {
            if (list[i].key === key) return i;
        }
        return -1;
    },

    getPhoto(key) {
        const i = this.photoIndex(key);
        return i >= 0 ? this.data.photos[i] : null;
    },

    // 更新指定照片的字段，并同步 active 镜像（若改的就是当前编辑的那张）。
    patchPhoto(key, patch) {
        const i = this.photoIndex(key);
        if (i < 0) return;
        const photos = this.data.photos.slice();
        photos[i] = Object.assign({}, photos[i], patch);
        const next = { photos: photos };
        if (this.data.activeKey === key) {
            next.active = Object.assign({}, photos[i]);
        }
        this.setData(next);
    },

    setActive(key) {
        const photo = this.getPhoto(key);
        if (!photo) return;
        this.setData({
            activeKey: key,
            active: Object.assign({}, photo),
            manualText: photo.manualText || '',
        });
        if (this.data.tagEditorOpen) {
            this.setData({ tagSuggestions: this.buildTagSuggestions(this.data.tagEditorText) });
        }
        this.recomputeSaveMode();
    },

    onLoad() {
        this._ocrSettled = true;
        this._ocrWatchdog = null;
        this._ocrTicker = null;
        this._ocrLaunchTimer = null;
        this._saveWatchdog = null;
        this._saveStartedAt = 0;
        this._saveClickAt = 0;
        this._ocrTargetKey = '';
        let agreed = false;
        try {
            const app = getApp();
            agreed = !!(app && app.hasPrivacyAgreed && app.hasPrivacyAgreed());
        } catch (e) {}
        this.setData({
            visitDate: fmt.todayStr(),
            ocrSupported: ocr.isSupported(),
            envLine: this.buildEnvLine(),
            needPrivacy: !agreed,
        });
        // B7 兜底：重进页面时把上次粘贴过的文字草稿带回来（即使页面被卡死 / 重进也不会丢）
        try {
            const draft = wx.getStorageSync('medical-bills.manual-draft.v1');
            if (draft) this.setData({ manualText: draft });
        } catch (e) {}
        this.refreshTypes();
        this.loadTagLibrary();
    },

    // 只读取本机记录用于标签自动补全，不参与保存与识别流程
    loadTagLibrary() {
        billStore.list().then(function (result) {
            if (result.error) return;
            this.libraryRecords = Array.isArray(result.data) ? result.data : [];
            if (this.data.tagEditorOpen) {
                this.setData({ tagSuggestions: this.buildTagSuggestions(this.data.tagEditorText) });
            }
        }.bind(this));
    },

    buildTagSuggestions(query) {
        const exclude = this.data.active ? tagKit.words(this.data.active.keyword) : [];
        return tagStore.suggestions(this.libraryRecords || [], query, 8, {
            exclude: exclude,
            prefs: tagStore.readPrefs(),
        }).map(function (item) {
            return {
                tag: item.tag,
                label: item.tag.length > 14 ? item.tag.slice(0, 14) + '…' : item.tag,
                count: item.count,
            };
        });
    },

    tapTagSuggestion(event) {
        const tag = String(event.currentTarget.dataset.tag || '');
        if (!tag) return;
        this.setData({
            tagEditorText: tag,
            tagEditorHint: '',
            tagSuggestions: this.buildTagSuggestions(tag),
        });
    },

    onHide() {
        this.abortOcr();
    },

    onUnload() {
        this.stopOcrTicker();
        this.abortOcr();
        this.unlockSave();
    },

    onShow() {
        this.refreshTypes();
        this.setData({ envLine: this.buildEnvLine() });
        this.loadTagLibrary();
        if (this.data.submitting) this.unlockSave();
        // 回到页面时若识别状态还挂着，直接收尾，避免按钮永久失灵
        if (this.data.ocrRunning && (this._ocrWatchdog === null || this._ocrWatchdog === undefined)) {
            this.finishOcr();
            this.setData({ ocrHint: '识别已自动结束，可直接保存，或用「粘贴图中文字」' });
        }
        let stuck = false;
        try {
            const pendingAt = Number(wx.getStorageSync('medical-bills.ocr-pending.v1') || 0);
            stuck = pendingAt > 0 && Date.now() - pendingAt > 3000;
        } catch (e) {}
        if (stuck) {
            this.clearOcrPending();
            this._ocrSettled = true;
            this.stopOcrTicker();
            this.setData({ ocrRunning: false, ocrHint: '上次本机识别未完成，已自动收尾。可重试一次，或直接用下方「粘贴图中文字」' });
        }
        // 上次自动识别若被同步调用卡死、用户退出重进：兜底收尾并引导到粘贴路径
        if (this.data.activeKey) {
            const saved = this.restoreOcrDraft(this.data.activeKey);
            if (saved) this.setData({ ocrHint: '已恢复上次识别到的文字，并自动整理成标签' });
        }
        if (!fileStore.isAvailable()) {
            this.setData({ formError: '当前环境不支持本机文件保存，请在微信中打开体验版' });
        }
    },

    // 把上次识别结果恢复到指定照片（整页卡死后重进也能找回）
    restoreOcrDraft(key) {
        try {
            const saved = wx.getStorageSync('medical-bills.ocr-last.v1');
            if (Array.isArray(saved) && saved.length) {
                const photo = this.getPhoto(key);
                if (photo && !String(photo.keyword || '').trim() && !photo.ocrTexts.length) {
                    this.applyOcrTexts(saved, { targetKey: key });
                    return true;
                }
            }
        } catch (e) {}
        return false;
    },

    clearOcrPending() {
        try {
            wx.removeStorageSync('medical-bills.ocr-pending.v1');
        } catch (e) {}
    },

    buildEnvLine() {
        let sdk = '未知';
        try {
            sdk = (wx.getSystemInfoSync() || {}).SDKVersion || '未知';
        } catch (e) {}
        let fsOk = false;
        try {
            fsOk = fileStore.isAvailable();
        } catch (e) {}
        return '构建 ' + build.tag + ' · 保存' + (fsOk ? '可用' : '不可用')
            + ' · 本机标签提取可用 · 基础库 ' + sdk;
    },

    showDiagnostics() {
        let sdk = '未知';
        try {
            sdk = (wx.getSystemInfoSync() || {}).SDKVersion || '未知';
        } catch (e) {}
        let fsOk = false;
        try {
            fsOk = fileStore.isAvailable();
        } catch (e) {}
        let agreed = false;
        try {
            const app = getApp();
            agreed = !!(app && app.hasPrivacyAgreed && app.hasPrivacyAgreed());
        } catch (e) {}
        const text = [
            '构建：' + build.tag + '（' + build.time + '）',
            '本机保存能力：' + (fsOk ? '可用' : '不可用'),
            '识别方式：本机自动识别（可选）+ 粘贴图中文字；标签只在本机整理，不上传',
            '微信基础库：' + sdk,
            '已选照片：' + this.data.photos.length + ' 张',
            '当前编辑：' + (this.data.active ? '照片' + this.data.active.photoNo : '无'),
            '隐私已同意：' + (agreed ? '是' : '否'),
            '保存状态：' + (this.data.submitting ? '进行中' : '空闲'),
            '拍照日期：' + (this.data.visitDate || '未选'),
        ].join('\n');
        this.setData({ saveHint: '环境自检：' + build.tag + ' / 保存' + (fsOk ? '可用' : '不可用') + ' / 本机标签提取 / 基础库 ' + sdk });
        wx.showModal({
            title: '版本与环境自检',
            content: text,
            confirmText: '复制信息',
            cancelText: '关闭',
            success: function (res) {
                if (!res.confirm) return;
                wx.setClipboardData({ data: text });
            },
        });
    },

    refreshTypes() {
        const items = typeStore.getItems();
        if (!items.length) return;
        this.setData({
            typeOptions: items.map(function (item) { return item.label; }),
            typeKeys: items.map(function (item) { return item.key; }),
        });
        // 让每张已选照片的类型显示名与最新设置保持一致
        const photos = this.data.photos.map(function (p) {
            const idx = Math.max(0, items.findIndex(function (it) { return it.key === p.docType; }));
            return Object.assign({}, p, { typeText: items[idx].label, typeIndex: idx });
        });
        const next = { photos: photos };
        if (this.data.activeKey) next.active = Object.assign({}, photos[this.photoIndex(this.data.activeKey)]);
        this.setData(next);
    },

    chooseImages() {
        const remain = MAX_IMAGES - this.data.photos.length;
        if (remain <= 0) {
            wx.showToast({ title: '最多 ' + MAX_IMAGES + ' 张', icon: 'none' });
            return;
        }
        wx.chooseMedia({
            count: remain,
            mediaType: ['image'],
            sourceType: ['album', 'camera'],
            sizeType: ['compressed'],
            camera: 'back',
            success: function (res) {
                const stamp = Date.now();
                const picked = (res.tempFiles || []).map(function (file, index) {
                    return {
                        key: 'tmp-' + stamp + '-' + index + '-' + Math.floor(Math.random() * 100000),
                        tempFilePath: file.tempFilePath,
                        size: Number(file.size) || 0,
                        photoNo: 0,           // 添加后再统一编号
                        docType: this.data.typeKeys[0] || 'other',
                        typeText: this.data.typeOptions[0] || '其他',
                        typeIndex: 0,
                        ocrTexts: [],
                        keyword: '',
                        ocrTags: [],
                        ocrDate: '',
                        ocrHint: '',
                        note: '',
                        manualText: '',
                        recognized: false,
                    };
                }.bind(this));
                const merged = this.data.photos.concat(picked);
                this.renumber(merged);
                const next = {
                    photos: merged,
                    fileCount: merged.length,
                    remaining: MAX_IMAGES - merged.length,
                    canAdd: merged.length < MAX_IMAGES,
                    formError: '',
                };
                // 若还没有选中任何照片，自动选中第一张，让识别/编辑入口立即可用
                if (!this.data.activeKey && merged.length) {
                    next.activeKey = merged[0].key;
                    next.active = Object.assign({}, merged[0]);
                    next.manualText = merged[0].manualText || '';
                }
                this.setData(next);
                this.recomputeSaveMode();
            }.bind(this),
            fail: function (error) {
                const message = (error && error.errMsg) || '';
                if (message.indexOf('cancel') >= 0) return;
                wx.showModal({
                    title: '无法添加照片',
                    content: '需要相册或相机权限。原始提示：' + (message || '无'),
                    showCancel: false,
                    confirmText: '知道了',
                });
            },
        });
    },

    // 按当前顺序给每张照片重新写照片编号（删除中间某张后，后面的会顺延）
    renumber(photos) {
        photos.forEach(function (p, i) { p.photoNo = i + 1; });
    },

    // 删除某张照片：同时清除它的识别结果、标签、备注，不留孤儿数据
    removePhoto(event) {
        const key = event.currentTarget.dataset.key;
        const target = this.getPhoto(key);
        if (!target) return;
        const merged = this.data.photos.filter(function (p) { return p.key !== key; });
        this.renumber(merged);
        const next = {
            photos: merged,
            fileCount: merged.length,
            remaining: MAX_IMAGES - merged.length,
            canAdd: merged.length < MAX_IMAGES,
        };
        if (this.data.activeKey === key) {
            if (merged.length) {
                next.activeKey = merged[0].key;
                next.active = Object.assign({}, merged[0]);
                next.manualText = merged[0].manualText || '';
            } else {
                next.activeKey = '';
                next.active = null;
                next.manualText = '';
            }
        }
        this.setData(next);
        this.recomputeSaveMode();
        wx.showToast({ title: '已删除该照片及其识别结果', icon: 'none' });
    },

    // 选中某张照片进入「编辑中」：之后识别 / 标签 / 备注都只针对它
    selectPhoto(event) {
        const key = event.currentTarget.dataset.key;
        if (key === this.data.activeKey) {
            wx.showToast({ title: '正在编辑照片' + this.data.active.photoNo, icon: 'none' });
            return;
        }
        this.setActive(key);
    },

    previewTemp(event) {
        const current = event.currentTarget.dataset.src;
        const urls = this.data.photos.map(function (file) { return file.tempFilePath; });
        if (!urls.length) return;
        wx.previewImage({ current: current || urls[0], urls: urls });
    },

    onDateChange(event) {
        this.setData({ visitDate: event.detail.value, formError: '' });
    },

    // ---- 当前照片的标签：标签条与 keyword 共用一份数据 ----
    editActiveKeyword(value) {
        if (!this.data.activeKey) return;
        const keyword = String(value || '').slice(0, tagKit.KEYWORD_MAX);
        this.patchPhoto(this.data.activeKey, { keyword: keyword, ocrTags: tagKit.words(keyword) });
    },

    openTagEditor() {
        if (!this.data.activeKey) {
            wx.showToast({ title: '请先点一张照片', icon: 'none' });
            return;
        }
        this.setData({
            tagEditorOpen: true,
            tagEditorTag: '',
            tagEditorText: '',
            tagEditorTitle: '给照片' + this.data.active.photoNo + '手动添加一个标签',
            tagEditorHint: '',
            tagSuggestions: this.buildTagSuggestions(''),
        });
    },

    editTag(event) {
        const tag = String(event.currentTarget.dataset.tag || '');
        if (!tag || !this.data.activeKey) return;
        this.setData({
            tagEditorOpen: true,
            tagEditorTag: tag,
            tagEditorText: tag,
            tagEditorTitle: '修改照片' + this.data.active.photoNo + '的标签：' + tag,
            tagEditorHint: '',
            tagSuggestions: this.buildTagSuggestions(tag),
        });
    },

    onTagEditorInput(event) {
        const text = event.detail.value;
        this.setData({
            tagEditorText: text,
            tagEditorHint: '',
            tagSuggestions: this.buildTagSuggestions(text),
        });
    },

    closeTagEditor() {
        this.setData({
            tagEditorOpen: false, tagEditorTag: '', tagEditorText: '', tagEditorHint: '',
            tagSuggestions: [],
        });
    },

    submitTagEditor() {
        const oldTag = this.data.tagEditorTag;
        const current = this.data.active ? this.data.active.keyword : '';
        const result = oldTag
            ? tagKit.edit(current, oldTag, this.data.tagEditorText)
            : tagKit.add(current, this.data.tagEditorText);
        if (!result.ok) {
            this.setData({ tagEditorHint: result.message });
            wx.showToast({ title: result.message, icon: 'none' });
            return;
        }
        if (this.data.activeKey) {
            this.patchPhoto(this.data.activeKey, { keyword: result.keyword, ocrTags: tagKit.words(result.keyword) });
        }
        this.setData({ tagEditorOpen: false, tagEditorTag: '', tagEditorText: '', tagEditorHint: '', tagSuggestions: [] });
        wx.showToast({ title: oldTag ? '标签已修改' : '标签已添加', icon: 'none' });
    },

    onActiveTypeChange(event) {
        const index = Number(event.detail.value) || 0;
        if (!this.data.activeKey) return;
        this.patchPhoto(this.data.activeKey, {
            typeIndex: index,
            typeText: this.data.typeOptions[index],
            docType: this.data.typeKeys[index],
        });
        this.recomputeSaveMode();
    },

    onActiveNoteInput(event) {
        if (!this.data.activeKey) return;
        this.patchPhoto(this.data.activeKey, { note: event.detail.value });
    },

    // 把当前照片「备注」里的文字按本机规则提取成标签（不丢原有标签，追加新标签）。
    // 解决「本机识别不可用、只能手动复制文字到备注，却没有标签提取」的问题。
    extractTagsFromNote() {
        if (!this.data.activeKey) {
            wx.showToast({ title: '请先点一张照片', icon: 'none' });
            return;
        }
        const note = String(this.getPhoto(this.data.activeKey).note || '').trim();
        if (!note) {
            wx.showToast({ title: '备注是空的', icon: 'none' });
            return;
        }
        const lines = note.split(/[\r\n；;。]+|[,，]\s*/).map(function (s) {
            return s.trim();
        }).filter(function (s) { return s !== ''; }).slice(0, 80);
        let tags = [];
        try {
            const analyzed = ocr.analyze(lines, { trusted: true });
            tags = (analyzed && analyzed.tags) ? analyzed.tags : [];
        } catch (e) {
            this.patchPhoto(this.data.activeKey, { ocrHint: '标签整理未完成；可手动加标签或填关键字' });
            return;
        }
        if (!tags.length) {
            this.patchPhoto(this.data.activeKey, { ocrHint: '备注里没发现可提取的标签，可手动加标签或填关键字' });
            wx.showToast({ title: '未提取到标签', icon: 'none' });
            return;
        }
        const merged = tagKit.words(this.getPhoto(this.data.activeKey).keyword);
        tags.forEach(function (t) { if (merged.indexOf(t) < 0) merged.push(t); });
        const keyword = merged.join(' ').trim().slice(0, tagKit.KEYWORD_MAX);
        this.patchPhoto(this.data.activeKey, {
            keyword: keyword,
            ocrTags: merged,
            recognized: true,
            ocrHint: '已从备注提取 ' + tags.length + ' 个标签；在「这张的标签」里可改字或删除',
        });
        wx.showToast({ title: '已提取 ' + tags.length + ' 个标签', icon: 'none' });
    },

    // ---- 识别（针对当前选中的照片） ----
    startOcrTicker() {
        this.stopOcrTicker();
        this._ocrStartedAt = Date.now();
        const self = this;
        this._ocrTicker = setInterval(function () {
            if (!self.data.ocrRunning) { self.stopOcrTicker(); return; }
            const seconds = Math.round((Date.now() - self._ocrStartedAt) / 1000);
            self.patchPhoto(self._ocrTargetKey, {
                ocrHint: '正在本机识别… 已等待 ' + seconds + ' 秒，最多 12 秒自动结束；可点「停止识别」跳过，也可直接点「手动输入文字」',
            });
        }, 1000);
    },

    stopOcrTicker() {
        if (this._ocrTicker !== null && this._ocrTicker !== undefined) {
            clearInterval(this._ocrTicker);
            this._ocrTicker = null;
        }
    },

    abortOcr() {
        this.stopOcrTicker();
        if (this._ocrLaunchTimer !== null && this._ocrLaunchTimer !== undefined) {
            clearTimeout(this._ocrLaunchTimer);
            this._ocrLaunchTimer = null;
        }
        if (this._ocrWatchdog !== null && this._ocrWatchdog !== undefined) {
            clearTimeout(this._ocrWatchdog);
            this._ocrWatchdog = null;
        }
        try { ocr.cancel(); } catch (e) {}
        this.clearOcrPending();
        if (!this._ocrSettled) {
            this._ocrSettled = true;
            this.setData({ ocrRunning: false });
        }
    },

    finishOcr() {
        if (this._ocrSettled) return false;
        this._ocrSettled = true;
        this.stopOcrTicker();
        this.clearOcrPending();
        if (this._ocrLaunchTimer !== null && this._ocrLaunchTimer !== undefined) {
            clearTimeout(this._ocrLaunchTimer);
            this._ocrLaunchTimer = null;
        }
        if (this._ocrWatchdog !== null && this._ocrWatchdog !== undefined) {
            clearTimeout(this._ocrWatchdog);
            this._ocrWatchdog = null;
        }
        this.setData({ ocrRunning: false });
        return true;
    },

    stopOcr() {
        if (!this.data.ocrRunning) return;
        const key = this._ocrTargetKey;
        this.abortOcr();
        this.patchPhoto(key, { ocrHint: '已手动停止识别，可直接用「粘贴图中文字」或填写关键字后保存' });
        wx.showToast({ title: '已停止识别', icon: 'none' });
    },

    // 识别结果落到指定照片：先把文字行与状态写回该照片，再在下一个宏任务整理标签。
    onOcrResult(texts, targetKey) {
        if (this._ocrSettled) return;
        const list = (texts || []).slice(0, 12);
        this._ocrResultHandled = true;
        this.finishOcr();
        try {
            wx.setStorageSync('medical-bills.ocr-last.v1', list);
        } catch (e) {}
        this.patchPhoto(targetKey, {
            ocrTexts: list,
            ocrHint: '识别到 ' + list.length + ' 行文字，正在整理标签…（文字已暂存，重进也能恢复）',
        });
        const self = this;
        setTimeout(function () {
            try {
                self.applyOcrTexts(list, { targetKey: targetKey });
            } catch (e) {
                self.patchPhoto(targetKey, { ocrHint: '文字已拿到，可点文字行加标签，或用「粘贴图中文字」' });
            }
        }, 60);
    },

    // 把一组文字整理成标签，写入指定照片。
    applyOcrTexts(texts, options) {
        const targetKey = (options && options.targetKey) || this.data.activeKey;
        if (!targetKey) return;
        const list = (texts || []).slice(0, 12);
        const trusted = !!(options && options.trusted);
        let result;
        try {
            result = ocr.analyze(texts, { trusted: trusted });
        } catch (e) {
            this.patchPhoto(targetKey, { ocrTexts: list, ocrHint: '文字已收到，标签整理未完成；可点文字行加标签，或直接填写关键字' });
            return;
        }
        const garbled = !trusted && !!(result.quality && result.quality.garbled);
        const tags = result.tags;

        if (garbled) {
            this.patchPhoto(targetKey, {
                ocrTexts: list,
                ocrTags: tagKit.words(this.getPhoto(targetKey).keyword),
                ocrDate: result.date,
                ocrHint: '文字不清晰，未自动填写关键字。请手动点开上面的图片，'
                    + '然后两个手指分开长按识别，进入选词模式，选择「全选」和「复制」文字，'
                    + '填入下方「粘贴图中文字」框。',
                manualOpen: true,
            });
            try { wx.removeStorageSync('medical-bills.ocr-last.v1'); } catch (e) {}
            wx.showToast({ title: '文字不清晰，请看下方步骤', icon: 'none', duration: 2500 });
            return;
        }

        const parts = tags.slice();
        String(this.getPhoto(targetKey).keyword || '').trim().split(/\s+/).forEach(function (word) {
            if (word && parts.indexOf(word) < 0) parts.unshift(word);
        });
        const timeNote = result.times.length ? '；图中时间 ' + result.times.join(' / ') : '';
        const keyword = parts.join(' ').trim().slice(0, tagKit.KEYWORD_MAX);
        this.patchPhoto(targetKey, {
            ocrTexts: list,
            ocrTags: tagKit.words(keyword),
            ocrDate: result.date,
            keyword: keyword,
            recognized: true,
            ocrHint: list.length
                ? '整理出 ' + list.length + ' 行文字，已提取 ' + tags.length + ' 个标签：'
                    + (result.date ? '日期 ' + result.date : '未找到完整日期') + '、标题「' + (result.title || '无') + '」' + timeNote
                : '没有拿到文字，请用「粘贴图中文字」或直接在关键字里填写',
        });
        try {
            wx.removeStorageSync('medical-bills.ocr-last.v1');
        } catch (e) {}
        wx.showToast({ title: list.length ? '已提取日期 / 标题 / 时间' : '未拿到文字', icon: 'none' });
    },

    inputTextManually() {
        if (!this.data.activeKey) {
            wx.showToast({ title: '请先点一张照片', icon: 'none' });
            return;
        }
        if (this.data.ocrRunning) this.abortOcr();
        this.setData({ manualOpen: !this.data.manualOpen });
    },

    onManualInput(event) {
        const value = String(event.detail.value || '');
        this.setData({ manualText: value });
        if (this.data.activeKey) this.patchPhoto(this.data.activeKey, { manualText: value });
        // 实时暂存草稿：即使页面被卡住或小程序重进，粘贴过的文字也能回来（B7 兜底）
        try {
            wx.setStorageSync('medical-bills.manual-draft.v1', value);
        } catch (e) {}
    },

    closeManual() {
        this.setData({ manualOpen: false });
    },

    clearManual() {
        this.setData({ manualText: '' });
        if (this.data.activeKey) this.patchPhoto(this.data.activeKey, { manualText: '' });
        // 清空时一并删掉暂存草稿，避免下次进入又把这段文字带出来
        try { wx.removeStorageSync('medical-bills.manual-draft.v1'); } catch (e) {}
        wx.showToast({ title: '已清空文字', icon: 'none' });
    },

    submitManual() {
        const raw = String(this.data.manualText || '').trim();
        if (!this.data.activeKey) {
            wx.showToast({ title: '请先点一张照片', icon: 'none' });
            return;
        }
        if (!raw) {
            wx.showToast({ title: '先粘贴图中文字，或直接填关键字', icon: 'none' });
            return;
        }
        const lines = raw.split(/[\r\n；;。]+|[,，]\s*/).map(function (item) {
            return item.trim();
        }).filter(function (item) { return item !== ''; }).slice(0, 80);
        try {
            // 用户主动粘贴 / 输入的文字一律信任，不套用乱码闸门
            this.applyOcrTexts(lines, { targetKey: this.data.activeKey, trusted: true });
        } catch (e) {
            this.patchPhoto(this.data.activeKey, { ocrHint: '文字已收到，标签整理未完成；可点文字行加标签，或直接填写关键字' });
        }
        this.setData({ manualOpen: true, manualText: '' });
        if (this.data.activeKey) this.clearActiveManual(this.data.activeKey);
    },

    // 提交手动文字后清空该照片的草稿，避免下次进入又带出来
    clearActiveManual(key) {
        this.patchPhoto(key, { manualText: '' });
    },

    runOcr() {
        if (!this.data.activeKey) {
            wx.showToast({ title: '请先点一张照片再识别', icon: 'none' });
            return;
        }
        if (this.data.ocrRunning) return;
        if (!this.data.ocrSupported) {
            wx.showModal({
                title: '当前微信不支持本机识别',
                content: '可以直接点「手动输入文字」，把日期、标题、时间抄进去，同样会自动提取标签；也可以直接填写关键字后保存。',
                showCancel: false,
                confirmText: '知道了',
            });
            return;
        }
        const targetKey = this.data.activeKey;
        const target = this.getPhoto(targetKey);
        if (!target) return;
        this._ocrSettled = false;
        this._ocrResultHandled = false;
        this._ocrTargetKey = targetKey;
        try {
            wx.setStorageSync('medical-bills.ocr-pending.v1', Date.now());
        } catch (e) {}
        this.setData({
            ocrRunning: true,
            ocrHint: '',
        });
        this.patchPhoto(targetKey, {
            ocrHint: '准备中… 可点「停止识别」取消。若整页点不动，退出小程序重进即可，已保存的记录不会丢',
            ocrTexts: [],
            ocrTags: tagKit.words(target.keyword),
            ocrDate: '',
        });
        this.startOcrTicker();

        this._ocrWatchdog = setTimeout(function () {
            if (!this.finishOcr()) return;
            this.patchPhoto(targetKey, {
                ocrHint: '本机识别未返回结果，已自动结束；请用下方「粘贴图中文字」，或直接填写关键字',
            });
            wx.showToast({ title: '识别未返回，可粘贴文字', icon: 'none', duration: 2500 });
        }.bind(this), OCR_WATCHDOG_MS);

        const src = target.tempFilePath;
        // 先让出一帧再调用端侧能力：runOCR 是同步推理，若点击当帧就调用，
        // 页面状态与「停止识别」按钮还没渲染，用户会看到一个整页冻住的界面。
        this._ocrLaunchTimer = setTimeout(function () {
            if (this._ocrSettled) return;
            ocr.recognize(src, function (texts) {
                if (this._ocrResultHandled) return;
                if (!this.finishOcr()) return;
                if (!texts || !texts.length) {
                    this.patchPhoto(targetKey, { ocrHint: '没有识别到文字，请用「手动输入文字」或直接填写关键字' });
                    wx.showToast({ title: '未识别到文字', icon: 'none' });
                    return;
                }
                this.applyOcrTexts(texts, { targetKey: targetKey });
            }.bind(this))
                .then(function (texts) {
                    if (this._ocrResultHandled) return;
                    if (!this.finishOcr()) return;
                    if (!texts || !texts.length) {
                        this.patchPhoto(targetKey, { ocrHint: '没有识别到文字，请用「手动输入文字」或直接填写关键字' });
                        wx.showToast({ title: '未识别到文字', icon: 'none' });
                        return;
                    }
                    this.applyOcrTexts(texts, { targetKey: targetKey });
                }.bind(this))
                .catch(function (error) {
                    if (this._ocrResultHandled) return;
                    if (!this.finishOcr()) return;
                    const detail = (error && error.message) || '识别失败，请手动填写';
                    this.patchPhoto(targetKey, { ocrHint: detail + '；可用「手动输入文字」' });
                    wx.showModal({ title: '本机识别未成功', content: detail, showCancel: false, confirmText: '知道了' });
                }.bind(this));
        }.bind(this), 800);
    },

    removeOcrTag(event) {
        const tag = String(event.currentTarget.dataset.tag || '');
        if (!tag || !this.data.activeKey) return;
        const current = this.getPhoto(this.data.activeKey).keyword;
        this.patchPhoto(this.data.activeKey, {
            keyword: tagKit.remove(current, tag).keyword,
        });
        this.patchPhoto(this.data.activeKey, { ocrTags: tagKit.words(this.getPhoto(this.data.activeKey).keyword) });
    },

    addTagFromLine(event) {
        const raw = String(event.currentTarget.dataset.line || '').trim();
        if (!raw || !this.data.activeKey) return;
        if (raw.length > 24) {
            wx.showToast({ title: '这行文字太长，请直接输入简短的词', icon: 'none', duration: 2500 });
            return;
        }
        const current = this.getPhoto(this.data.activeKey).keyword;
        const result = tagKit.add(current, raw.slice(0, tagKit.TAG_MAX_LEN));
        if (!result.ok) {
            wx.showToast({ title: result.message, icon: 'none' });
            return;
        }
        this.patchPhoto(this.data.activeKey, { keyword: result.keyword, ocrTags: tagKit.words(result.keyword) });
        wx.showToast({ title: '已加入标签', icon: 'none' });
    },

    useOcrDate() {
        const key = this._ocrTargetKey || this.data.activeKey;
        const photo = this.getPhoto(key);
        const date = photo ? photo.ocrDate : '';
        if (!date) return;
        this.setData({ visitDate: date });
        wx.showToast({ title: '已设为拍照日期', icon: 'none' });
    },

    fillNoteFromOcr() {
        const key = this._ocrTargetKey || this.data.activeKey;
        const photo = this.getPhoto(key);
        if (!photo || !photo.ocrTexts.length) return;
        const joined = photo.ocrTexts.join(' · ').slice(0, 200);
        const current = String(photo.note || '').trim();
        if (current && current.indexOf(joined.slice(0, 20)) >= 0) {
            this.patchPhoto(key, { note: current.slice(0, 200) });
            wx.showToast({ title: '这段文字已在备注里', icon: 'none' });
            return;
        }
        this.patchPhoto(key, { note: (current ? current + ' · ' + joined : joined).slice(0, 200) });
        wx.showToast({ title: '已填入备注', icon: 'none' });
    },

    clearOcr() {
        if (!this.data.activeKey) return;
        this.patchPhoto(this.data.activeKey, { ocrTexts: [], ocrDate: '', ocrHint: '', recognized: false });
    },

    goPrivacy() {
        wx.navigateTo({ url: '/pages/privacy/privacy' });
    },

    agreePrivacy() {
        try {
            const app = getApp();
            if (app && app.setPrivacyAgreed) app.setPrivacyAgreed(true);
        } catch (e) {}
        this.setData({ needPrivacy: false, saveHint: '已确认，现在可以点「保存到本机」了' });
        wx.showToast({ title: '已确认，可保存', icon: 'none' });
    },

    unlockSave() {
        if (this._saveWatchdog !== null && this._saveWatchdog !== undefined) {
            clearTimeout(this._saveWatchdog);
            this._saveWatchdog = null;
        }
        this.setData({ submitting: false });
    },

    goRecords() {
        wx.switchTab({ url: '/pages/index/index' });
    },

    copySavedPath() {
        const text = this.data.savedPath || this.data.savedDir;
        if (!text) return;
        wx.setClipboardData({ data: text });
    },

    // 根据当前照片类型组合，提示保存模式：同类一条 / 异类自动拆多条。
    recomputeSaveMode() {
        const groups = groupByType(this.data.photos);
        if (groups.length === 0) {
            this.setData({ saveModeHint: '' });
            return;
        }
        let hint;
        if (groups.length === 1) {
            const label = typeStore.labelOf(groups[0].docType);
            hint = '这些照片将作为「' + label + '」的 1 条记录保存（共 ' + groups[0].photos.length + ' 张）';
        } else {
            const parts = groups.map(function (g) {
                return typeStore.labelOf(g.docType) + ' ' + g.photos.length + ' 张';
            });
            hint = '检测到不同类别，将自动拆成 ' + groups.length + ' 条记录保存（' + parts.join(' / ') + '），共用一个批次号';
        }
        // 有照片还没识别：仍可保存，但提醒事后可在单据详情里单独补识别 / 编辑
        const unrec = this.data.photos.filter(function (p) { return !p.recognized; }).length;
        if (unrec > 0) {
            hint += '（注意：有 ' + unrec + ' 张还没识别文字，仍会正常保存；保存后到「单据」里点开这条，可对该张单独「重新识别 / 编辑标签」）';
        }
        this.setData({ saveModeHint: hint });
    },

    reportSaved(records, totalImages) {
        const root = (wx.env && wx.env.USER_DATA_PATH) ? wx.env.USER_DATA_PATH : '小程序本机目录';
        const dir = root + '/bills/';
        const firstPath = (records[0] && records[0].images[0] && records[0].images[0].path) || dir;
        const multi = records.length > 1;
        const content = '已保存 ' + records.length + ' 条记录 · 共 ' + totalImages + ' 张照片'
            + (multi ? '' : '')
            + '\n\n保存目录：\n' + dir + '\n\n'
            + '第一张照片路径：\n' + firstPath + '\n\n'
            + '说明：照片和记录只存在这台手机的小程序私有目录里，不上传；'
            + '手机相册与文件管理器看不到它，到「单据」页就能查看和搜索。';
        this.setData({
            savedDir: dir,
            savedPath: firstPath,
            savedInfo: '已保存 ' + records.length + ' 条记录 · 共 ' + totalImages + ' 张照片，路径见下方，可复制',
            saveHint: '④ 保存完成，下面是保存位置',
            formError: '',
        });
        wx.showModal({
            title: '已保存到本机',
            content: content,
            confirmText: '查看单据',
            cancelText: '留在本页',
            success: function (res) {
                if (res.confirm) wx.switchTab({ url: '/pages/index/index' });
            },
        });
    },

    failSave(error) {
        this.unlockSave();
        const detail = (error && error.message) || String(error || '保存失败，请重试');
        this.setData({ formError: detail, saveHint: '保存未完成：' + detail });
        wx.showModal({
            title: '保存失败',
            content: detail,
            showCancel: false,
            confirmText: '知道了',
        });
    },

    rejectForm(message) {
        this.setData({ formError: message, saveHint: '未开始保存：' + message });
        wx.showModal({
            title: '无法保存',
            content: message,
            showCancel: false,
            confirmText: '知道了',
        });
    },

    save() {
        const now = Date.now();
        this._saveClickAt = now;
        this.setData({ saveHint: '① 已收到点击，正在检查…', formError: '' });
        if (this.data.submitting) {
            if (now - (this._saveStartedAt || 0) < SAVE_STUCK_MS) {
                this.setData({ saveHint: '① 上一次保存还在进行中，请稍候；超过 15 秒会自动恢复' });
                wx.showToast({ title: '正在保存中，请稍候', icon: 'none' });
                return;
            }
            this.unlockSave();
        }
        if (this.data.ocrRunning) this.abortOcr();

        if (!this.data.visitDate) {
            this.rejectForm('请选择拍照日期');
            return;
        }
        if (this.data.photos.length === 0) {
            this.rejectForm('请至少添加一张单据照片（拍照后在上方缩略图能看到才算添加成功）');
            return;
        }
        if (!fileStore.isAvailable()) {
            this.rejectForm('当前环境不支持保存图片。请在微信里打开体验版扫码使用，网页预览不能写本机文件');
            return;
        }
        if (this.data.needPrivacy) {
            this.setData({ saveHint: '① 请先点吸底栏上方的「同意」，再点保存' });
            wx.showToast({ title: '请先点「同意」', icon: 'none' });
            return;
        }
        this.setData({ saveHint: '② 校验通过，开始写入…' });

        const visitDate = this.data.visitDate;
        const photos = this.data.photos;
        const groups = groupByType(photos);
        const batchId = groups.length > 1 ? ('b-' + Date.now() + '-' + Math.floor(Math.random() * 1000000)) : '';

        const doSave = function () {
            this._saveStartedAt = Date.now();
            this.setData({
                submitting: true,
                formError: '',
                saveHint: '② 正在把照片写入本机…',
                savedInfo: '',
                savedPath: '',
            });
            this._saveWatchdog = setTimeout(function () {
                this.failSave(new Error('保存超时，已自动恢复；可重试，或把「环境自检」截图发给开发者'));
            }.bind(this), SAVE_WATCHDOG_MS);

            // 一次性把全部照片落盘（顺序与 photos 一致），再分组建记录，便于失败回滚。
            const allTemp = photos.map(function (p) { return { tempFilePath: p.tempFilePath, size: p.size }; });
            fileStore.persistImages(allTemp)
                .then(function (savedImages) {
                    this.setData({ saveHint: '③ 照片已写入，正在保存记录…' });
                    const savedByKey = {};
                    photos.forEach(function (p, i) { savedByKey[p.key] = savedImages[i]; });

                    const created = [];
                    let chain = Promise.resolve();
                    groups.forEach(function (group) {
                        chain = chain.then(function () {
                            const images = group.photos.map(function (p) { return savedByKey[p.key]; });
                            const record = {
                                visitDate: visitDate,
                                keyword: unionKeywords(group.photos),
                                docType: group.docType,
                                note: joinNotes(group.photos),
                                images: images,
                                items: group.photos.map(function (p) {
                                    return {
                                        photoNo: p.photoNo,
                                        tags: tagKit.words(p.keyword),
                                        note: String(p.note || '').trim(),
                                    };
                                }),
                                batchId: batchId,
                            };
                            return billStore.create(record).then(function (res) {
                                if (res.error) throw new Error(res.error.message);
                                created.push(res.data);
                            });
                        });
                    });

                    return chain.then(function () {
                        return created;
                    }).catch(function (error) {
                        // 任一分组失败：回滚已建记录及其图片，再回滚全部照片，避免孤儿文件
                        const createdIds = created.map(function (r) { return r.id; });
                        const paths = savedImages.map(function (img) { return img.path; });
                        return Promise.all([
                            Promise.all(createdIds.map(function (id) {
                                return billStore.remove(id).catch(function () {});
                            })),
                            fileStore.removeFiles(paths),
                        ]).then(function () { throw error; });
                    });
                }.bind(this))
                .then(function (created) {
                    this.unlockSave();
                    this.setData({
                        photos: [], activeKey: '', active: null, manualText: '',
                        fileCount: 0, remaining: MAX_IMAGES, canAdd: true,
                        saveModeHint: '',
                    });
                    this.reportSaved(created, photos.length);
                }.bind(this))
                .catch(function (error) {
                    this.failSave(error);
                }.bind(this));
        }.bind(this);

        doSave();
    },
});
