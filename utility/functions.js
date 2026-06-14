require('dotenv').config();

// Gemini 計費（USD / 每百萬 token）。預設為 Gemini Flash-Lite 的參考費率，
// 實際費率依使用的模型而定，可用 .env 的 GEMINI_INPUT_PRICE_PER_M /
// GEMINI_OUTPUT_PRICE_PER_M 覆寫（請以 Google 官方定價為準）。
const INPUT_PRICE_PER_M = parseFloat(process.env.GEMINI_INPUT_PRICE_PER_M ?? '0.075');
const OUTPUT_PRICE_PER_M = parseFloat(process.env.GEMINI_OUTPUT_PRICE_PER_M ?? '0.30');

module.exports = {
    calcGeminiCost(inputTokens, outputTokens) {
        return (inputTokens / 1_000_000) * INPUT_PRICE_PER_M +
               (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_M;
    },

    sliceByWordCount(str, count) {
        const sends = [];
        while (str.length > count) {
            sends.push(str.slice(0, count));
            str = str.slice(count);
        }
        sends.push(str);
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
