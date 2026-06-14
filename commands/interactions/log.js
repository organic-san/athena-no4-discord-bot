const Discord = require('discord.js');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, PermissionFlagsBits, InteractionContextType } = require('discord.js');
require('dotenv').config();


const MAX_BYTES = 7 * 1024 * 1024;

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("log")
        .setDescription("備份頻道訊息")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {

        if(!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: '只有管理員才能使用這個指令。', flags: Discord.MessageFlags.Ephemeral }).catch(console.error);
            return;
        }

        let currentChunk = [];
        let currentChunkSize = 2;
        let partNumber = 1;

        let totalFetched = 0;
        let processedMsgCount = 0;

        const channel = interaction.channel;
        let lastId = null;
        
        // 1. 建立停止按鈕與行動列
        const stopButton = new ButtonBuilder()
            .setCustomId('stop_backup')
            .setLabel('停止備份')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🛑');

        const row = new ActionRowBuilder().addComponents(stopButton);

        await interaction.reply({ 
            content: '正在建立備份 ⏳', 
            components: [row]
        });

        const statusMsg = await interaction.fetchReply();
        
        console.log('開始備份頻道訊息...');

        const collector = statusMsg.createMessageComponentCollector({ 
            componentType: ComponentType.Button,
            filter: i => i.user.id === interaction.user.id && i.customId === 'stop_backup',
            time: 3600000
        });

        // 停止標記
        let isCancelled = false;

        collector.on('collect', async i => {
            isCancelled = true;
            await i.update({ 
                content: '🛑 觸發停止。總結目前資料中...', 
                components: [] 
            }).catch(console.error);
            collector.stop();
        });

        try {
            while (!isCancelled) {
                const options = { limit: 100 };
                if (lastId) options.before = lastId;

                const fetchedMessages = await channel.messages.fetch(options);
                if (fetchedMessages.size === 0) break;

                totalFetched += fetchedMessages.size;
                lastId = fetchedMessages.last().id;

                const nonBotMessages = fetchedMessages.filter(m => !m.author.bot);

                for (const [id, m] of nonBotMessages) {
                    const msgObj = {
                        id: m.id,
                        timestamp: m.createdAt,
                        author: {
                            id: m.author.id,
                            username: m.author.username,
                            tag: m.author.tag
                        },
                        content: m.content,
                        attachments: m.attachments.map(a => ({ name: a.name, url: a.url }))
                    };

                    const msgString = JSON.stringify(msgObj);
                    const msgBytes = Buffer.byteLength(msgString, 'utf8');

                    if (currentChunkSize + msgBytes + 1 > MAX_BYTES) {
                        const fileBuffer = Buffer.from(JSON.stringify(currentChunk, null, 2), 'utf8');
                        const attachment = new Discord.AttachmentBuilder(fileBuffer, { name: `backup_${channel.id}_part${partNumber}.json` });

                        await interaction.followUp({
                            content: `📦 備份檔案 **Part ${partNumber}** (累計 ${processedMsgCount} 則)`,
                            files: [attachment]
                        }).catch(console.error);

                        currentChunk = [];
                        currentChunkSize = 2;
                        partNumber++;
                    }

                    currentChunk.push(msgObj);
                    currentChunkSize += msgBytes + (currentChunk.length > 1 ? 1 : 0);
                    processedMsgCount++;
                }

                if (totalFetched % 500 === 0 && !isCancelled) {
                    await statusMsg.edit({
                        content: `⏳ 已掃描 ${totalFetched} 則訊息，紀錄 ${processedMsgCount} 則訊息`,
                        components: [row]
                    }).catch(console.error);
                    console.log(`⏳ 已處理 ${processedMsgCount} 則訊息`);
                }

                await new Promise(resolve => setTimeout(resolve, 200));

                if (fetchedMessages.size < 100) break;
            }

            if (!isCancelled) {
                collector.stop();
                await statusMsg.edit({ components: [] }).catch(console.error);
            }

            const finishReason = isCancelled ? "🛑 備份已中斷" : "✅ 備份完成！";

            if (currentChunk.length > 0) {
                const fileBuffer = Buffer.from(JSON.stringify(currentChunk, null, 2), 'utf8');
                const attachment = new Discord.AttachmentBuilder(fileBuffer, { name: `backup_${channel.id}_part${partNumber}.json` });

                await interaction.followUp({
                    content: `${finishReason} 最後一份檔案 **Part ${partNumber}**。\n- 總計備份有效訊息：${processedMsgCount} 則`,
                    files: [attachment]
                }).catch(console.error);
            } else {
                await interaction.followUp(`${finishReason}\n- 總計備份有效訊息：${processedMsgCount} 則`);
            }

        } catch (error) {
            console.error('發生錯誤:', error);
            await interaction.followUp('❌ 發生錯誤，請檢查錯誤訊息。').catch(console.error);
        }
    }
};