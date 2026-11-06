// 腾讯官方「流量主」广告位配置。
//
// 使用微信官方 <ad> 组件，不接入任何第三方广告 SDK。
// 开通前请保持 enabled = false：没有有效广告位 ID 时渲染 <ad> 会在控制台报错。
//
// 开通步骤：
//   1. 小程序后台「推广 → 流量主」达到开通条件后申请；
//   2. 创建 Banner 广告位，拿到形如 adunit-xxxxxxxx 的广告位 ID；
//   3. 把 ID 填入 unitId，并将 enabled 改为 true；
//   4. 重新提交审核发布。
//
// 合规约定：广告只出现在首页列表底部，不进入上传流程与单据详情页；
// 用户保存的单据数据不用于广告定向，也不与任何第三方共享。
const AD_CONFIG = {
    enabled: false,
    unitId: '',
    adType: 'banner',
};

function getBannerAd() {
    const validId = typeof AD_CONFIG.unitId === 'string'
        && AD_CONFIG.unitId.indexOf('adunit-') === 0;
    return {
        enabled: AD_CONFIG.enabled === true && validId,
        unitId: AD_CONFIG.unitId,
        adType: AD_CONFIG.adType,
    };
}

module.exports = {
    AD_CONFIG,
    getBannerAd,
};
