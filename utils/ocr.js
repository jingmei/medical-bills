// 端侧文字识别：微信 VisionKit OCR（基础库 2.27.0+，wx.createVKSession + runOCR）。
// 全程在手机本机完成：图片不上传、不调用云端接口、不需要密钥或服务器域名。
// 只做文字切分与日期 / 时间 / 标题的格式化，不解读内容、不生成任何意见或分析结论。
// 不支持、超时或识别失败时由调用方降级为手动填写，绝不阻塞归档流程。
//
// 真机兼容说明：官方示例中静态图片 OCR 使用 mode: 2（手动传入图像），
// 且在「图片里没有检测到文字」时 updateAnchors 可能完全不触发，
// 因此每一路会话都必须自带超时，并允许换一种会话参数再试一次。

var MIN_LIB = [2, 27, 0];
// 真机教训（B6）：runOCR 是同步调用，1600 边长的 RGBA 帧约 10MB，
// 部分安卓机在端侧推理时会把 JS 线程占死，导致倒计时、看门狗、所有按钮一起失效。
// 因此帧最大边压到 512（约 1MB），并先用 wx.compressImage 异步缩小原图。
var MAX_SIDE = 512;
var COMPRESS_WIDTH = 720;       // 先异步压缩原图，避免 drawImage 解码超大照片
var FRAME_TIMEOUT_MS = 4000;   // 读取图片 / 离屏 canvas 解码
var ATTEMPT_TIMEOUT_MS = 3500; // 单路会话等待结果
var HARD_TIMEOUT_MS = 9000;    // 全流程硬超时（仅对「回调不来」有效，救不了同步冻结）
var MAX_TAGS = 8;
var MAX_TIMES = 4;
var TAG_MAX_LEN = 14;
var MERGED_LINE_LEN = 45; // 端侧识别把整页文字挤成一整行时，通常已是不可用的乱码

// 当前进行中的会话，供页面「停止识别」主动取消。
var activeAttempt = null;

function cancel() {
    var finish = activeAttempt;
    activeAttempt = null;
    if (finish) {
        try { finish(new Error('已停止识别')); } catch (e) {}
    }
}

// 强特征：基本可以断定是一份单据的抬头；弱特征：正文里也可能出现的泛词。
var TITLE_STRONG_HINTS = [
    '告知书', '通知书', '知情书', '须知', '指引', '说明书', '清单', '明细', '汇总',
    '回执', '报表', '账单', '目录', '单据', '报告单', '发票', '记录表', '凭证'
];
var TITLE_WEAK_HINTS = ['说明', '记录', '资料', '文件', '票据', '报告', '证明', '预约', '单', '书', '表', '卡', '券'];
var TITLE_SKIP_PREFIX = [
    '尊敬的', '您好', '姓名', '日期', '时间', '电话', '联系电话', '备注', '温馨提示', '先生', '女士', '第'
];
var STOP_WORDS = [
    '合计', '总计', '小计', '金额', '数量', '日期', '时间', '编号', '序号', '页码',
    '备注', '名称', '单位', '单价', '合计金额', '总计金额', '先生', '女士', '联系电话',
    '尊敬的', '您好', '谢谢', '备注说明', '温馨提示'
];

function versionAtLeast(version, min) {
    var parts = String(version || '').split('.');
    for (var i = 0; i < min.length; i += 1) {
        var n = Number(parts[i]) || 0;
        if (n > min[i]) return true;
        if (n < min[i]) return false;
    }
    return true;
}

function isSupported() {
    if (typeof wx === 'undefined') return false;
    if (!wx.createVKSession || !wx.createOffscreenCanvas || !wx.getImageInfo) return false;
    try {
        var info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
        return versionAtLeast(info.SDKVersion, MIN_LIB);
    } catch (e) {
        return false;
    }
}

function normalizeDate(y, mo, d) {
    y = Number(y);
    mo = Number(mo);
    d = Number(d);
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return y + '-' + (mo < 10 ? '0' + mo : mo) + '-' + (d < 10 ? '0' + d : d);
}

