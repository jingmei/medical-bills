// 标签管理：借鉴 Stack Overflow 的标签词库页与 tag completer。
// 所有改动只写本机记录，不联网；页内操作不用 showModal（真机上出现过弹窗不弹出）。
const billStore = require('../../utils/bill-store').billStore;
const tagStore = require('../../utils/tag-store');
const tagKit = require('../../utils/tag-kit');
const fmt = require('../../utils/format');

const SORT_MODES = [
    { key: 'popular', label: '按次数' },
    { key: 'name', label: '按名称' },
    { key: 'recent', label: '按最近' },
];
const MAX_PICK_RECORDS = 30;

function short(text, max) {
    var s = String(text || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
}

Page({
    data: {
        viewState: 'loading',
        query: '',
        sortMode: 'popular',
        sortModes: SORT_MODES,
        tags: [],
        totalTags: 0,
        recordsCount: 0,
        pinnedCount: 0,
        hiddenCount: 0,
        expandedTag: '',
        action: '',
        inputText: '',
        mergeList: [],
        confirmDelete: false,
        hint: '',
        newTagOpen: false,
        newTagText: '',
        newSuggestions: [],
        pickOpen: false,
        pickTag: '',
        pickItems: [],
        pickedCount: 0,
        busy: false,
    },

    onLoad() {
        this.records = [];
        this.prefs = tagStore.readPrefs();
        this.allTags = [];
    },

    onShow() {
        this.load();
    },

    load() {
        this.setData({ viewState: 'loading' });
        billStore.list().then(function (result) {
            if (result.error) {
                this.setData({ viewState: 'error', hint: result.error.message || '读取本机数据失败' });
                return;
            }
            this.records = Array.isArray(result.data) ? result.data : [];
            this.prefs = tagStore.readPrefs();
            this.refresh();
        }.bind(this));
    },

    refresh() {
        const all = tagStore.collect(this.records, this.prefs);
        this.allTags = all;
        const view = tagStore.sortTags(tagStore.filterTags(all, this.data.query), this.data.sortMode);
        const tags = view.map(function (item) {
            return {
                tag: item.tag,
                label: short(item.tag, 16),
                count: item.count,
                latestText: item.latest ? fmt.formatDateTime(item.latest) : '—',
                pinned: item.pinned,
                hidden: item.hidden,
                pinLabel: item.pinned ? '取消置顶' : '置顶',
                hideLabel: item.hidden ? '取消忽略' : '忽略',
            };
        });
        this.setData({
            tags: tags,
            totalTags: all.length,
            recordsCount: this.records.length,
            pinnedCount: all.filter(function (item) { return item.pinned; }).length,
            hiddenCount: all.filter(function (item) { return item.hidden; }).length,
            viewState: tags.length ? 'ready' : 'empty',
        });
    },

    onQueryInput(event) {
        this.setData({ query: event.detail.value }, this.refresh.bind(this));
    },

    onClearQuery() {
        this.setData({ query: '' }, this.refresh.bind(this));
    },

    onSortTap(event) {
        const key = event.currentTarget.dataset.key;
        if (!key || key === this.data.sortMode) return;
        this.setData({ sortMode: key }, this.refresh.bind(this));
    },

    // ---------- 标签操作 ----------
    onActionTap(event) {
        const dataset = event.currentTarget.dataset;
        const tag = String(dataset.tag || '');
        const action = String(dataset.action || '');
        if (!tag || !action || this.data.busy) return;

        if (action === 'pin' || action === 'hide') {
            this.togglePref(tag, action);
            return;
        }
        if (tag === this.data.expandedTag && action === this.data.action) {
            this.closeAction();
            return;
        }
        this.setData({
            expandedTag: tag,
            action: action,
            inputText: action === 'rename' ? tag : '',
            mergeList: action === 'merge' ? this.buildMergeList(tag, '') : [],
            confirmDelete: false,
            hint: '',
            pickOpen: false,
        });
    },

    closeAction() {
        this.setData({
            expandedTag: '', action: '', inputText: '', mergeList: [],
            confirmDelete: false, hint: '',
        });
    },

    onActionInput(event) {
        const text = event.detail.value;
        const patch = { inputText: text, hint: '' };
        if (this.data.action === 'merge') {
            patch.mergeList = this.buildMergeList(this.data.expandedTag, text);
        }
        this.setData(patch);
    },

    buildMergeList(fromTag, query) {
        return tagStore.mergeCandidates(this.records, fromTag, query)
            .map(function (item) {
                return { tag: item.tag, label: short(item.tag, 14), count: item.count };
            });
    },

    tapMergeTarget(event) {
        this.setData({ inputText: String(event.currentTarget.dataset.tag || ''), hint: '' });
    },

    togglePref(tag, action) {
        const key = action === 'pin' ? 'pinned' : 'hidden';
        const other = action === 'pin' ? 'hidden' : 'pinned';
        if (this.prefs[key][tag]) delete this.prefs[key][tag];
        else {
            this.prefs[key][tag] = true;
            delete this.prefs[other][tag];
        }
        const saved = tagStore.writePrefs(this.prefs);
        this.refresh();
        wx.showToast({
            title: saved ? (action === 'pin' ? '已更新置顶' : '已更新忽略') : '保存失败，请重试',
            icon: 'none',
        });
    },

    confirmAction() {
        if (this.data.busy) return;
        const tag = this.data.expandedTag;
        const action = this.data.action;
        if (!tag || !action) return;

        if (action === 'delete') {
            if (!this.data.confirmDelete) {
                this.setData({
                    confirmDelete: true,
                    hint: '再点一次确认：把这个标签从所有记录里移除，记录与照片本身保留。',
                });
                return;
            }
            this.commit(tagStore.removePatches(this.records, tag), function () {
                tagStore.dropPref(this.prefs, tag);
                tagStore.writePrefs(this.prefs);
                wx.showToast({ title: '标签已移除', icon: 'none' });
            }.bind(this));
            return;
        }

        if (action === 'rename') {
            const taken = this.allTags.map(function (item) { return item.tag; });
            const check = tagStore.validateName(this.data.inputText, { original: tag, taken: taken });
            if (!check.ok) { this.setData({ hint: check.message }); return; }
            const next = check.value;
            this.commit(tagStore.renamePatches(this.records, tag, next), function () {
                tagStore.movePref(this.prefs, tag, next);
                tagStore.writePrefs(this.prefs);
                wx.showToast({ title: '已改名并同步到所有记录', icon: 'none' });
            }.bind(this));
            return;
        }

        if (action === 'merge') {
            const target = tagStore.normalizeName(this.data.inputText);
            if (!target || target === tag) {
                this.setData({ hint: '请从下方已有标签里点选一个合并目标' });
                return;
            }
            const exists = this.allTags.some(function (item) { return item.tag === target; });
            if (!exists) {
                this.setData({ hint: '目标标签不存在；若要改名请用「改名」' });
                return;
            }
            this.commit(tagStore.mergePatches(this.records, tag, target), function () {
                tagStore.movePref(this.prefs, tag, target);
                tagStore.writePrefs(this.prefs);
                wx.showToast({ title: '已合并到 ' + target, icon: 'none' });
            }.bind(this));
        }
    },

    // 一次读、一次写；失败不留半成品
    commit(patches, onSuccess) {
        if (!patches.length) {
            this.setData({ hint: '没有需要改动的记录' });
            return;
        }
        this.setData({ busy: true, hint: '' });
        billStore.applyKeywordPatches(patches).then(function (result) {
            this.setData({ busy: false });
            if (result.error) {
                this.setData({ hint: result.error.message || '写入失败，请重试' });
                return;
            }
            if (onSuccess) onSuccess(result.data.updated);
            this.closeAction();
            this.setData({ pickOpen: false, newTagOpen: false, newTagText: '' });
            this.load();
        }.bind(this));
    },

    // ---------- 新建 / 批量添加 ----------
    openNewTag() {
        this.setData({
            newTagOpen: true,
            newTagText: '',
            hint: '',
            newSuggestions: this.buildSuggestions(''),
            pickOpen: false,
        });
        this.closeAction();
    },

    closeNewTag() {
        this.setData({ newTagOpen: false, newTagText: '', newSuggestions: [], pickOpen: false, hint: '' });
    },

    buildSuggestions(query) {
        return tagStore.suggestions(this.records, query, tagStore.MAX_SUGGESTIONS, {
            prefs: this.prefs,
        }).map(function (item) {
            return { tag: item.tag, label: short(item.tag, 14), count: item.count };
        });
    },

    onNewTagInput(event) {
        const text = event.detail.value;
        this.setData({ newTagText: text, newSuggestions: this.buildSuggestions(text), hint: '' });
    },

    tapSuggestion(event) {
        const tag = String(event.currentTarget.dataset.tag || '');
        this.setData({ newTagText: tag, newSuggestions: this.buildSuggestions(tag), hint: '' });
    },

    submitNewTag() {
        const check = tagStore.validateName(this.data.newTagText);
        if (!check.ok) { this.setData({ hint: check.message }); return; }
        const tag = check.value;
        const items = this.records.slice(0, MAX_PICK_RECORDS).map(function (record) {
            const has = tagKit.words(record.keyword).indexOf(tag) >= 0;
            return {
                id: record.id,
                date: record.visitDate,
                text: short(record.keyword || '未填写关键字', 22),
                has: has,
                selected: false,
            };
        });
        this.setData({
            pickOpen: true,
            pickTag: tag,
            pickItems: items,
            pickedCount: 0,
            hint: '',
            expandedTag: '',
            action: '',
        });
    },

    togglePick(event) {
        const id = String(event.currentTarget.dataset.id || '');
        const items = this.data.pickItems;
        for (let i = 0; i < items.length; i += 1) {
            if (items[i].id !== id || items[i].has) continue;
            const patch = {};
            patch['pickItems[' + i + '].selected'] = !items[i].selected;
            this.setData(patch);
            break;
        }
        this.setData({
            pickedCount: this.data.pickItems.filter(function (item) { return item.selected && !item.has; }).length,
        });
    },

    confirmPick() {
        const ids = this.data.pickItems
            .filter(function (item) { return item.selected && !item.has; })
            .map(function (item) { return item.id; });
        if (!ids.length) { this.setData({ hint: '请先勾选要加标签的记录' }); return; }
        const tag = this.data.pickTag;
        this.commit(tagStore.addPatches(this.records, tag, ids), function (updated) {
            wx.showToast({ title: '已给 ' + updated + ' 条记录加上标签', icon: 'none' });
        });
    },

    goBack() {
        wx.navigateBack({ delta: 1 });
    },
});
