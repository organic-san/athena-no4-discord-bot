const fs = require('fs');
const { GoogleGenAI, ApiError } = require('@google/genai');
const modelConfig = require('./modelConfig.js');
require('dotenv').config();

// 模型、thinkingLevel、maxOutputTokens、單價皆由 modelConfig 提供（config/models.json），
// 每次呼叫時讀取，切換模型後立即生效。
// 注意：thinking token 會一併計入 maxOutputTokens，調高 thinkingLevel 時輸出上限必須跟著調高，
// 否則額度會被 thinking 吃光而回傳空內容（finishReason = MAX_TOKENS）。

// 暫時性錯誤：值得退避重試。其餘（400 參數錯誤、403 金鑰問題等）重試沒有意義。
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// system prompt 每則訊息都會用到，啟動後只讀一次，不在 event loop 上重複同步讀檔。
let promptTemplate = null;

/** 取得錯誤的 HTTP 狀態碼；非 API 錯誤（如網路層失敗）回傳 null。 */
function statusOf(err) {
    // SDK 對所有 4xx/5xx 回應都會丟出帶 status 的 ApiError。
    // 同時比對 name，避免 CJS/ESM 各載入一份時 instanceof 失效。
    if ((err instanceof ApiError || err?.name === 'ApiError') && typeof err.status === 'number') {
        return err.status;
    }
    return typeof err?.status === 'number' ? err.status : null;
}

/** 依模型設定組出 thinking 與輸出上限。 */
function generationParams(profile) {
    return {
        maxOutputTokens: profile.maxOutputTokens,
        thinkingConfig: { thinkingLevel: profile.thinkingLevel },
    };
}

module.exports = {
    ai,

    /** 目前使用中的模型名稱。 */
    model() {
        return modelConfig.current().name;
    },

    /** 取得填入機器人名稱後的 system prompt。 */
    systemPrompt(botName) {
        if (promptTemplate === null) promptTemplate = fs.readFileSync('./prompts/default.txt', 'utf-8');
        return promptTemplate.replaceAll('{botName}', botName);
    },

    /** 共用的 generation config；extra 用於各入口的差異（例如 tools）。 */
    config(botName, extra = {}) {
        return {
            systemInstruction: this.systemPrompt(botName),
            ...generationParams(modelConfig.current()),
            ...extra,
        };
    },

    /**
     * 以指定模型設定送一次極短的請求，確認模型名稱、thinkingLevel 等組合可用。
     * 失敗時丟出原始錯誤；用於切換模型前，避免切過去後每則訊息都失敗。
     */
    async probe(profile) {
        await ai.models.generateContent({
            model: profile.name,
            contents: 'ping',
            config: generationParams(profile),
        });
    },

    statusOf,

    /** 是否為「服務忙碌／額度用盡」這類該對使用者說軟話的錯誤。 */
    isOverloaded(err) {
        const status = statusOf(err);
        return status === 429 || status === 503;
    },

    /** 對暫時性錯誤退避重試（0.5s、1s，含抖動避免重試同時湧入）。 */
    async withRetry(fn, retries = 2) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn();
            } catch (err) {
                if (attempt >= retries || !RETRYABLE.has(statusOf(err))) throw err;
                const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
                console.warn(`[gemini] ${statusOf(err)}，${delay}ms 後重試（第 ${attempt + 1}/${retries} 次）`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    },

    /**
     * 由 usageMetadata 取出計費用的 token 數與依目前模型單價估算的費用（USD）。
     * thinking token 不含在 candidatesTokenCount 內，但 Google 依 output 費率計價，須合併。
     */
    usageOf(response) {
        const usage = response?.usageMetadata;
        const inputTokens = usage?.promptTokenCount || 0;
        const outputTokens = (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0);
        const { inputPricePerM, outputPricePerM } = modelConfig.current();
        return {
            inputTokens,
            outputTokens,
            cost: (inputTokens / 1_000_000) * inputPricePerM + (outputTokens / 1_000_000) * outputPricePerM,
        };
    },

    /** 回應沒有可用文字時的原因說明；正常有內容則回傳 null。 */
    emptyReason(response) {
        if (response?.text && response.text.trim()) return null;

        const finish = response?.candidates?.[0]?.finishReason;
        if (finish === 'MAX_TOKENS') {
            return `回應長度超過上限（maxOutputTokens = ${modelConfig.current().maxOutputTokens}，thinking 也會佔用此額度）`;
        }

        const blocked = response?.promptFeedback?.blockReason;
        return blocked || finish || '未知原因';
    },
};