// 只做日期格式识别，不判断日期含义；年份不完整时不猜测。
function extractDate(texts) {
    var joined = (texts || []).join(' ');
    var patterns = [
        /(?:^|[^\d])(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})\s*日?(?!\d)/,
        /(?:^|[^\d])(\d{4})(\d{2})(\d{2})(?!\d)/,
    ];
    for (var i = 0; i < patterns.length; i += 1) {
        var m = joined.match(patterns[i]);
        if (!m) continue;
        var value = normalizeDate(m[1], m[2], m[3]);
        if (value) return value;
    }
    return '';
}

// 提取图中出现的时间类短语：时刻、月日、时长、提前量。
// 仅为便于日后检索的标签，不做任何期限判断或提醒。
function extractTimes(texts) {
    var joined = (texts || []).join(' ');
    var found = [];

    function collect(pattern, formatter) {
        var re = new RegExp(pattern.source, pattern.flags || 'g');
        var match;
        var guard = 0;
        while ((match = re.exec(joined)) !== null) {
            // 防御：任何机型、任何粘贴文本都不允许正则循环失控占住 JS 线程
            guard += 1;
            if (guard > 500) break;
            var value = formatter ? formatter(match) : match[1];
            value = trimText(String(value || '').replace(/\s+/g, ''));
            if (!value || value.length > TAG_MAX_LEN) continue;
            if (/^\d+$/.test(value)) continue;
            if (/[室号楼层]/.test(value) && !/[:：月天日周]/.test(value)) continue;
            if (found.indexOf(value) < 0) found.push(value);
            if (found.length >= MAX_TIMES) return;
        }
    }

    collect(/(?:^|[^\d])(\d{1,2}\s*[:：]\s*[0-5]\d)(?!\d)/g);                     // 2:00 / 14:30
    collect(/(\d{1,2}\s*[-~—－至到]\s*\d{1,2}\s*个?\s*(?:月|天|日|周|小时))/g);   // 1-3个月
    collect(/(提前\s*[一二三四五六七八九十两\d]+\s*个?\s*(?:天|日|周|月))/g);       // 提前一至三天
    collect(/([一二三四五六七八九十两]\s*个?\s*月(?:内|后|前)?)/g);                 // 一个月 / 前后一个月
    collect(/(\d{1,2}\s*月\s*\d{1,2}\s*日)/g);                                  // 4月28日
    collect(/(\d{1,2}\s*[.\/]\s*\d{1,2})(?=\s*\d{1,2}\s*[:：])/g);              // 10.20 2:00 中的月日

    return found.slice(0, MAX_TIMES);
}

