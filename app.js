const PRIVACY_KEY = 'medical-bills.privacy-agreed.v1';

App({
    globalData: {
        appName: '我的身体单据',
        privacyAgreed: false,
    },

    onLaunch() {
        try {
            this.globalData.privacyAgreed = wx.getStorageSync(PRIVACY_KEY) === true;
        } catch (e) {
            this.globalData.privacyAgreed = false;
        }
    },

    hasPrivacyAgreed() {
        return this.globalData.privacyAgreed === true;
    },

    setPrivacyAgreed(value) {
        const agreed = value === true;
        this.globalData.privacyAgreed = agreed;
        try {
            wx.setStorageSync(PRIVACY_KEY, agreed);
        } catch (e) {
            // 本机存储不可用时，同意状态仅在当前会话内有效
        }
    },
});
