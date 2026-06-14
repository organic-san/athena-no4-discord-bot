const DB = require('./database.js');
require('dotenv').config();

const db = DB.getConnection();

// 確保新表存在（既有資料庫不會經過 createDB.js，故在此 idempotent 補建）
function ensureTables() {
    db.prepare(`CREATE TABLE IF NOT EXISTS report (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        reporter_id TEXT,
        target_user_id TEXT,
        target_msg_id TEXT,
        channel_id TEXT,
        thread_id TEXT,
        status TEXT DEFAULT 'open',
        punishment_id INTEGER,
        created_at TEXT,
        closed_at TEXT
    );`).run();

    db.prepare(`CREATE TABLE IF NOT EXISTS punishment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        target_user_id TEXT,
        type TEXT,
        duration_min INTEGER,
        reason TEXT,
        evidence_msg_id TEXT,
        source TEXT,
        executor_id TEXT,
        revoked INTEGER DEFAULT 0,
        revoked_at TEXT,
        created_at TEXT
    );`).run();

    db.prepare(`CREATE TABLE IF NOT EXISTS mod_config (
        guild_id TEXT PRIMARY KEY,
        admin_notify_channel_id TEXT,
        admin_role_id TEXT,
        punish_channel_id TEXT,
        report_thread_parent_id TEXT,
        detection_enabled INTEGER DEFAULT 0,
        detection_mute_min INTEGER DEFAULT 10,
        context_before INTEGER DEFAULT 20,
        context_after INTEGER DEFAULT 5,
        report_rate_limit TEXT DEFAULT '5/5'
    );`).run();

    db.prepare(`CREATE TABLE IF NOT EXISTS mod_escalation_rule (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        window_hours INTEGER,
        warn_threshold INTEGER,
        action TEXT,
        duration_min INTEGER
    );`).run();
}
ensureTables();

// 既有資料庫（已建表）需補上後加的欄位
function ensureColumn(table, column, type) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
    }
}
ensureColumn('mod_config', 'admin_role_id', 'TEXT');
ensureColumn('report', 'thread_evidence_msg_id', 'TEXT');

const DEFAULTS = {
    admin_notify_channel_id: null,
    admin_role_id: null,
    punish_channel_id: null,
    report_thread_parent_id: null,
    detection_enabled: 0,
    detection_mute_min: 10,
    context_before: 20,
    context_after: 5,
    report_rate_limit: '5/5',
};

const ALLOWED_KEYS = Object.keys(DEFAULTS);

// 設定快取（每訊息偵測會頻繁讀取，set 時失效）
const cache = new Map();

module.exports = {
    DEFAULTS,
    ALLOWED_KEYS,

    /**
     * 取得某伺服器的設定（與預設值合併）。
     * @param {string} guildId
     */
    get(guildId) {
        if (cache.has(guildId)) return cache.get(guildId);
        const row = db.prepare(`SELECT * FROM mod_config WHERE guild_id = ?`).get(guildId);
        const conf = { guild_id: guildId, ...DEFAULTS, ...(row || {}) };
        cache.set(guildId, conf);
        return conf;
    },

    /**
     * 設定單一欄位（upsert）。
     * @param {string} guildId
     * @param {string} key
     * @param {*} value
     */
    set(guildId, key, value) {
        if (!ALLOWED_KEYS.includes(key)) throw new Error(`未知的設定欄位：${key}`);
        db.prepare(`INSERT INTO mod_config (guild_id, ${key}) VALUES (?, ?)
            ON CONFLICT(guild_id) DO UPDATE SET ${key} = excluded.${key}`).run(guildId, value);
        cache.delete(guildId);
    },

    /** 通報時標註管理員身分組用的 content 與 allowedMentions（未設定則為空）。 */
    adminMention(guildId) {
        const conf = this.get(guildId);
        if (!conf.admin_role_id) return { content: undefined, allowedMentions: undefined };
        return { content: `<@&${conf.admin_role_id}>`, allowedMentions: { roles: [conf.admin_role_id] } };
    },

    /** 解析檢舉速率設定 `次數/分鐘` → { count, minutes } */
    parseRateLimit(guildId) {
        const conf = this.get(guildId);
        const [count, minutes] = String(conf.report_rate_limit).split('/').map(Number);
        return { count: count || 5, minutes: minutes || 5 };
    },

    // ── 違規過多規則 ──
    // 排序決定觸發優先序（checkEscalation 取第一條達標者）：
    //   1) 先依處分嚴重度由重到輕（ban > kick > mute > warn）
    //   2) 同嚴重度再依達標門檻由高到低
    // 確保「重罰優先」且「速升規則不被同門檻的輕罰搶先」。
    getRules(guildId) {
        return db.prepare(
            `SELECT * FROM mod_escalation_rule WHERE guild_id = ?
             ORDER BY
               CASE action WHEN 'ban' THEN 4 WHEN 'kick' THEN 3 WHEN 'mute' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END DESC,
               warn_threshold DESC`
        ).all(guildId);
    },

    addRule(guildId, windowHours, warnThreshold, action, durationMin) {
        const info = db.prepare(
            `INSERT INTO mod_escalation_rule (guild_id, window_hours, warn_threshold, action, duration_min)
             VALUES (?, ?, ?, ?, ?)`
        ).run(guildId, windowHours, warnThreshold, action, durationMin ?? null);
        return info.lastInsertRowid;
    },

    removeRule(guildId, ruleId) {
        const info = db.prepare(
            `DELETE FROM mod_escalation_rule WHERE id = ? AND guild_id = ?`
        ).run(ruleId, guildId);
        return info.changes > 0;
    },
};