function trimText(text) {
    return String(text || '')
        .replace(/^[\s,，、;；:：|｜"'“”‘’()（）\[\]【】<>《》。．·]+/, '')
        .replace(/[\s,，、;；:：|｜"'“”‘’()（）\[\]【】<>《》。．·]+$/, '')
        .trim();
}

// 只保留像独立短语的碎片，丢掉句子残片与带标点噪声的截断串。
function isCleanTag(token) {
    if (!token || token.length < 2 || token.length > TAG_MAX_LEN) return false;
    if (/[（）()★☆※：:；;—、，,。.｜|]/.test(token)) return false;
    if (/(是|会|为|的|请|把|将|或|和|与|需|在|到)$/.test(token)) return false;
    if (/^\d+$/.test(token)) return false;
    // 汉字中间夹拉丁字母或数字几乎都是识别错字（如「2820h21个」「在享1加」），不作为检索标签
    if (/[A-Za-z]/.test(token) && /[\u4e00-\u9fa5]/.test(token)) return false;
    if (/[\u4e00-\u9fa5]\d|\d[\u4e00-\u9fa5]/.test(token)) return false;
    return true;
}

function isUsableLine(line) {
    if (!line) return false;
    if (line.length < 2 || line.length > 40) return false;
    if (/^\d+([.\-\/:：]\d+)*$/.test(line)) return false;  // 纯数字 / 编号 / 金额
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(line)) return false; // 纯符号
    if (/^\d{4}[-\/.年]\d{1,2}[-\/.月]\d{1,2}日?$/.test(line)) return false;
    // 汉字与数字紧挨（中间无空格）通常是识别错字，如「在享1加号单上时二」
    if (/[\u4e00-\u9fa5]\d|\d[\u4e00-\u9fa5]/.test(line)) return false;
    return true;
}

// 长行（例如手动输入时一整段挤在一行）按空格再切一遍，让标题片段也有机会被选中。
function titleCandidates(lines) {
    var out = [];
    for (var i = 0; i < Math.min(lines.length, 8); i += 1) {
        var line = trimText(lines[i]);
        if (line) out.push({ text: line, position: i });
        if (/\s/.test(line) && line.length > TAG_MAX_LEN) {
            line.split(/\s+/).forEach(function (piece) {
                var token = trimText(piece);
                if (token.length >= 4 && token.length <= 30) {
                    out.push({ text: token, position: i + 0.5 });
                }
            });
        }
    }
    return out;
}

// 识别质量评估（B8）：这台真机的端侧识别会把整页文字挤成一行乱码。
// 这类文字若被切碎成标签写进「关键字」，会污染检索且用户难以清理。
// 只做字形层面的噪声判断，不解读内容、不做语义判断。
function assessQuality(texts) {
    var lines = (texts || []).map(function (text) {
        return String(text || '').trim();
    }).filter(function (text) { return text !== ''; });
    var joined = lines.join(' ');
    var cjk = (joined.match(/[\u4e00-\u9fa5]/g) || []).length;
    var latinRuns = joined.match(/[A-Za-z]+/g) || [];
    var oddPunct = joined.match(/[;<>(){}\[\]|\\]/g) || [];
    var longest = 0;
    for (var i = 0; i < lines.length; i += 1) {
        if (lines[i].length > longest) longest = lines[i].length;
    }

    var score = 0;
    var reasons = [];
    if (longest > MERGED_LINE_LEN) { score += 1; reasons.push('文字挤成一整行'); }
    if (longest > 80) { score += 2; reasons.push('单行过长'); }
    if (latinRuns.length >= 2 && cjk >= 8) { score += 2; reasons.push('汉字中夹杂字母'); }
    if (oddPunct.length >= 2) { score += 2; reasons.push('含较多杂乱符号'); }
    if (cjk === 0 && joined.length > 0) { score += 2; reasons.push('没有可辨认汉字'); }
    // 同时存在可信的日期与时间，说明至少有一部分是结构化文字，降一档怀疑
    if (extractDate(lines) && extractTimes(lines).length > 0) score -= 1;

    return {
        garbled: score >= 3,
        score: score,
        reason: reasons.slice(0, 2).join('、') || '文字不清晰',
        longest: longest,
    };
}

// 标题打分：强特征 > 位置靠前 > 长度适中；日期行、时刻行、称呼行一律降权。
function pickTitle(lines) {
    var candidates = [];
    var items = titleCandidates(lines);
    var i;
    for (i = 0; i < items.length; i += 1) {
        var line = items[i].text;
        if (!isUsableLine(line) || line.length < 4 || line.length > 30) continue;
        var skipped = false;
        for (var s = 0; s < TITLE_SKIP_PREFIX.length; s += 1) {
            if (line.indexOf(TITLE_SKIP_PREFIX[s]) === 0) { skipped = true; break; }
        }
        if (skipped) continue;

        var score = Math.min(line.length, 16) / 10 - items[i].position * 1.5;
        var strong = false;
        for (var j = 0; j < TITLE_STRONG_HINTS.length; j += 1) {
            if (line.indexOf(TITLE_STRONG_HINTS[j]) >= 0) { strong = true; break; }
        }
        if (strong) score += 12;
        else {
            for (var k = 0; k < TITLE_WEAK_HINTS.length; k += 1) {
                if (line.indexOf(TITLE_WEAK_HINTS[k]) >= 0) { score += 4; break; }
            }
        }
        if (/^\d/.test(line)) score -= 10;          // 以数字开头的通常是日期行
        if (/[:：]/.test(line)) score -= 6;          // 含时刻或冒号的通常是正文
        if (/\d{4}[-\/.年]/.test(line)) score -= 8;  // 完整日期行
        candidates.push({ text: line, score: score });
    }
    if (!candidates.length) {
        for (i = 0; i < Math.min(lines.length, 5); i += 1) {
            var fallback = trimText(lines[i]);
            if (isUsableLine(fallback) && !/^\d/.test(fallback)) return fallback.slice(0, TAG_MAX_LEN);
        }
        return '';
    }
    candidates.sort(function (a, b) { return b.score - a.score; });
    return candidates[0].text.slice(0, TAG_MAX_LEN);
}

// 从识别出的文字行自动整理便于查找的标签：日期、标题、时间、若干短关键词。
// 纯文本切分与去重，不做语义理解、不生成任何结论。
function extractTags(texts, options) {
    var trusted = !!(options && options.trusted);
    var lines = (texts || []).map(function (text) {
        return String(text || '').trim();
    }).filter(function (text) { return text !== ''; });

    var quality = assessQuality(lines);
    // 用户主动粘贴 / 输入的文字一律信任：即使像乱码，也按原文提取，由用户自己取舍。
    var blocked = !trusted && quality.garbled;
    var date = extractDate(lines);
    var title = blocked ? '' : pickTitle(lines);
    var times = extractTimes(lines);
    var tags = [];

    function push(value) {
        var tag = trimText(value).slice(0, TAG_MAX_LEN);
        if (!tag || tag.length < 2 || tags.length >= MAX_TAGS) return;
        for (var i = 0; i < tags.length; i += 1) {
            if (tags[i].toLowerCase() === tag.toLowerCase()) return;
        }
        tags.push(tag);
    }

    // 用户最关心的三项优先占位：日期、标题、关键时间。
    if (date) push(date);
    if (title) push(title);
    times.forEach(function (time) { push(time); });

    var pieces = [];
    // 乱码整行不再切碎成标签：碎片标签会被写进「关键字」，污染检索且难以清理。
    // 日期与时刻由严格正则提取，即使文字不清晰也仍然可信，予以保留。
    if (!blocked) {
        lines.forEach(function (line) {
            var cleaned = line.replace(/\d{4}\s*[-\/.年]\s*\d{1,2}\s*[-\/.月]\s*\d{1,2}\s*日?/g, ' ');
            cleaned.split(/[\s,，、;；:：|｜\/\\]+/).forEach(function (part) {
                var token = trimText(part);
                if (isCleanTag(token)) pieces.push(token);
            });
        });
        lines.forEach(function (line) {
            var whole = trimText(line);
            if (isCleanTag(whole)) pieces.push(whole);
        });

        for (var k = 0; k < pieces.length && tags.length < MAX_TAGS; k += 1) {
            var token = pieces[k];
            if (STOP_WORDS.indexOf(token) < 0
                && !/^\d{4}[-\/.年]\d{1,2}/.test(token)
                && !/^[\d.\-\/:：]+$/.test(token)
                && !/^(第|共|含)\S*$/.test(token)) {
                push(token);
            }
        }
    }

    return { date: date, title: title, times: times, tags: tags, quality: quality };
}

function analyze(texts, options) {
    // trusted=true 用于用户主动粘贴 / 输入的文字：即使夹杂错字，也照样提取标签，
    // 由用户自己决定取舍；本机自动识别默认开启乱码闸门。
    var trusted = !!(options && options.trusted);
    var result = extractTags(texts, { trusted: trusted });
    result.lines = (texts || []).map(function (text) {
        return String(text || '').trim();
    }).filter(function (text) { return text !== ''; }).slice(0, 12);
    return result;
}

// 先用系统接口把原图异步缩小：压缩发生在客户端线程，不占 JS 线程，
// 避免 drawImage 直接解码手机相机的大图（常见的 4000×3000 以上）。
function compressSource(src) {
    return new Promise(function (resolve) {
        if (typeof wx === 'undefined' || !wx.compressImage) { resolve(src); return; }
        var done = false;
        var timer = setTimeout(function () {
            if (done) return;
            done = true;
            resolve(src);
        }, 2500);
        function finish(path) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(path || src);
        }
        try {
            wx.compressImage({
                src: src,
                quality: 72,
                compressedWidth: COMPRESS_WIDTH,
                success: function (res) { finish(res && res.tempFilePath); },
                fail: function () { finish(src); },
            });
        } catch (e) {
            finish(src);
        }
    });
}

// 把本地图片解码为 runOCR 需要的 RGBA 帧。每一步都有超时，避免等待永不触发的回调。
// 解码与会话启动之间都让出宏任务，防止同步推理把 UI 线程连同看门狗一起冻住。
function frameFromImage(src) {
    return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
            done(new Error('图片读取超时，请手动填写或重试'));
        }, FRAME_TIMEOUT_MS);

        function done(error, frame) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error); else resolve(frame);
        }

        function isBlankFrame(data) {
            try {
                var bytes = new Uint8Array(data.buffer || data);
                var len = bytes.length;
                var varied = false;
                var step = Math.max(4, Math.floor(len / 400 / 4) * 4);
                for (var i = 0; i < len - 4; i += step) {
                    if (bytes[i + 3] !== 0 && bytes[i] !== bytes[0]) { varied = true; break; }
                }
                return !varied;
            } catch (e) {
                return false;
            }
        }

        function decode(info) {
            var width = Math.max(1, Math.round(info.width || 1));
            var height = Math.max(1, Math.round(info.height || 1));
            var scale = Math.min(1, MAX_SIDE / Math.max(width, height));
            width = Math.max(1, Math.round(width * scale));
            height = Math.max(1, Math.round(height * scale));
            var canvas;
            try {
                canvas = wx.createOffscreenCanvas({ type: '2d', width: width, height: height });
            } catch (e) {
                done(new Error('当前环境不支持端侧文字识别，请手动填写'));
                return;
            }
            var img;
            try {
                img = canvas.createImage();
            } catch (e) {
                done(new Error('当前环境不支持端侧文字识别，请手动填写'));
                return;
            }
            img.onload = function () {
                // 让出一个宏任务：先让页面渲染完成、让点击事件有机会被处理
                setTimeout(function () {
                    try {
                        var ctx = canvas.getContext('2d');
                        ctx.clearRect(0, 0, width, height);
                        ctx.drawImage(img, 0, 0, width, height);
                        var data = ctx.getImageData(0, 0, width, height);
                        if (isBlankFrame(data.data)) {
                            done(new Error('图片解码为空，请换一张清晰的照片或用「手动输入文字」'));
                            return;
                        }
                        var frame = { frameBuffer: data.data.buffer, width: width, height: height };
                        // 再让出一个宏任务：避免 Promise 微任务把会话启动拉进同一段同步执行
                        setTimeout(function () { done(null, frame); }, 16);
                    } catch (e) {
                        done(new Error('图片解码失败，请手动输入文字或重试'));
                    }
                }, 16);
            };
            img.onerror = function () { done(new Error('图片解码失败，请手动输入文字或重试')); };
            try {
                img.src = src;
            } catch (e) {
                done(new Error('图片读取失败，请手动输入文字'));
            }
        }

        compressSource(src).then(function (path) {
            if (settled) return;
            try {
                wx.getImageInfo({
                    src: path,
                    success: decode,
                    fail: function (error) {
                        done(new Error('无法读取图片尺寸（' + ((error && error.errMsg) || '未知') + '），请手动输入文字'));
                    },
                });
            } catch (e) {
                done(new Error('无法读取图片尺寸，请手动输入文字'));
            }
        });
    });
}

