const fs = require('fs');
const DB = require('./database.js');

// 模型相關的非機密參數一律放在 config/models.json（隨 git 部署），不再讀 .env。
// 每個模型是一組完整設定：thinking 等級是否支援、輸出上限、單價都跟模型綁定，
// 分開調整容易搭錯（例如 gemini-3.8-flash 不支援 MINIMAL，會直接回 400）。
// 目前選用哪個模型存在資料庫，由 /system model 切換，立即生效、不必重啟。
const FILE = './config/models.json';
const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];

const db = DB.getConnection();

// 既有資料庫不會經過 createDB.js，故在此 idempotent 補建。
db.prepare(`CREATE TABLE IF NOT EXISTS bot_setting (
    key TEXT PRIMARY KEY,
    value TEXT
)`).run();

let presets = null;
let active = null;

/** 讀取並驗證 models.json；格式有誤直接丟例外，由呼叫端決定是否沿用舊設定。 */
function readPresets() {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    if (!data.models || !data.models[data.default]) {
        throw new Error(`${FILE}：default 必須是 models 裡的其中一個`);
    }
    for (const [name, p] of Object.entries(data.models)) {
        if (!THINKING_LEVELS.includes(p.thinkingLevel)) {
            throw new Error(`${FILE}：${name} 的 thinkingLevel 須為 ${THINKING_LEVELS.join('/')}`);
        }
        if (!Number.isInteger(p.maxOutputTokens) || p.maxOutputTokens <= 0) {
            throw new Error(`${FILE}：${name} 的 maxOutputTokens 須為正整數`);
        }
        if (typeof p.inputPricePerM !== 'number' || typeof p.outputPricePerM !== 'number') {
            throw new Error(`${FILE}：${name} 的 inputPricePerM / outputPricePerM 須為數字`);
        }
    }
    return data;
}

function profileOf(name) {
    return { name, ...presets.models[name] };
}

/** 依資料庫中的選擇決定目前模型；選擇的模型已從 models.json 移除時退回 default。 */
function resolveActive() {
    const stored = db.prepare(`SELECT value FROM bot_setting WHERE key = 'model'`).get()?.value;
    if (stored && !presets.models[stored]) {
        console.warn(`[modelConfig] 資料庫選用的 ${stored} 不在 ${FILE}，改用預設 ${presets.default}`);
    }
    active = profileOf(stored && presets.models[stored] ? stored : presets.default);
}

presets = readPresets();
resolveActive();

module.exports = {
    /** 目前使用中的模型設定：{ name, thinkingLevel, maxOutputTokens, inputPricePerM, outputPricePerM }。 */
    current() {
        return active;
    },

    /** models.json 中可選的模型名稱。 */
    list() {
        return Object.keys(presets.models);
    },

    /** 取得指定模型的設定；不存在回傳 null。 */
    get(name) {
        return presets.models[name] ? profileOf(name) : null;
    },

    /** 重新讀取 models.json（git pull 後呼叫）。格式有誤時丟例外並保留原設定。 */
    reload() {
        presets = readPresets();
        resolveActive();
    },

    /** 切換模型並寫入資料庫。呼叫前應確認模型可用（見 gemini.probe）。 */
    set(name) {
        if (!presets.models[name]) throw new Error(`${name} 不在 ${FILE}`);
        db.prepare(`INSERT INTO bot_setting (key, value) VALUES ('model', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(name);
        active = profileOf(name);
    },
};
