const DB = require('./database.js');
require('dotenv').config();

const db = DB.getConnection();

// 每個觸發頻道一列（支援多頻道）。既有資料庫不會經過 createDB.js，故在此 idempotent 補建。
db.prepare(`CREATE TABLE IF NOT EXISTS gpt_channel (
    guild_id TEXT,
    channel_id TEXT,
    PRIMARY KEY (guild_id, channel_id)
)`).run();

// 自舊的單頻道 gpt_config 表遷移（若存在）
try {
    const rows = db.prepare(`SELECT guild_id, channel_id FROM gpt_config WHERE channel_id IS NOT NULL`).all();
    for (const r of rows) {
        db.prepare(`INSERT OR IGNORE INTO gpt_channel (guild_id, channel_id) VALUES (?, ?)`).run(r.guild_id, r.channel_id);
    }
    if (rows.length) db.prepare(`DELETE FROM gpt_config`).run();
} catch { /* 無舊表則略過 */ }

// guildId → string[]（每則訊息都會讀取，異動時失效）
const cache = new Map();

function load(guildId) {
    if (cache.has(guildId)) return cache.get(guildId);
    const list = db.prepare(`SELECT channel_id FROM gpt_channel WHERE guild_id = ?`).all(guildId).map(r => r.channel_id);
    cache.set(guildId, list);
    return list;
}

module.exports = {
    /** 取得某伺服器所有聊天頻道（陣列；未設定為空陣列）。 */
    getChannels(guildId) {
        return load(guildId);
    },

    /** 該頻道是否允許 @ 我聊天。 */
    isAllowed(guildId, channelId) {
        return load(guildId).includes(channelId);
    },

    addChannel(guildId, channelId) {
        const info = db.prepare(`INSERT OR IGNORE INTO gpt_channel (guild_id, channel_id) VALUES (?, ?)`).run(guildId, channelId);
        cache.delete(guildId);
        return info.changes > 0; // false 表示已存在
    },

    removeChannel(guildId, channelId) {
        const info = db.prepare(`DELETE FROM gpt_channel WHERE guild_id = ? AND channel_id = ?`).run(guildId, channelId);
        cache.delete(guildId);
        return info.changes > 0;
    },

    clear(guildId) {
        db.prepare(`DELETE FROM gpt_channel WHERE guild_id = ?`).run(guildId);
        cache.delete(guildId);
    },
};
