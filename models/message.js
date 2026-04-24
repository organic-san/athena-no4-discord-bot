const Discord = require('discord.js');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const func = require('../utility/functions');
const system = require('../utility/system');

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
        if(msg.channel.permissionsFor(client.user).has(Discord.PermissionsBitField.Flags.SendMessages) === false) return;

        const prompt = msg.content.replace(/<@!?\d+>/g, '').trim();
        if (!prompt) return;

        console.log(`message command, from: ${msg.guild?.name ?? 'DM'}, user: ${msg.author.tag} (ID: ${msg.author.id})`);

        await msg.channel.sendTyping();

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

            const result = await chatSession.sendMessage({ message: { text: prompt } });

            const usage = result.usageMetadata;
            const inputTokens = usage?.promptTokenCount || 0;
            const outputTokens = usage?.candidatesTokenCount || 0;
            system.recordUsage(
                msg.author.id, msg.author.username,
                inputTokens, outputTokens,
                func.calcGeminiCost(inputTokens, outputTokens)
            );

            const sends = func.sliceByWordCount(result.text, 1950);
            await msg.reply(sends[0]);
            for (let i = 1; i < sends.length; i++) {
                await msg.channel.send(sends[i]);
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