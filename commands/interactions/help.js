const Discord = require('discord.js');
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
            .addFields(
                {
                    name: "/chat `prompt`",
                    value: "我會回答你的問題或提示。",
                },
                {
                    name: "在指定頻道 @我",
                    value: "在管理員設定的頻道裡標註我，就能直接和我聊天。",
                },
                {
                    name: "/costs `period`",
                    value: "查詢 API 使用量與估算費用。\n選項：`今日` / `本月` / `累計`",
                },
                {
                    name: "/modlog-me",
                    value: "查詢自己的處分紀錄。",
                },
                {
                    name: "右鍵/長按訊息 →「檢舉訊息」",
                    value: "對於伺服器中違規的訊息，可以透過我檢舉，交給管理員處理。",
                },
                {
                    name: "/help",
                    value: "顯示此幫助訊息。",
                },
            )
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
