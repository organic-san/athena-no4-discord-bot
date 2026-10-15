const Discord = require('discord.js');
const system = require('../../utility/system');
const modelConfig = require('../../utility/modelConfig');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("costs")
        .setDescription("查詢 API 使用量與估算費用")
        .addStringOption(option =>
            option.setName("period")
                .setDescription("查詢週期")
                .setRequired(true)
                .addChoices(
                    { name: "今日", value: "daily" },
                    { name: "本月", value: "monthly" },
                    { name: "累計", value: "total" },
                )
        ).addUserOption(option =>
            option.setName("user")
                .setDescription("查詢對象")
        ),

    async execute(client, interaction) {
        await interaction.deferReply();

        const period = interaction.options.getString("period");
        const user = interaction.options.getUser("user") || interaction.user;
        const isExist = system.ensureUser(user.id, user.username);
        if(!isExist) {
            await interaction.editReply(`使用者 ${user.tag} 尚未有任何使用紀錄。`);
            return;
        }
        let data, periodLabel;

        if (period === "daily") {
            data = system.getDailyUsage(user.id);
            periodLabel = "今日";
        } else if (period === "monthly") {
            data = system.getMonthlyUsage(user.id);
            periodLabel = "本月";
        } else {
            data = system.getTotalUsage(user.id);
            periodLabel = "累計";
        }

        const totalTokens = data.inputTokens + data.outputTokens;

        const embed = new Discord.EmbedBuilder()
            .setTitle(`${user.username} 的 ${periodLabel} 使用量`)
            .setColor(0x4285F4)
            .addFields(
                { name: "輸入 Tokens", value: data.inputTokens.toLocaleString(), inline: true },
                { name: "輸出 Tokens", value: data.outputTokens.toLocaleString(), inline: true },
                { name: "合計 Tokens", value: totalTokens.toLocaleString(), inline: true },
                { name: "查詢次數", value: data.queryCount.toLocaleString(), inline: true },
                { name: "估算費用", value: `$${data.cost.toFixed(6)} USD`, inline: true },
            )
            .setFooter({ text: `目前模型：${modelConfig.current().name}` });

        await interaction.editReply({ embeds: [embed] });
    }
};
