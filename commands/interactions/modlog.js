const Discord = require('discord.js');
const { PermissionFlagsBits, InteractionContextType } = require('discord.js');
const moderation = require('../../utility/moderation.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("modlog")
        .setDescription("查詢某成員的處分紀錄")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(o => o.setName("user").setDescription("查詢對象").setRequired(true)),

    async execute(client, interaction) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: '只有管理員才能查詢處分紀錄。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const user = interaction.options.getUser('user');
        const records = moderation.getUserPunishments(interaction.guildId, user.id, 25);

        if (records.length === 0) {
            await interaction.reply({ content: `<@${user.id}> 目前沒有任何處分紀錄。`, flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const activeWarns = moderation.countWarns(interaction.guildId, user.id, 24 * 365 * 10); // 全部未撤銷 warn
        const embed = moderation.buildModlogEmbed(user, records, activeWarns);
        await interaction.reply({ embeds: [embed] });
    }
};
