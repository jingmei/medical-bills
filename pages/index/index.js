const billStore = require('../../utils/bill-store').billStore;
const fmt = require('../../utils/format');
const typeStore = require('../../utils/type-store');
const dateFilter = require('../../utils/date-filter');
const tagRank = require('../../utils/tag-rank');
const tagStore = require('../../utils/tag-store');
const adConfig = require('../../config/ad');

function shortTag(word) {
    return word.length > 8 ? word.slice(0, 8) + '…' : word;
}

function toViewItem(record) {
    return {
        id: record.id,
        docType: typeStore.labelOf(record.docType),
        keywordText: record.keyword || '未填写关键字',
        // 统一日期写法，让手写 2026-4-28 也能正确分组与按段筛选
        visitDate: dateFilter.normalizeDate(record.visitDate) || record.visitDate,
        noteText: record.note || '',
        hasNote: !!record.note,
        imageCount: record.images.length,
        imageText: String(record.images.length) + ' 张',
        thumb: record.images.length ? record.images[0].path : '',
        createdText: fmt.formatDateTime(record.createdAt),
    };
}

function labelOfType(options, key) {
    for (let i = 0; i < options.length; i += 1) {
        if (options[i].key === key) return options[i].label;
    }
    return '全部类型';
}

Page({
    data: {
        viewState: 'loading',
        errorMessage: '',
        keyword: '',
        activeType: 'all',
        typeOptions: [],
        typeNames: [],
        typeIndex: 0,
        activeTypeLabel: '全部类型',
        tagChips: [],
        activeTags: [],
        tagMatchMode: 'all',
        dateGranularities: dateFilter.GRANULARITIES,
        dateGranularity: 'day',
        dateFields: 'day',
        dateBucket: '',
        dateText: '选择日期',
        datePickerValue: '',
        dateStart: dateFilter.START_DATE,
        dateEnd: '2030-12-31',
        quickDates: [],
        hasFilters: false,
        filterSummary: '',
        groups: [],
        totalCount: 0,
        imageCount: 0,
        hasRecords: false,
        ad: { enabled: false, unitId: '', adType: 'banner' },
    },

    onLoad() {
        this.allRecords = [];
        const range = dateFilter.pickerRange(fmt.todayStr());
        this.setData({
            ad: adConfig.getBannerAd(),
            dateStart: range.start,
            dateEnd: range.end,
            datePickerValue: fmt.todayStr(),
        });
    },

    onShow() {
        this.refreshTypes();
        this.loadRecords();
    },

    refreshTypes() {
        const items = [{ key: 'all', label: '全部类型' }].concat(
            typeStore.getItems().map(function (item) {
                return { key: item.key, label: item.label };
            })
        );
        let index = 0;
        for (let i = 0; i < items.length; i += 1) {
            if (items[i].key === this.data.activeType) index = i;
        }
        this.setData({
            typeOptions: items,
            typeNames: items.map(function (item) { return item.label; }),
            typeIndex: index,
            activeType: items[index].key,
            activeTypeLabel: items[index].label,
        }, this.applyFilter.bind(this));
    },

    loadRecords() {
        this.setData({ viewState: 'loading', errorMessage: '' });
        billStore.list().then(function (result) {
            if (result.error) {
                this.setData({
                    viewState: 'error',
                    errorMessage: result.error.message || '读取本机数据失败',
                });
                return;
            }
            this.allRecords = Array.isArray(result.data) ? result.data : [];
            this.applyFilter();
        }.bind(this));
    },

    // 四个条件（文字 / 类型 / 标签 / 日期）同时生效，取交集。
    // 文字搜索只查关键字、类型名与备注，日期交给下面的独立日期段处理。
    applyFilter() {
        const all = this.allRecords || [];
        const keyword = String(this.data.keyword || '').trim().toLowerCase();
        const activeType = this.data.activeType;
        const granularity = this.data.dateGranularity;
        const bucket = this.data.dateBucket;

        // 标签词库：忽略的标签不出现在首页，置顶的排在最前，其余按出现次数
        const prefs = tagStore.readPrefs();
        const library = tagStore.collect(all, prefs).filter(function (item) {
            return !item.hidden && item.tag.length <= 16;
        });
        const byCount = tagStore.sortTags(library, 'popular');
        const ordered = byCount.filter(function (item) { return item.pinned; })
            .concat(byCount.filter(function (item) { return !item.pinned; }))
            .slice(0, 12);
        const validTags = ordered.map(function (item) { return item.tag; });
        const activeTags = (this.data.activeTags || []).filter(function (tag) {
            return validTags.indexOf(tag) >= 0; // 标签被改名 / 删光记录后自动取消选中
        });
        const mode = this.data.tagMatchMode;

        const records = all.filter(function (record) {
            if (activeType !== 'all' && typeStore.normalizeKey(record.docType) !== activeType) return false;
            if (activeTags.length) {
                const tagOk = mode === 'any'
                    ? activeTags.some(function (tag) { return tagRank.matches(record, tag); })
                    : activeTags.every(function (tag) { return tagRank.matches(record, tag); });
                if (!tagOk) return false;
            }
            if (!dateFilter.matchDate(record.visitDate, granularity, bucket)) return false;
            if (!keyword) return true;
            const haystack = [
                record.keyword,
                record.docType,
                typeStore.labelOf(record.docType),
                record.note,
            ].join(' ').toLowerCase();
            return haystack.indexOf(keyword) >= 0;
        });

        const items = records.map(toViewItem);
        const groups = fmt.groupByDate(items);
        let imageCount = 0;
        records.forEach(function (record) {
            imageCount += record.images.length;
        });

        const tagChips = ordered.map(function (item) {
            return {
                key: 'tag:' + item.tag,
                tag: item.tag,
                label: shortTag(item.tag),
                count: item.count,
                pinned: item.pinned,
                selected: activeTags.indexOf(item.tag) >= 0,
            };
        });
        const summaryParts = [];
        if (activeTags.length) {
            summaryParts.push('标签 ' + activeTags.join(' + ') + (mode === 'any' ? '（任一）' : '（全部）'));
        }
        if (activeType !== 'all') summaryParts.push('类型 ' + labelOfType(this.data.typeOptions, activeType));
        if (bucket) summaryParts.push('日期 ' + dateFilter.describe(granularity, bucket));

        this.setData({
            groups: groups,
            totalCount: records.length,
            imageCount: imageCount,
            hasRecords: all.length > 0,
            viewState: records.length === 0 ? 'empty' : 'ready',
            tagChips: tagChips,
            activeTags: activeTags,
            quickDates: dateFilter.quickBuckets(all, granularity, 8),
            dateText: bucket ? dateFilter.describe(granularity, bucket) : '选择日期',
            datePickerValue: dateFilter.pickerValue(granularity, bucket, fmt.todayStr()),
            hasFilters: !!(keyword || activeTags.length || bucket || activeType !== 'all'),
            filterSummary: summaryParts.join(' · '),
        });
    },

    onKeywordInput(event) {
        this.setData({ keyword: event.detail.value }, this.applyFilter.bind(this));
    },

    onClearKeyword() {
        this.setData({ keyword: '' }, this.applyFilter.bind(this));
    },

    onTypeChange(event) {
        const index = Number(event.detail.value);
        const item = this.data.typeOptions[index];
        if (!item) return;
        this.setData({
            typeIndex: index,
            activeType: item.key,
            activeTypeLabel: item.label,
        }, this.applyFilter.bind(this));
    },

    // 可多选：默认「全部匹配」（AND），也可切成「任一匹配」（OR），与 SO 多标签筛选一致
    onTagTap(event) {
        const tag = event.currentTarget.dataset.tag;
        if (!tag) return;
        const tags = (this.data.activeTags || []).slice();
        const index = tags.indexOf(tag);
        if (index >= 0) tags.splice(index, 1);
        else tags.push(tag);
        this.setData({ activeTags: tags }, this.applyFilter.bind(this));
    },

    onClearTags() {
        this.setData({ activeTags: [] }, this.applyFilter.bind(this));
    },

    onTagModeTap() {
        this.setData({ tagMatchMode: this.data.tagMatchMode === 'all' ? 'any' : 'all' },
            this.applyFilter.bind(this));
    },

    goTags() {
        wx.navigateTo({ url: '/pages/tags/tags' });
    },

    onDateGranularityTap(event) {
        const key = event.currentTarget.dataset.key;
        if (!key || key === this.data.dateGranularity) return;
        const item = dateFilter.granularityOf(key);
        this.setData({
            dateGranularity: item.key,
            dateFields: item.fields,
            dateBucket: '',
            dateText: '选择日期',
        }, this.applyFilter.bind(this));
    },

    onDateChange(event) {
        const bucket = dateFilter.bucketFromPicker(this.data.dateGranularity, event.detail.value);
        this.setData({
            dateBucket: bucket,
            dateText: dateFilter.describe(this.data.dateGranularity, bucket),
        }, this.applyFilter.bind(this));
    },

    onQuickDateTap(event) {
        const bucket = event.currentTarget.dataset.bucket;
        if (!bucket) return;
        const next = bucket === this.data.dateBucket ? '' : bucket;
        this.setData({
            dateBucket: next,
            dateText: dateFilter.describe(this.data.dateGranularity, next),
        }, this.applyFilter.bind(this));
    },

    onClearDate() {
        this.setData({ dateBucket: '', dateText: '选择日期' }, this.applyFilter.bind(this));
    },

    onClearAll() {
        this.setData({
            keyword: '',
            activeType: 'all',
            typeIndex: 0,
            activeTypeLabel: '全部类型',
            activeTags: [],
            tagMatchMode: 'all',
            dateBucket: '',
            dateText: '选择日期',
        }, this.applyFilter.bind(this));
    },

    openDetail(event) {
        const id = event.currentTarget.dataset.id;
        if (!id) return;
        wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
    },

    goUpload() {
        wx.switchTab({ url: '/pages/upload/upload' });
    },

    handleRetry() {
        this.loadRecords();
    },

    onAdError() {
        // 广告位未生效时不留空白占位
        this.setData({ 'ad.enabled': false });
    },
});