// 单路会话。onTexts 在 updateAnchors 的原生回调栈里同步调用：
// 结果一到达就交给页面复位状态并落盘，不等 Promise 微任务，
// 因为 runOCR 后续的同步推理可能占住 JS 线程，微任务永远排不上。
function attempt(frame, timeoutMs, onTexts) {
    return new Promise(function (resolve, reject) {
        var session = null;
        var handler = null;
        var timer = null;
        var settled = false;

        function finish(error, texts) {
            if (settled) return;
            settled = true;
            if (timer !== null && timer !== undefined) clearTimeout(timer);
            timer = null;
            if (activeAttempt === finish) activeAttempt = null;

            // 关键修复（B7）：finish 常在 updateAnchors 的原生回调栈里被触发，
            // 此时同步调用 session.off / session.destroy，客户端原生层正在分发回调，
            // 两侧互等就会把 JS 线程冻死 —— 表现为「结果回来了但状态不复位、所有按钮失效」。
            // 会话清理一律推迟到下一个宏任务，且必须先 resolve 再清理。
            var pendingSession = session;
            var pendingHandler = handler;
            session = null;
            handler = null;
            if (pendingSession) {
                setTimeout(function () {
                    try {
                        if (pendingHandler && pendingSession.off) pendingSession.off('updateAnchors', pendingHandler);
                    } catch (e) {}
                    try {
                        if (pendingSession.destroy) pendingSession.destroy();
                    } catch (e) {}
                }, 0);
            }
            if (error) reject(error); else resolve(texts || []);
        }

        timer = setTimeout(function () {
            finish(new Error('本机识别未返回结果'));
        }, timeoutMs);
        activeAttempt = finish;

        try {
            var options = { track: { OCR: { mode: 2 } } };
            session = wx.createVKSession(options);
        } catch (e) {
            finish(new Error('端侧识别初始化失败'));
            return;
        }
        if (!session || !session.runOCR || !session.start || !session.on) {
            finish(new Error('当前设备不支持本机识别'));
            return;
        }

        handler = function (anchors) {
            var list = Array.isArray(anchors) ? anchors : ((anchors && anchors.anchors) || []);
            var texts = list.map(function (anchor) {
                if (typeof anchor === 'string') return anchor.trim();
                return String((anchor && (anchor.text || anchor.content)) || '').trim();
            }).filter(function (text) { return text !== ''; });
            // 结果一到达就同步交给调用方（仍在原生回调栈内），不等 Promise 微任务。
            if (onTexts) {
                try { onTexts(texts); } catch (e) {}
            }
            finish(null, texts);
        };

        try {
            session.on('updateAnchors', handler);
            session.start(function (errno) {
                if (errno) {
                    finish(new Error('端侧识别未启动（' + errno + '）'));
                    return;
                }
                // runOCR 是同步推理，延后到独立宏任务；会话引用先存局部，
                // 避免 finish 已经把外层 session 置空后这里拿到 null。
                var currentSession = session;
                setTimeout(function () {
                    if (settled || !currentSession) return;
                    try {
                        currentSession.runOCR(frame);
                    } catch (e) {
                        finish(new Error('识别调用失败'));
                    }
                }, 30);
            });
        } catch (e) {
            finish(new Error('识别调用失败'));
        }
    });
}

