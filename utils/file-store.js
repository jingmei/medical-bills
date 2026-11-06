// 单据图片的本机持久化。
// chooseMedia 返回的是临时文件，重启后可能失效；这里统一另存到小程序私有目录
// wx.env.USER_DATA_PATH/bills/，记录里只保存该永久路径。
// 注意：这是小程序自己的沙盒目录，不会出现在手机相册或文件管理器里。
//
// 真机兼容：不同机型 / 基础库对 saveFile 指定路径的支持不一致，
// 因此按「saveFile 指定路径 → copyFile → saveFile 自动分配路径」三级兜底，
// 任一成功即可；压缩产物保存失败时再用原图重试一次。

function isAvailable() {
    return !!(wx.getFileSystemManager && wx.env && wx.env.USER_DATA_PATH);
}

function baseDir() {
    return wx.env.USER_DATA_PATH + '/bills';
}

function fs() {
    return wx.getFileSystemManager();
}

function ensureDir() {
    return new Promise(function (resolve, reject) {
        if (!isAvailable()) {
            reject(new Error('当前环境不支持本机文件保存'));
            return;
        }
        const dir = baseDir();
        // recursive: true 时目录已存在通常不会报错；仍有基础库会返回 fail，
        // 因此再用 access 复核，避免把「已存在」误判成创建失败。
        fs().mkdir({
            dirPath: dir,
            recursive: true,
            success: function () { resolve(dir); },
            fail: function (err) {
                fs().access({
                    path: dir,
                    success: function () { resolve(dir); },
                    fail: function () {
                        reject(new Error('无法创建单据目录：' + ((err && err.errMsg) || '未知错误')));
                    },
                });
            },
        });
    });
}

function compress(src) {
    return new Promise(function (resolve) {
        if (!wx.compressImage) {
            resolve(src);
            return;
        }
        wx.compressImage({
            src: src,
            quality: 72,
            success: function (res) { resolve(res.tempFilePath || src); },
            fail: function () { resolve(src); },
        });
    });
}

function errMsg(err) {
    return (err && err.errMsg) || '请检查手机存储空间';
}

// 三种落盘方式依次尝试，全部失败才 reject，并带上最后一次的原始错误。
function saveOne(tempFilePath, fileName) {
    return new Promise(function (resolve, reject) {
        const target = baseDir() + '/' + fileName;
        fs().saveFile({
            tempFilePath: tempFilePath,
            filePath: target,
            success: function (res) { resolve(res.savedFilePath || target); },
            fail: function (err1) {
                fs().copyFile({
                    srcPath: tempFilePath,
                    destPath: target,
                    success: function () { resolve(target); },
                    fail: function (err2) {
                        // 不指定 filePath：由微信分配到 USER_DATA_PATH，兼容性最好。
                        // 这类文件不在 /bills 里，清空全部时按记录路径逐个删除。
                        fs().saveFile({
                            tempFilePath: tempFilePath,
                            success: function (res) {
                                resolve(res.savedFilePath || tempFilePath);
                            },
                            fail: function (err3) {
                                reject(new Error('图片保存失败：' + errMsg(err3 || err2 || err1)));
                            },
                        });
                    },
                });
            },
        });
    });
}

function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
        let settled = false;
        const timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            reject(new Error(message));
        }, ms);
        promise.then(function (value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, function (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}

// tempFiles: [{ tempFilePath, size }] -> [{ path, size, addedAt }]
function persistImages(tempFiles) {
    const work = ensureDir().then(function () {
        const saved = [];
        let chain = Promise.resolve();
        const list = Array.isArray(tempFiles) ? tempFiles : [];
        list.forEach(function (file, index) {
            chain = chain.then(function () {
                return compress(file.tempFilePath).then(function (compressed) {
                    const name = 'bill-' + Date.now() + '-' + index
                        + '-' + Math.floor(Math.random() * 1000000) + '.jpg';
                    return saveOne(compressed, name).catch(function (error) {
                        // 压缩产物路径在个别机型上不可读，改用原图再试一次
                        if (compressed === file.tempFilePath) throw error;
                        return saveOne(file.tempFilePath, name);
                    }).then(function (path) {
                        saved.push({
                            path: path,
                            size: Number(file.size) || 0,
                            addedAt: Date.now(),
                        });
                    });
                });
            });
        });
        return chain.then(function () { return saved; });
    });
    return withTimeout(work, 20000, '保存超时，请重试或检查手机存储空间');
}

function removeFiles(paths) {
    if (!isAvailable()) return Promise.resolve(0);
    let removed = 0;
    let chain = Promise.resolve();
    const list = Array.isArray(paths) ? paths : [];
    list.forEach(function (path) {
        chain = chain.then(function () {
            return new Promise(function (resolve) {
                fs().unlink({
                    filePath: path,
                    success: function () { removed += 1; resolve(); },
                    fail: function () { resolve(); },
                });
            });
        });
    });
    return chain.then(function () { return removed; });
}

function clearAllFiles() {
    if (!isAvailable()) return Promise.resolve(false);
    return new Promise(function (resolve) {
        fs().rmdir({
            dirPath: baseDir(),
            recursive: true,
            success: function () { resolve(true); },
            fail: function () { resolve(false); },
        });
    });
}

module.exports = {
    isAvailable,
    persistImages,
    removeFiles,
    clearAllFiles,
};
