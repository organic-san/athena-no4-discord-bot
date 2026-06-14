const Discord = require('discord.js');
const { PermissionFlagsBits, InteractionContextType } = require('discord.js');
const DB = require('../../utility/database.js');
require('dotenv').config();

const db = DB.getConnection();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("close")
        .setDescription("結案目前的檢舉討論串")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: '只有管理員才能結案。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const report = db.prepare(`SELECT * FROM report WHERE thread_id = ?`).get(interaction.channelId);
        if (!report) {
            await interaction.reply({ content: '此指令僅能在檢舉討論串中使用。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }
        if (report.status === 'closed') {
            await interaction.reply({ content: `本案件（#${report.id}）已結案。`, flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const embed = new Discord.EmbedBuilder()
            .setTitle(`📋 結案處理 — 案件 #${report.id}`)
            .setColor(0x5865F2)
            .setDescription(`被檢舉者：<@${report.target_user_id}>\n請選擇後續操作。`);

        const row = new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setCustomId(`close:punish:${report.id}`)
                .setLabel('處分被檢舉者').setStyle(Discord.ButtonStyle.Danger).setEmoji('⚖️'),
            new Discord.ButtonBuilder()
                .setCustomId(`close:delmsg:${report.id}`)
                .setLabel('刪除原訊息').setStyle(Discord.ButtonStyle.Secondary).setEmoji('🗑️'),
            new Discord.ButtonBuilder()
                .setCustomId(`close:archive:${report.id}`)
                .setLabel('關閉討論串').setStyle(Discord.ButtonStyle.Secondary).setEmoji('🔒'),
        );

        await interaction.reply({ embeds: [embed], components: [row] });
    }
};
