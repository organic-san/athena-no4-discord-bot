const Discord = require('discord.js');
const modConfig = require('../utility/modConfig.js');
const detectionEngine = require('../utility/detectionEngine.js');
const evidence = require('../utility/evidence.js');
const moderation = require('../utility/moderation.js');
require('dotenv').config();

module.exports = {
    name: "detection",
    event: Discord.Events.MessageCreate,
    async execute(client, msg) {
        // 被動偵測：過濾 bot / webhook / 私訊
        if (msg.author?.bot) return;
        if (msg.webhookId) return;
        if (!msg.guild) return;

        const conf = modConfig.get(msg.guild.id);
        if (!conf.detection_enabled) return;
        if (!conf.admin_notify_channel_id) return; // 未設定通報頻道則不啟用

        // 無實質內容（無文字、無附件）的訊息不納入偵測。
        // 這同時防止失去 Message Content intent 時，大量空 content 訊息被誤判為「相同內容」。
        if (!(msg.content || '').trim() && msg.attachments.size === 0) return;

        const result = detectionEngine.record(
            msg.author.id, msg.channel.id, msg.content, msg.attachments.size
        );
        if (!result.triggered) return; // 訊息看完即丟

        console.log(`[detection] 跨頻道連發觸發：user ${msg.author.tag} (${msg.author.id}), 頻道數 ${result.channels.length}`);

        try {
            // 1. 自動禁言 K 分鐘
            const muteMin = conf.detection_mute_min || 10;
            const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
            let muteOk = true, muteErr = null;
            if (member) {
                await member.timeout(muteMin * 60 * 1000, '即時威脅偵測：跨頻道連發')
                    .catch(e => { muteOk = false; muteErr = String(e?.message || e); });
            } else {
                muteOk = false; muteErr = '找不到該成員';
            }

            // 2. 通報管理員告知頻道
            const channel = await msg.guild.channels.fetch(conf.admin_notify_channel_id).catch(() => null);
            if (!channel) return;

            const channelList = result.channels.map(id => `<#${id}>`).join('、');
            const embed = new Discord.EmbedBuilder()
                .setTitle('🚨 即時威脅偵測：跨頻道連發')
                .setColor(0xED4245)
                .setDescription(`偵測到 <@${msg.author.id}> 於 30 秒內在 ${result.channels.length} 個頻道連發相同內容。`)
                .addFields(
                    { name: '對象', value: `<@${msg.author.id}> (${msg.author.id})` },
                    { name: '涉及頻道', value: channelList || '（無）' },
                    { name: '自動處置', value: muteOk ? `已禁言 ${moderation.formatMinutes(muteMin)}（待管理員裁量）` : `⚠️ 禁言失敗：${muteErr}` },
                )
                .setFooter({ text: '管理員可點擊下方按鈕進行操作' })
                .setTimestamp();

            // 將使用者上傳的圖片直接合併進證據卡，產生單一張圖片，並整張上防雷，
            // 避免濫用內容（可能含 NSFW／血腥）在管理頻道直接展開。
            const files = [];
            const card = await evidence.renderMessageCard(msg, { embedImages: true }).catch(() => null);
            if (card) files.push(card.setSpoiler(true));

            // 下方操作按鈕：解除禁言 / 停權（停權需填理由）
            const buildRow = (banCustomId) => new Discord.ActionRowBuilder().addComponents(
                new Discord.ButtonBuilder()
                    .setCustomId(banCustomId)
                    .setLabel('停權').setStyle(Discord.ButtonStyle.Danger).setEmoji('🔨'),
                new Discord.ButtonBuilder()
                    .setCustomId(`det:unmute:${msg.author.id}`)
                    .setLabel('解除禁言').setStyle(Discord.ButtonStyle.Secondary).setEmoji('✅'),
            );

            // 標註管理員身分組（若已設定）
            const { content, allowedMentions } = modConfig.adminMention(msg.guild.id);

            // 退而求其次：若附圖送出失敗，至少確保通報本體（embed + 按鈕）送達。
            const baseRow = buildRow(`det:ban:${msg.author.id}`);
            const sent = await channel.send({ content, embeds: [embed], files, components: [baseRow], allowedMentions })
                .catch(async () => await channel.send({ content, embeds: [embed], components: [baseRow], allowedMentions }).catch(() => null));

            // 送出後，將證據圖所在訊息引用補進「停權」按鈕，供停權時轉貼到處分頻道
            if (sent && files.length) {
                const updatedRow = buildRow(`det:ban:${msg.author.id}:${sent.channelId}:${sent.id}`);
                await sent.edit({ components: [updatedRow] }).catch(() => null);
            }
        } catch (error) {
            console.error('detection error:', error);
        }
    }
};
