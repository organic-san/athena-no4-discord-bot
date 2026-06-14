const Discord = require('discord.js');
const modConfig = require('../utility/modConfig.js');
const gptConfig = require('../utility/gptConfig.js');
const moderation = require('../utility/moderation.js');

module.exports = {
    name: "guildDelete",
    event: Discord.Events.GuildDelete,
    async execute(client, guild) {
        // guild.available === false 代表伺服器暫時離線（Discord 端當機），並非真的被移除 → 不可刪資料
        if (guild.available === false) return;

        try {
            // 清除所有以 guild_id 為範圍的資料：處分／檢舉、設定／違規過多規則、聊天頻道（含各自快取）
            const counts = moderation.purgeGuild(guild.id);
            modConfig.purgeGuild(guild.id);
            gptConfig.clear(guild.id);
            console.log(`[guildDelete] 已清除伺服器資料：${guild.name ?? guild.id} (${guild.id})｜處分 ${counts.punishments}、檢舉 ${counts.reports}`);
        } catch (e) {
            console.error('[guildDelete] 清除伺服器資料失敗：', e);
        }
    }
};