function recognize(src, onTexts) {
    if (!isSupported()) {
        return Promise.reject(new Error('当前微信版本不支持端侧文字识别，请用「手动输入文字」'));
    }
    cancel(); // 清掉上一次可能还挂着的会话
    return new Promise(function (resolve, reject) {
        var settled = false;
        var hardTimer = setTimeout(function () {
            if (settled) return;
            settled = true;
            cancel();
            reject(new Error('本机识别未返回结果，请直接用「手动输入文字」'));
        }, HARD_TIMEOUT_MS);

        function finish(error, texts) {
            if (settled) return;
            settled = true;
            clearTimeout(hardTimer);
            if (error) reject(error); else resolve(texts || []);
        }

        frameFromImage(src).then(function (frame) {
            if (settled) return;
            // 只跑一路：两路串行会把端侧推理重复做一遍，反而更容易占住 JS 线程。
            attempt(frame, ATTEMPT_TIMEOUT_MS, onTexts).then(function (texts) {
                finish(null, texts);
            }, function (error) {
                finish(new Error('本机识别未返回文字，请直接用「手动输入文字」'));
            });
        }).catch(function (error) {
            finish(error);
        });
    });
}

module.exports = {
    isSupported: isSupported,
    recognize: recognize,
    cancel: cancel,
    extractDate: extractDate,
    extractTimes: extractTimes,
    extractTags: extractTags,
    assessQuality: assessQuality,
    analyze: analyze,
    versionAtLeast: versionAtLeast,
    MAX_TAGS: MAX_TAGS,
};
