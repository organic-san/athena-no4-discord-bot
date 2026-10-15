const Discord = require('discord.js');
require('dotenv').config();
const func = require('../../utility/functions');
const system = require('../../utility/system');
const gemini = require('../../utility/gemini');

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("chat")
        .setDescription("與 Athena No.4 聊天")
        // 私訊不受頻道白名單管理，等同無限制消耗 API 額度，故限定只能在伺服器內使用。
        .setContexts(Discord.InteractionContextType.Guild)
        .addStringOption(option =>
            option.setName("prompt")
                .setDescription("輸入你的問題或提示")
                .setRequired(true)
        ),

    async execute(client, interaction) {
        await interaction.deferReply();
        const prompt = interaction.options.getString("prompt");

        try {
            const chatSession = gemini.ai.chats.create({
                model: gemini.model(),
                config: gemini.config(client.user.username),
                history: [],
            });

            // 發話者標註格式與 models/message.js 一致，避免兩個入口對模型呈現不同的輸入樣貌。
            const speaker = interaction.member?.displayName || interaction.user.displayName;
            const resault = await gemini.withRetry(() => chatSession.sendMessage({
                message: {
                    text: `[${speaker}]: ${prompt}`,
                },
            }));

            const { inputTokens, outputTokens, cost } = gemini.usageOf(resault);

            system.recordUsage(
                interaction.user.id,
                interaction.user.username,
                inputTokens,
                outputTokens,
                cost
            );

            // 回應可能沒有文字（被安全過濾擋下、輸出額度用盡、或空回應）→ 給明確訊息而非丟例外
            const emptyReason = gemini.emptyReason(resault);
            if (emptyReason) {
                await interaction.editReply(`這次沒有產生內容（${emptyReason}），換個說法再試試看。`);
                return;
            }

            // AI 產生的內容不允許觸發 @everyone／身分組／任意成員提及，避免被誘導轟炸
            const sends = func.sliceByWordCount(resault.text, 1950);
            await interaction.editReply({ content: sends[0], allowedMentions: { parse: [] } });
            for (let i = 1; i < sends.length; i++) {
                await interaction.followUp({ content: sends[i], allowedMentions: { parse: [] } });
            }
        } catch (err) {
            // 依 ApiError.status 判斷，而非比對訊息字串。這裡是重試 2 次後仍然失敗的情況。
            if (gemini.isOverloaded(err)) {
                await interaction.editReply(`逼逼! 能量飲料耗光了...`);
                return;
            }
            console.error(err);
            await interaction.editReply("在處理過程中發生意外的錯誤：```" + err + "```請稍後再試一次。\n" + `<@${process.env.AUTHOR_USERID}>`);
            return;
        }
    }
};
