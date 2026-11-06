const billStore = require('../../utils/bill-store').billStore;
const fmt = require('../../utils/format');
const typeStore = require('../../utils/type-store');
const tagKit = require('../../utils/tag-kit');
const tagStore = require('../../utils/tag-store');
const ocr = require('../../utils/ocr');

Page({
    data: {
        loading: true,
        notFound: false,
        record: null,
        images: [],
        dateLabel: '',
        createdText: '',
        sizeText: '',
        imageCountText: '',
        editing: false,
        saving: false,
        editKeyword: '',
        editNote: '',
        editDate: '',
        editTypeIndex: 0,
        editTypeText: '',
        typeOptions: [],
        typeKeys: [],
        editHint: '',
        editTags: [],
        tagEditorOpen: false,
        tagEditorTag: '',
        tagEditorText: '',
        tagEditorTitle: '',
        tagEditorHint: '',
        tagSuggestions: [],     // 输入标签时按出现次数提示已有标签（本机词库）

        // 单张照片编辑（保存后可补识别 / 改标签 / 改备注）
        itemEditOpen: false,
        itemEditIndex: -1,
        itemEditNo: 0,
        itemEditKeyword: '',
        itemEditTags: [],
        itemEditNote: '',
        itemEditHint: '',
        itemOcrRunning: false,
        itemOcrHint: '',
        itemTagEditorOpen: false,
        itemTagEditorTag: '',
        itemTagEditorText: '',
        itemTagEditorTitle: '',
        itemTagEditorHint: '',
        itemTagSuggestions: [],
    },

    onLoad(options) {
        this.recordId = options && options.id ? String(options.id) : '';
        this.load();
        this.loadTagLibrary();
    },

    // 只读取本机记录用于标签自动补全，不改动保存修改的流程
    loadTagLibrary() {
        billStore.list().then(function (result) {
            if (result.error) return;
            this.libraryRecords = Array.isArray(result.data) ? result.data : [];
            if (this.data.tagEditorOpen) {
                this.setData({ tagSuggestions: this.buildTagSuggestions(this.data.tagEditorText) });
            }
        }.bind(this));
    },

    buildTagSuggestions(query, baseKeyword) {
        const exclude = tagKit.words(baseKeyword !== undefined ? baseKeyword : this.data.editKeyword);
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

    load() {
        if (!this.recordId) {
            this.setData({ loading: false, notFound: true });
            return;
        }
        billStore.get(this.recordId).then(function (result) {
            if (result.error || !result.data) {
                this.setData({ loading: false, notFound: true });
                return;
            }
            const record = result.data;
            let bytes = 0;
            const images = record.images.map(function (image) {
                bytes += image.size;
                return { path: image.path };
            });
            // 按照片编号展示各自标签/备注；旧记录无 items 时回退为整条记录备注
            const hasItems = Array.isArray(record.items) && record.items.length > 0;
            const itemsView = hasItems ? record.items.map(function (item) {
                const tags = Array.isArray(item.tags) ? item.tags : [];
                return {
                    photoNo: item.photoNo,
                    tags: tags,
                    note: item.note || '',
                    hasNote: !!item.note,
                    hasTags: tags.length > 0,
                };
            }) : null;
            // 保存各照片的本机路径，供「重新识别这张」直接对落盘图片做端侧 OCR
            this._imagePaths = record.images.map(function (image) { return image.path; });

            this.setData({
                loading: false,
                notFound: false,
                record: {
                    id: record.id,
                    docType: typeStore.labelOf(record.docType),
                    docTypeKey: typeStore.normalizeKey(record.docType),
                    keyword: record.keyword || '未填写关键字',
                    keywordRaw: record.keyword || '',
                    visitDate: record.visitDate,
                    note: record.note || '',
                    hasNote: !!record.note,
                    batchId: record.batchId || '',
                },
                images: images,
                itemsView: itemsView,
                hasItems: hasItems,
                dateLabel: fmt.dateLabel(record.visitDate),
                createdText: fmt.formatDateTime(record.createdAt),
                sizeText: fmt.humanSize(bytes),
                imageCountText: String(images.length) + ' 张照片',
            });
        }.bind(this));
    },

    preview(event) {
        const current = event.currentTarget.dataset.src;
        const urls = this.data.images.map(function (image) { return image.path; });
        if (!urls.length) return;
        wx.previewImage({ current: current || urls[0], urls: urls });
    },

    // 已保存的记录可以补写 / 改正关键字、拍照日期、类型与备注，
    // 不必为了改一个错字就删掉重传照片。
    startEdit() {
        if (!this.data.record) return;
        const items = typeStore.getItems();
        const keys = items.map(function (item) { return item.key; });
        const options = items.map(function (item) { return item.label; });
        let index = keys.indexOf(this.data.record.docTypeKey);
        if (index < 0) index = 0;
        this.setData({
            editing: true,
            saving: false,
            editHint: '改好后点「保存修改」；不想改就点「取消」。',
            editKeyword: String(this.data.record.keywordRaw || '').trim(),
            editTags: tagKit.words(String(this.data.record.keywordRaw || '')),
            editNote: String(this.data.record.note || '').trim(),
            editDate: this.data.record.visitDate,
            typeOptions: options,
            typeKeys: keys,
            editTypeIndex: index,
            editTypeText: options[index],
        });
    },

    cancelEdit() {
        this.setData({
            editing: false, saving: false, editHint: '',
            tagEditorOpen: false, tagEditorTag: '', tagEditorText: '', tagEditorHint: '',
            tagSuggestions: [],
        });
    },

    onEditKeywordInput(event) {
        const keyword = String(event.detail.value || '').slice(0, tagKit.KEYWORD_MAX);
        this.setData({
            editKeyword: keyword,
            editTags: tagKit.words(keyword),
            editHint: '',
        });
    },

    openTagEditor() {
        this.setData({
            tagEditorOpen: true, tagEditorTag: '', tagEditorText: '',
            tagEditorTitle: '手动添加一个标签', tagEditorHint: '',
            tagSuggestions: this.buildTagSuggestions(''),
        });
    },

    editTag(event) {
        const tag = String(event.currentTarget.dataset.tag || '');
        if (!tag) return;
        this.setData({
            tagEditorOpen: true, tagEditorTag: tag, tagEditorText: tag,
            tagEditorTitle: '修改标签：' + tag, tagEditorHint: '',
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
        const result = oldTag
            ? tagKit.edit(this.data.editKeyword, oldTag, this.data.tagEditorText)
            : tagKit.add(this.data.editKeyword, this.data.tagEditorText);
        if (!result.ok) {
            this.setData({ tagEditorHint: result.message });
            wx.showToast({ title: result.message, icon: 'none' });
            return;
        }
        this.setData({
            editKeyword: result.keyword,
            editTags: tagKit.words(result.keyword),
            editHint: '标签已改好，点「保存修改」生效',
            tagEditorOpen: false, tagEditorTag: '', tagEditorText: '', tagEditorHint: '',
            tagSuggestions: [],
        });
        wx.showToast({ title: oldTag ? '标签已修改' : '标签已添加', icon: 'none' });
    },

    removeEditTag(event) {
        const tag = String(event.currentTarget.dataset.tag || '');
        if (!tag) return;
        const keyword = tagKit.remove(this.data.editKeyword, tag).keyword;
        this.setData({
            editKeyword: keyword,
            editTags: tagKit.words(keyword),
            editHint: '标签已去掉，点「保存修改」生效',
        });
    },

    onEditNoteInput(event) {
        this.setData({ editNote: event.detail.value, editHint: '' });
    },

    onEditDateChange(event) {
        this.setData({ editDate: event.detail.value, editHint: '' });
    },

    onEditTypeChange(event) {
        const index = Number(event.detail.value) || 0;
        this.setData({
            editTypeIndex: index,
            editTypeText: this.data.typeOptions[index],
            editHint: '',
        });
    },

    clearEditNote() {
        this.setData({ editNote: '', editHint: '备注已清空，点「保存修改」生效' });
        wx.showToast({ title: '备注已清空', icon: 'none' });
    },

    saveEdit() {
        if (this.data.saving) {
            this.setData({ editHint: '正在保存，请稍候' });
            return;
        }
        const date = String(this.data.editDate || '').trim();
        if (!date) {
            this.setData({ editHint: '请先选择拍照日期' });
            wx.showToast({ title: '请选择拍照日期', icon: 'none' });
            return;
        }
        this.setData({ saving: true, editHint: '正在写入本机…' });
        const key = this.data.typeKeys[this.data.editTypeIndex] || 'other';
        billStore.update(this.recordId, {
            visitDate: date,
            keyword: String(this.data.editKeyword || '').trim(),
            note: String(this.data.editNote || '').trim(),
            docType: key,
        }).then(function (result) {
            this.setData({ saving: false });
            if (result.error || !result.data) {
                const message = (result.error && result.error.message) || '修改未保存，请重试';
                this.setData({ editHint: '修改未保存：' + message });
                wx.showToast({ title: message, icon: 'none' });
                return;
            }
            this.setData({ editing: false, editHint: '' });
            this.load();
            wx.showToast({ title: '修改已保存', icon: 'success' });
        }.bind(this));
    },

    // ===== 单张照片编辑（保存后补识别 / 改标签 / 改备注）=====

    editItem(event) {
        const idx = Number(event.currentTarget.dataset.idx);
        if (idx < 0 || !this.data.itemsView || !this.data.itemsView[idx]) return;
        const item = this.data.itemsView[idx];
        this.setData({
            itemEditOpen: true,
            itemEditIndex: idx,
            itemEditNo: item.photoNo,
            itemEditKeyword: (item.tags || []).join(' '),
            itemEditTags: item.tags || [],
            itemEditNote: item.note || '',
            itemEditHint: '改好点「保存这张」；也可点「重新识别这张」自动补标签。',
            itemOcrRunning: false,
            itemOcrHint: '',
        });
    },

    cancelItemEdit() {
        this.setData({
            itemEditOpen: false, itemEditIndex: -1, itemEditNo: 0,
            itemEditKeyword: '', itemEditTags: [], itemEditNote: '', itemEditHint: '',
            itemTagEditorOpen: false, itemTagEditorTag: '', itemTagEditorText: '', itemTagEditorHint: '',
            itemTagSuggestions: [], itemOcrRunning: false, itemOcrHint: '',
        });
    },

    saveItemEdit() {
        const idx = this.data.itemEditIndex;
        if (idx < 0 || !this.data.itemsView || !this.data.itemsView[idx]) {
            this.setData({ itemEditHint: '没有可保存的这张照片' });
            return;
        }
        const items = this.data.itemsView.map(function (it, i) {
            if (i === idx) {
                return {
                    photoNo: it.photoNo,
                    tags: tagKit.words(this.data.itemEditKeyword),
                    note: String(this.data.itemEditNote || '').trim(),
                };
            }
            return { photoNo: it.photoNo, tags: it.tags || [], note: it.note || '' };
        }.bind(this));
        // 整条记录的关键字 / 备注仍是各张的并集，保持首页检索一致
        const keyword = items.map(function (it) {
            return (it.tags || []).join(' ');
        }).join(' ').trim().slice(0, tagKit.KEYWORD_MAX);
        const note = items.map(function (it) {
            return String(it.note || '').trim();
        }).filter(function (t) { return t !== ''; }).join(' · ').slice(0, 200);
        this.setData({ itemEditHint: '正在写入本机…' });
        billStore.update(this.recordId, { items: items, keyword: keyword, note: note }).then(function (result) {
            if (result.error || !result.data) {
                this.setData({ itemEditHint: '未保存：' + ((result.error && result.error.message) || '请重试') });
                wx.showToast({ title: '未保存', icon: 'none' });
                return;
            }
            this.setData({ itemEditOpen: false, itemEditIndex: -1, itemEditHint: '' });
            this.load();
            wx.showToast({ title: '这张已保存', icon: 'success' });
        }.bind(this));
    },

    onItemKeywordInput(event) {
        const keyword = String(event.detail.value || '').slice(0, tagKit.KEYWORD_MAX);
        this.setData({
            itemEditKeyword: keyword,
            itemEditTags: tagKit.words(keyword),
            itemEditHint: '',
        });
    },

    openItemTagEditor() {
        this.setData({
            itemTagEditorOpen: true, itemTagEditorTag: '', itemTagEditorText: '',
            itemTagEditorTitle: '给这张照片加一个标签', itemTagEditorHint: '',
            itemTagSuggestions: this.buildTagSuggestions('', this.data.itemEditKeyword),
        });
    },

    itemTag(event) {
        const tag = String(event.currentTarget.dataset.tag || '');
        if (!tag) return;
        this.setData({
            itemTagEditorOpen: true, itemTagEditorTag: tag, itemTagEditorText: tag,
            itemTagEditorTitle: '修改标签：' + tag, itemTagEditorHint: '',
            itemTagSuggestions: this.buildTagSuggestions(tag, this.data.itemEditKeyword),
        });
    },

    onItemTagEditorInput(event) {
        const text = event.detail.value;
        this.setData({
            itemTagEditorText: text, itemTagEditorHint: '',
            itemTagSuggestions: this.buildTagSuggestions(text, this.data.itemEditKeyword),
        });
    },

    closeItemTagEditor() {
        this.setData({
            itemTagEditorOpen: false, itemTagEditorTag: '', itemTagEditorText: '', itemTagEditorHint: '',
            itemTagSuggestions: [],
        });
    },

    submitItemTagEditor() {
        const oldTag = this.data.itemTagEditorTag;
        const result = oldTag
            ? tagKit.edit(this.data.itemEditKeyword, oldTag, this.data.itemTagEditorText)
            : tagKit.add(this.data.itemEditKeyword, this.data.itemTagEditorText);
        if (!result.ok) {
            this.setData({ itemTagEditorHint: result.message });
            wx.showToast({ title: result.message, icon: 'none' });
            return;
        }
        this.setData({
            itemEditKeyword: result.keyword,
            itemEditTags: tagKit.words(result.keyword),
            itemEditHint: '标签已改好，点「保存这张」生效',
            itemTagEditorOpen: false, itemTagEditorTag: '', itemTagEditorText: '', itemTagEditorHint: '',
            itemTagSuggestions: [],
        });
        wx.showToast({ title: oldTag ? '标签已修改' : '标签已添加', icon: 'none' });
    },

    removeItemTag(event) {
        const tag = String(event.currentTarget.dataset.tag || '');
        if (!tag) return;
        const keyword = tagKit.remove(this.data.itemEditKeyword, tag).keyword;
        this.setData({
            itemEditKeyword: keyword,
            itemEditTags: tagKit.words(keyword),
            itemEditHint: '标签已去掉，点「保存这张」生效',
        });
    },

    tapItemTagSuggestion(event) {
        const tag = String(event.currentTarget.dataset.tag || '');
        if (!tag) return;
        this.setData({
            itemTagEditorText: tag, itemTagEditorHint: '',
            itemTagSuggestions: this.buildTagSuggestions(tag, this.data.itemEditKeyword),
        });
    },

    onItemNoteInput(event) {
        this.setData({ itemEditNote: event.detail.value, itemEditHint: '' });
    },

    // 从这张照片的备注文字里提取标签（追加，不覆盖已有标签）。
    // 解决「本机识别不可用、只能手动复制文字到备注，却没有标签提取」的问题。
    extractTagsFromNote() {
        const note = String(this.data.itemEditNote || '').trim();
        if (!note) {
            this.setData({ itemEditHint: '备注是空的，先粘贴文字再提取' });
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
            this.setData({ itemEditHint: '标签整理未完成；可手动加标签或填关键字' });
            return;
        }
        if (!tags.length) {
            this.setData({ itemEditHint: '备注里没发现可提取的标签，可手动加标签或填关键字' });
            wx.showToast({ title: '未提取到标签', icon: 'none' });
            return;
        }
        const merged = tagKit.words(this.data.itemEditKeyword);
        tags.forEach(function (t) { if (merged.indexOf(t) < 0) merged.push(t); });
        const keyword = merged.join(' ').trim().slice(0, tagKit.KEYWORD_MAX);
        this.setData({
            itemEditKeyword: keyword,
            itemEditTags: merged,
            itemEditHint: '已从备注提取 ' + tags.length + ' 个标签，点「保存这张」生效',
        });
        wx.showToast({ title: '已提取 ' + tags.length + ' 个标签', icon: 'none' });
    },

    reOcrItem(event) {
        const idx = Number(event.currentTarget.dataset.idx);
        const path = this._imagePaths && this._imagePaths[idx];
        if (!path) {
            wx.showToast({ title: '找不到这张照片的文件', icon: 'none' });
            return;
        }
        if (!ocr.isSupported()) {
            wx.showModal({
                title: '本机识别不可用',
                content: '当前微信版本不支持端侧识别，请直接手动填写这张的标签与备注。',
                showCancel: false, confirmText: '知道了',
            });
            return;
        }
        this.setData({ itemOcrRunning: true, itemOcrHint: '正在识别这张照片…' });
        ocr.recognize(path, function () {})
            .then(function (texts) {
                this.setData({ itemOcrRunning: false });
                if (!texts || !texts.length) {
                    this.setData({ itemOcrHint: '没识别到文字，请手动填写标签。' });
                    wx.showToast({ title: '未识别到文字', icon: 'none' });
                    return;
                }
                const analyzed = ocr.analyze(texts, { trusted: true });
                const newTags = (analyzed && analyzed.tags) ? analyzed.tags : [];
                const merged = tagKit.words(this.data.itemEditKeyword);
                newTags.forEach(function (t) { if (merged.indexOf(t) < 0) merged.push(t); });
                const keyword = merged.join(' ').trim().slice(0, tagKit.KEYWORD_MAX);
                this.setData({
                    itemEditKeyword: keyword,
                    itemEditTags: merged,
                    itemOcrHint: '已识别并加入标签，点「保存这张」生效。',
                });
                wx.showToast({ title: '识别完成', icon: 'none' });
            }.bind(this))
            .catch(function (error) {
                this.setData({
                    itemOcrRunning: false,
                    itemOcrHint: '识别失败：' + ((error && error.message) || '请手动填写'),
                });
                wx.showModal({
                    title: '本机识别未成功',
                    content: (error && error.message) || '请手动填写标签与备注',
                    showCancel: false, confirmText: '知道了',
                });
            }.bind(this));
    },

    remove() {
        wx.showModal({
            title: '删除这条记录',
            content: '将同时删除本机保存的单据照片，删除后无法恢复。',
            confirmText: '确认删除',
            confirmColor: '#d64545',
            success: function (res) {
                if (!res.confirm) return;
                billStore.remove(this.recordId).then(function (result) {
                    if (result.error) {
                        wx.showToast({ title: result.error.message, icon: 'none' });
                        return;
                    }
                    wx.showToast({ title: '已删除', icon: 'success' });
                    setTimeout(function () { wx.navigateBack(); }, 600);
                });
            }.bind(this),
        });
    },
});
