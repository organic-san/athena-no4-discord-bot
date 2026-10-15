require('dotenv').config();

module.exports = {
    sliceByWordCount(str, count) {
        // 容錯：str 可能為 undefined（如 AI 回應無文字片段），統一轉成字串避免讀 .length 崩潰。
        let s = String(str ?? '');
        const sends = [];
        while (s.length > count) {
            sends.push(s.slice(0, count));
            s = s.slice(count);
        }
        sends.push(s);
        return sends;
    },

    localISOTimeNow() {
        const tzoffset = (new Date()).getTimezoneOffset() * 60000;
        return (new Date(Date.now() - tzoffset)).toISOString().slice(0, 19);
    },

    getLocalDate() {
        return this.localISOTimeNow().slice(0, 10); // YYYY-MM-DD
    },

    getLocalYearMonth() {
        return this.localISOTimeNow().slice(0, 7); // YYYY-MM
    },
};
