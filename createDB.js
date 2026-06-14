const DB = require('./utility/database.js');
require('dotenv').config();

module.exports = () => {
    console.log('Creating database...');
    const db = DB.getConnection();

    db.prepare(`CREATE TABLE IF NOT EXISTS user (
        id TEXT PRIMARY KEY,
        name TEXT
    )`).run();

    db.prepare(`CREATE TABLE IF NOT EXISTS daily_usage (
        date TEXT,
        user_id TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        request_count INTEGER DEFAULT 0,
        PRIMARY KEY (date, user_id),
        FOREIGN KEY (user_id) REFERENCES user(id)
    );`).run();

    // 聊天觸發頻道（per-guild，可多個；與審核系統分離）
    db.prepare(`CREATE TABLE IF NOT EXISTS gpt_channel (
        guild_id TEXT,
        channel_id TEXT,
        PRIMARY KEY (guild_id, channel_id)
    )`).run();

    // ── 社群安全與審核系統 ──
    // 檢舉紀錄（長期保存，僅存 metadata 與 Discord 物件 ID，不存訊息原文）
    db.prepare(`CREATE TABLE IF NOT EXISTS report (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        reporter_id TEXT,
        target_user_id TEXT,
        target_msg_id TEXT,
        channel_id TEXT,
        thread_id TEXT,
        thread_evidence_msg_id TEXT,
        status TEXT DEFAULT 'open',
        punishment_id INTEGER,
        created_at TEXT,
        closed_at TEXT
    );`).run();

    // 處分紀錄（含已撤銷，永久保存）
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

    // per-guild 設定（單列多欄）
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

    // 違規過多自動處分規則（一伺服器多條）
    db.prepare(`CREATE TABLE IF NOT EXISTS mod_escalation_rule (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        window_hours INTEGER,
        warn_threshold INTEGER,
        action TEXT,
        duration_min INTEGER
    );`).run();
}