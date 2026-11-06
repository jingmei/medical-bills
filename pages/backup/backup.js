const backup = require('../../utils/backup');

// 备份文本可能很大（含照片 base64 时数 MB），绝不放进 data 里做 setData，
// 否则渲染层会被拖住。完整文本只存在页面实例上，data 里只放统计与短提示。
function sizeOf(chars) {
    if (chars >= 1024 * 1024) return (chars / 1024 / 1024).toFixed(1) + ' MB';
    return (chars / 1024).toFixed(1) + ' KB';
}

function stamp() {
    const d = new Date();
    const pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate())
        + '-' + pad(d.getHours()) + pad(d.getMinutes());
}

function failText(err) {
    return (err && err.errMsg) || '未知原因';
}

Page({
    data: {
        includeImages: true,
        making: false,
        status: '',
        backupReady: false,
        exportSummary: { records: 0, images: 0, withPhoto: 0 },
        sizeText: '',
        missing: 0,
        showPaste: true,
        importLength: 0,
        mode: 'merge',
        restoreHint: '',
        restoreReady: false,
        restoreSummary: { records: 0, images: 0, withPhoto: 0 },
        confirming: false,
        restoring: false,
    },

    onLoad() {
        this._backupText = '';
        this._importText = '';
    },

    setIncludeImages() {
        this._backupText = '';
        this.setData({ includeImages: true, backupReady: false, status: '已切换为「含照片」，请重新生成备份' });
    },

    setTextOnly() {
        this._backupText = '';
        this.setData({ includeImages: false, backupReady: false, status: '已切换为「仅文字」，请重新生成备份' });
    },

    makeBackup() {
        if (this.data.making) return;
        this.setData({ making: true, backupReady: false, status: '正在读取本机记录与照片…' });
        const includeImages = this.data.includeImages;
        backup.buildBackup({ includeImages: includeImages }).then(function (result) {
            this.setData({ making: false });
            if (!result.ok) {
                this.setData({ status: '生成失败：' + result.message });
                return;
            }
            this._backupText = result.text;
            this.setData({
                backupReady: true,
                exportSummary: backup.summaryOf(result.payload),
                sizeText: sizeOf(result.text.length),
                missing: result.missing || 0,
                status: '备份已生成（' + backup.timeText() + '），请复制或导出文件保存好。',
            });
        }.bind(this));
    },

    copyBackup() {
        if (!this._backupText) {
            this.setData({ status: '请先点「生成备份内容」' });
            return;
        }
        wx.setClipboardData({
            data: this._backupText,
            success: function () {
                this.setData({ status: '已复制到剪贴板，请立刻粘贴到自己的备忘录、文件传输助手或电脑保存' });
            }.bind(this),
            fail: function (err) {
                this.setData({
                    status: '复制失败（' + failText(err) + '）。可改用「导出为文件」，或切换「仅文字」减小体积',
                });
            }.bind(this),
        });
    },

    shareBackupFile() {
        if (!this._backupText) {
            this.setData({ status: '请先点「生成备份内容」' });
            return;
        }
        if (!wx.shareFileMessage || !wx.getFileSystemManager || !wx.env) {
            this.setData({ status: '当前微信版本不支持导出文件，请改用「复制备份内容」' });
            return;
        }
        let filePath = '';
        try {
            filePath = wx.env.USER_DATA_PATH + '/backup-' + Date.now() + '.txt';
            wx.getFileSystemManager().writeFileSync(filePath, this._backupText, 'utf8');
        } catch (e) {
            this.setData({ status: '备份文件写入失败：' + ((e && e.message) || '存储空间不足') + '，请改用「复制备份内容」' });
            return;
        }
        wx.shareFileMessage({
            filePath: filePath,
            fileName: '我的身体单据-备份-' + stamp() + '.txt',
            success: function () {
                this.setData({ status: '已调起转发，请只发给自己的文件传输助手并保存好这个文件' });
            }.bind(this),
            fail: function (err) {
                this.setData({
                    status: '导出文件没成功（' + failText(err) + '）。这个能力在部分机型不可用，请改用「复制备份内容」',
                });
            }.bind(this),
        });
    },

    onImportInput(event) {
        this._importText = String((event && event.detail && event.detail.value) || '');
        this.setData({
            importLength: this._importText.length,
            restoreReady: false,
            confirming: false,
            restoreHint: '',
        });
    },

    pickBackupFile() {
        if (!wx.chooseMessageFile) {
            this.setData({ restoreHint: '当前微信版本不支持从聊天选文件，请直接粘贴备份内容' });
            return;
        }
        wx.chooseMessageFile({
            count: 1,
            type: 'all',
            success: function (res) {
                const files = res && res.tempFiles;
                if (!files || !files.length) return;
                wx.getFileSystemManager().readFile({
                    filePath: files[0].path,
                    encoding: 'utf8',
                    success: function (result) {
                        this._importText = String(result.data || '');
                        this.setData({
                            importLength: this._importText.length,
                            restoreReady: false,
                            confirming: false,
                            restoreHint: '已从聊天文件读入备份内容，请点「检查备份内容」',
                        });
                    }.bind(this),
                    fail: function (err) {
                        this.setData({ restoreHint: '文件读取失败（' + failText(err) + '），请改用粘贴' });
                    }.bind(this),
                });
            }.bind(this),
            fail: function (err) {
                this.setData({ restoreHint: '没有选到文件（' + failText(err) + '），也可以直接粘贴备份内容' });
            }.bind(this),
        });
    },

    clearPaste() {
        this._importText = '';
        this.setData({
            showPaste: false,
            importLength: 0,
            restoreReady: false,
            confirming: false,
            restoreHint: '已清空输入',
        });
        setTimeout(function () {
            this.setData({ showPaste: true });
        }.bind(this), 50);
    },

    setMerge() {
        this.setData({ mode: 'merge', confirming: false });
    },

    setReplace() {
        this.setData({ mode: 'replace', confirming: false });
    },

    checkBackup() {
        const parsed = backup.parseBackup(this._importText);
        if (!parsed.ok) {
            this.setData({ restoreHint: parsed.message, restoreReady: false, confirming: false });
            return;
        }
        const summary = backup.summaryOf(parsed.payload);
        const shortNote = summary.withPhoto < summary.images
            ? ' 注意：其中 ' + (summary.images - summary.withPhoto) + ' 张没有图片内容，恢复后看不到照片。' : '';
        this.setData({
            restoreReady: true,
            restoreSummary: summary,
            confirming: false,
            restoreHint: '检查通过 · 备份时间 ' + (summary.createdAt || '未记录') + ' · '
                + summary.records + ' 条记录 · ' + summary.images + ' 张照片（含图片内容 ' + summary.withPhoto + ' 张）。' + shortNote,
        });
    },

    askRestore() {
        if (!this.data.restoreReady) return;
        this.setData({ confirming: true, restoreHint: '请再确认一次；写入期间请不要退出页面' });
    },

    cancelRestore() {
        this.setData({ confirming: false, restoreHint: '已取消，数据未改动' });
    },

    doRestore() {
        if (this.data.restoring) return;
        this.setData({ restoring: true, restoreHint: '正在写入照片与记录…' });
        backup.restoreBackup(this._importText, { mode: this.data.mode }).then(function (result) {
            this.setData({ restoring: false, confirming: false });
            if (!result.ok) {
                this.setData({ restoreHint: '恢复未完成：' + result.message });
                return;
            }
            const data = result.data;
            this.setData({
                restoreReady: false,
                restoreHint: '恢复完成：写入 ' + data.records + ' 条记录、' + data.photos
                    + ' 张照片，当前共 ' + data.total + ' 条' + data.labelsNote + '。可回「单据」页查看。',
            });
            wx.showToast({ title: '恢复完成', icon: 'success' });
        }.bind(this));
    },
});
