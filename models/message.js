const Discord = require('discord.js');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const func = require('../utility/functions');
const system = require('../utility/system');
const gptConfig = require('../utility/gptConfig');

const MAX_DEPTH = 200;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function buildHistory(channel, referenceId, botId, depth) {
    if (!referenceId || depth <= 0) return [];

    let msg;
    try {
        msg = await channel.messages.fetch(referenceId);
    } catch {
        return [];
    }

    const parent = await buildHistory(channel, msg.reference?.messageId, botId, depth - 1);

    const role = msg.author.id === botId ? 'model' : 'user';
    const text = msg.content.replace(/<@!?\d+>/g, '').trim() || '(empty)';

    return [...parent, { role, parts: [{ text }] }];
}

module.exports = {
    name: "message",
    event: Discord.Events.MessageCreate,
    async execute(client, msg) {
        if (msg.webhookId) return;
        if (msg.author.bot) return;
        if (!msg.mentions.has(client.user)) return;
        // 僅在管理員以 /chatconfig 指定的頻道內才觸發（未設定則不觸發；DM 不受限）
        if (msg.guild && !gptConfig.isAllowed(msg.guild.id, msg.channel.id)) return;
        if(msg.channel.permissionsFor(client.user).has(Discord.PermissionsBitField.Flags.SendMessages) === false) return;

        const prompt = msg.content.replace(/<@!?\d+>/g, '').trim();

        // 取得第一張圖片或附件
        const imageAttachment = msg.attachments.find(a => a.contentType?.startsWith('image/'));
        if (!prompt && !imageAttachment) return;

        console.log(`message command, from: ${msg.guild?.name ?? 'DM'}, user: ${msg.author.tag} (ID: ${msg.author.id})`);

        await msg.channel.sendTyping();

        // 若有圖片，下載並轉為 base64 inline data
        let imagePart = null;
        if (imageAttachment) {
            try {
                const res = await fetch(imageAttachment.url);
                const buffer = await res.arrayBuffer();
                imagePart = {
                    inlineData: {
                        mimeType: imageAttachment.contentType,
                        data: Buffer.from(buffer).toString('base64'),
                    }
                };
            } catch (e) {
                console.error('Failed to fetch image attachment:', e);
            }
        }

        const history = msg.reference?.messageId
            ? await buildHistory(msg.channel, msg.reference.messageId, client.user.id, MAX_DEPTH)
            : [];

        const systemPrompt = fs.readFileSync('./prompts/default.txt', 'utf-8')
            .replaceAll('{botName}', client.user.username);

        try {
            const chatSession = ai.chats.create({
                model: process.env.DEFAULT_MODEL || 'gemini-3.1-flash-lite-preview',
                config: { 
                    systemInstruction: systemPrompt, 
                    tools: [
                        {
                            googleSearch: { }
                        }
                    ]
                },
                history,
            });

            const messageParts = [];
            if (imagePart) messageParts.push(imagePart);
            if (prompt) messageParts.push({ text: prompt });

            const result = await chatSession.sendMessage({ message: messageParts });

            const usage = result.usageMetadata;
            const inputTokens = usage?.promptTokenCount || 0;
            const outputTokens = usage?.candidatesTokenCount || 0;
            system.recordUsage(
                msg.author.id, msg.author.username,
                inputTokens, outputTokens,
                func.calcGeminiCost(inputTokens, outputTokens)
            );

            // 回應可能沒有文字（被安全過濾擋下、prompt 被擋、或空回應）→ 給明確訊息而非丟例外
            if (!result.text || !result.text.trim()) {
                const reason = result.candidates?.[0]?.finishReason || result.promptFeedback?.blockReason;
                await msg.reply(`這次沒有產生內容${reason ? `（${reason}）` : ''}，可能是內容被安全過濾擋下或回應為空，換個說法再試試看。`);
                return;
            }

            // AI 產生的內容不允許觸發 @everyone／身分組／任意成員提及，避免被誘導轟炸
            const sends = func.sliceByWordCount(result.text, 1950);
            await msg.reply({ content: sends[0], allowedMentions: { parse: [], repliedUser: true } });
            for (let i = 1; i < sends.length; i++) {
                await msg.channel.send({ content: sends[i], allowedMentions: { parse: [] } });
            }
        } catch (err) {
            if(err.message?.includes("429") || err.message?.includes("503")) {
                await msg.reply(`逼逼! 能量飲料耗光了...`);
                return;
            }
            console.error(err);
            await msg.reply('在處理過程中發生意外的錯誤：```' + err + '```請稍後再試一次。\n' + `<@${process.env.AUTHOR_USERID}>`).catch(
                async () => await msg.channel.send(`<@${msg.author.id}> 在處理過程中發生意外的錯誤：\`\`\`${err}\`\`\`請稍後再試一次。\n<@${process.env.AUTHOR_USERID}>`)
            )
        }
    }
}