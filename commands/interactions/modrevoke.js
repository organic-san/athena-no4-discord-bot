const Discord = require('discord.js');
const { PermissionFlagsBits, InteractionContextType } = require('discord.js');
const moderation = require('../../utility/moderation.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("modrevoke")
        .setDescription("撤回一筆處分紀錄（禁言會同時解除）")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addIntegerOption(o => o.setName("id").setDescription("處分編號").setRequired(true).setMinValue(1)),

    async execute(client, interaction) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: '只有管理員才能撤回處分。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const id = interaction.options.getInteger('id');
        const p = moderation.getPunishment(id);
        if (!p || p.guild_id !== interaction.guildId) {
            await interaction.reply({ content: `找不到本伺服器的處分 #${id}。`, flags: Discord.MessageFlags.Ephemeral });
            return;
        }
        if (p.revoked) {
            await interaction.reply({ content: `處分 #${id} 已經是撤回狀態。`, flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });

        // 統一撤回流程：標記 + 解除禁言/unban + 於處分頻道發布撤回標示
        const res = await moderation.revokePunishmentFull(interaction.guild, id, interaction.user.id);
        if (!res.ok) {
            await interaction.editReply(res.error || '撤回失敗。');
            return;
        }
        const warn = res.unmuteErr ? `\n⚠️ 解除禁言失敗：${res.unmuteErr}` : res.unbanErr ? `\n⚠️ 解除停權失敗：${res.unbanErr}` : '';
        await interaction.editReply(`✅ 已撤回處分 #${id}，並已於處分頻道發布撤回標示。${warn}`);
    }
};
