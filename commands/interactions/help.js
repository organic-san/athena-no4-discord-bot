const Discord = require('discord.js');
const commandList = require('../../utility/commandList.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("help")
        .setDescription("顯示可用指令說明"),

    async execute(client, interaction) {
        const embed = new Discord.EmbedBuilder()
            .setTitle(`${client.user.username} - 晴的機器人 Bot`)
            .setColor(0x4285F4)
            .setDescription("以下是可以使用的 slash 指令：")
            .addFields(commandList)
            .setFooter({ text: "作者：@organic_kaami" });

        const row = new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setLabel("隱私權條款")
                .setStyle(Discord.ButtonStyle.Link)
                .setURL("https://github.com/organic-san/athena-no4-discord-bot/blob/main/privacy.md")
                .setEmoji("🔒"),
        );

        await interaction.reply({ embeds: [embed], components: [row] });
    }
};
