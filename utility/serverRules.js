const gptConfig = require('./gptConfig.js');

// 從管理員以 /chatconfig rules 指定的頻道讀取伺服器規則全文，供 AI 工具 get_server_rules 使用。
// 規則不常變動，讀取結果快取 TTL_MS；重新設定規則頻道時立即失效。
const TTL_MS = 60 * 60 * 1000;
// 規則頻道應只放規則，取最近 100 則（Discord 單次上限）已足夠。
const FETCH_LIMIT = 100;
// 避免頻道內容異常龐大時整段塞進上下文。
const MAX_CHARS = 12000;

// guildId → { channelId, text, expiresAt }
const cache = new Map();

/** 訊息的文字內容；規則若由其他機器人以 embed 發布，內文在 embed 而非 content。 */
function textOf(msg) {
    const parts = [];
    if (msg.content) parts.push(msg.content);
    for (const e of msg.embeds) {
        if (e.title) parts.push(e.title);
        if (e.description) parts.push(e.description);
        for (const f of e.fields) parts.push(`${f.name}\n${f.value}`);
    }
    return parts.join('\n').trim();
}

module.exports = {
    /**
     * 取得規則全文。未設定規則頻道回傳 null；頻道已刪除或缺少權限時丟出 Discord API 錯誤。
     * @param {import('discord.js').Guild} guild
     */
    async get(guild) {
        const channelId = gptConfig.getRulesChannel(guild.id);
        if (!channelId) return null;

        const hit = cache.get(guild.id);
        if (hit && hit.channelId === channelId && hit.expiresAt > Date.now()) return hit.text;

        const channel = await guild.channels.fetch(channelId);
        if (!channel?.isTextBased()) throw new Error('規則頻道不是文字頻道');

        const messages = await channel.messages.fetch({ limit: FETCH_LIMIT });
        let text = [...messages.values()]
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map(textOf)
            .filter(Boolean)
            .join('\n\n');
        if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n（規則內容過長，以下已截斷）';

        cache.set(guild.id, { channelId, text, expiresAt: Date.now() + TTL_MS });
        return text;
    },

    invalidate(guildId) {
        cache.delete(guildId);
    },
};
