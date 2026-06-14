const Discord = require('discord.js');
const { InteractionContextType } = require('discord.js');
const moderation = require('../../utility/moderation.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("modlog-me")
        .setDescription("查詢自己的處分紀錄")
        .setContexts(InteractionContextType.Guild),

    async execute(client, interaction) {
        const user = interaction.user;
        const records = moderation.getUserPunishments(interaction.guildId, user.id, 25);

        if (records.length === 0) {
            await interaction.reply({ content: '你目前沒有任何處分紀錄。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const activeWarns = moderation.countWarns(interaction.guildId, user.id, 24 * 365 * 10);
        const embed = moderation.buildModlogEmbed(user, records, activeWarns);
        await interaction.reply({ embeds: [embed], flags: Discord.MessageFlags.Ephemeral });
    }
};
