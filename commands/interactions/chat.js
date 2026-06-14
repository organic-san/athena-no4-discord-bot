const Discord = require('discord.js');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const func = require('../../utility/functions');
const system = require('../../utility/system');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ;

const ai = new GoogleGenAI({apiKey: GEMINI_API_KEY });

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("chat")
        .setDescription("與 Athena No.4 聊天")
        .addStringOption(option =>
            option.setName("prompt")
                .setDescription("輸入你的問題或提示")
                .setRequired(true)
        ),

    async execute(client, interaction) {
        await interaction.deferReply();
        const prompt = interaction.options.getString("prompt");

        try {
            const chatSession = ai.chats.create({
                model: process.env.DEFAULT_MODEL || 'gemini-3.1-flash-lite-preview',
                config: {
                    systemInstruction: fs.readFileSync("./prompts/default.txt", "utf-8")
                        .replaceAll('{botName}', client.user.username),
                },
                history: [],
            });

            const resault = await chatSession.sendMessage({
                message: {
                    text: prompt,
                },
            });

            const usage = resault.usageMetadata;
            const inputTokens = usage?.promptTokenCount || 0;
            const outputTokens = usage?.candidatesTokenCount || 0;

            system.recordUsage(
                interaction.user.id,
                interaction.user.username,
                inputTokens,
                outputTokens,
                func.calcGeminiCost(inputTokens, outputTokens)
            );

            // 回應可能沒有文字（被安全過濾擋下、prompt 被擋、或空回應）→ 給明確訊息而非丟例外
            if (!resault.text || !resault.text.trim()) {
                const reason = resault.candidates?.[0]?.finishReason || resault.promptFeedback?.blockReason;
                await interaction.editReply(`這次沒有產生內容${reason ? `（${reason}）` : ''}，可能是內容被安全過濾擋下或回應為空，換個說法再試試看。`);
                return;
            }

            // AI 產生的內容不允許觸發 @everyone／身分組／任意成員提及，避免被誘導轟炸
            const sends = func.sliceByWordCount(resault.text, 1950);
            await interaction.editReply({ content: sends[0], allowedMentions: { parse: [] } });
            for (let i = 1; i < sends.length; i++) {
                await interaction.followUp({ content: sends[i], allowedMentions: { parse: [] } });
            }
        } catch (err) {
            if(err.message?.includes("429")) {
                await interaction.editReply(`逼逼! 能量飲料耗光了...`);
                return;
            }
            console.error(err);
            await interaction.editReply("在處理過程中發生意外的錯誤：```" + err + "```請稍後再試一次。\n" + `<@${process.env.AUTHOR_USERID}>`);
            return;
        }
    }
};
