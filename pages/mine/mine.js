const billStore = require('../../utils/bill-store').billStore;
const fmt = require('../../utils/format');
const typeStore = require('../../utils/type-store');

Page({
    data: {
        records: 0,
        images: 0,
        sizeText: '0 B',
        rangeText: '暂无记录',
        clearing: false,
        showLabelEditor: false,
        labelItems: [],
        labelError: '',
    },

    onShow() {
        this.load();
        this.refreshLabels();
    },

    load() {
        billStore.stats().then(function (result) {
            if (result.error) {
                this.setData({ rangeText: '读取失败，请重试' });
                return;
            }
            const stats = result.data;
            let rangeText = '暂无记录';
            if (stats.records > 0) {
                rangeText = stats.earliest === stats.latest
                    ? stats.latest
                    : stats.earliest + ' 至 ' + stats.latest;
            }
            this.setData({
                records: stats.records,
                images: stats.images,
                sizeText: fmt.humanSize(stats.bytes),
                rangeText: rangeText,
            });
        }.bind(this));
    },

    refreshLabels() {
        this.setData({ labelItems: typeStore.getItems(), labelError: '' });
    },

    toggleLabelEditor() {
        if (this.data.showLabelEditor) {
            this.setData({ showLabelEditor: false, labelError: '' });
            return;
        }
        this.refreshLabels();
        this.setData({ showLabelEditor: true });
    },

    onLabelInput(event) {
        const index = Number(event.currentTarget.dataset.index);
        if (isNaN(index)) return;
        const patch = {};
        patch['labelItems[' + index + '].label'] = event.detail.value;
        patch.labelError = '';
        this.setData(patch);
    },

    saveLabels() {
        const map = {};
        this.data.labelItems.forEach(function (item) {
            map[item.key] = item.label;
        });
        const result = typeStore.saveLabels(map);
        if (!result.ok) {
            this.setData({ labelError: result.message });
            return;
        }
        this.refreshLabels();
        this.setData({ showLabelEditor: false });
        wx.showToast({ title: '名称已保存', icon: 'success' });
    },

    resetLabels() {
        typeStore.resetLabels();
        this.refreshLabels();
        wx.showToast({ title: '已恢复默认', icon: 'success' });
    },

    goBackup() {
        wx.navigateTo({ url: '/pages/backup/backup' });
    },

    goTags() {
        wx.navigateTo({ url: '/pages/tags/tags' });
    },

    goPrivacy() {
        wx.navigateTo({ url: '/pages/privacy/privacy' });
    },

    goUpload() {
        wx.switchTab({ url: '/pages/upload/upload' });
    },

    clearAll() {
        wx.showModal({
            title: '清空全部数据',
            content: '将删除本机保存的全部记录和单据照片，且无法恢复。请先自行备份重要资料。',
            confirmText: '确认清空',
            confirmColor: '#d64545',
            success: function (res) {
                if (!res.confirm) return;
                this.setData({ clearing: true });
                billStore.clear().then(function (result) {
                    this.setData({ clearing: false });
                    if (result.error) {
                        wx.showToast({ title: result.error.message, icon: 'none' });
                        return;
                    }
                    wx.showToast({ title: '已清空', icon: 'success' });
                    this.load();
                }.bind(this));
            }.bind(this),
        });
    },
});
