const Discord = require('discord.js');
const { ContextMenuCommandBuilder, ApplicationCommandType, ChannelType, InteractionContextType } = require('discord.js');
const DB = require('../../utility/database.js');
const func = require('../../utility/functions.js');
const modConfig = require('../../utility/modConfig.js');
const evidence = require('../../utility/evidence.js');
require('dotenv').config();

const db = DB.getConnection();

// 記憶體速率計數：userId → 檢舉時間戳陣列
const rateMap = new Map();

module.exports = {
    tag: "interaction",
    data: new ContextMenuCommandBuilder()
        .setName("檢舉訊息")
        .setType(ApplicationCommandType.Message)
        .setContexts(InteractionContextType.Guild),

    async execute(client, interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '此指令僅能在伺服器中使用。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const conf = modConfig.get(interaction.guildId);
        if (!conf.report_thread_parent_id) {
            await interaction.reply({ content: '本伺服器尚未設定檢舉討論串母頻道，請聯絡管理員以 `/modconfig` 設定。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const target = interaction.targetMessage;
        const reporterId = interaction.user.id;

        // ── 防濫用：每則訊息每人限檢舉 1 次 ──
        const dup = db.prepare(
            `SELECT id FROM report WHERE reporter_id = ? AND target_msg_id = ?`
        ).get(reporterId, target.id);
        if (dup) {
            await interaction.reply({ content: '你已經檢舉過這則訊息了。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        // ── 防濫用：速率限制 ──
        const { count, minutes } = modConfig.parseRateLimit(interaction.guildId);
        const now = Date.now();
        const windowMs = minutes * 60 * 1000;
        const stamps = (rateMap.get(reporterId) || []).filter(t => now - t < windowMs);
        if (stamps.length >= count) {
            await interaction.reply({ content: `已達到 ${minutes} 分鐘內的檢舉次數上限（${count} 次）。`, flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        if (target.author.bot) {
            await interaction.reply({ content: '無法檢舉機器人訊息。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });

        try {
            const parent = await interaction.guild.channels.fetch(conf.report_thread_parent_id).catch(() => null);
            if (!parent || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(parent.type)) {
                await interaction.editReply('檢舉討論串母頻道設定無效，請聯絡管理員重新設定。');
                return;
            }

            // ── 脈絡擷取（前 N / 後 M） ──
            const beforeCol = await target.channel.messages.fetch({ before: target.id, limit: conf.context_before }).catch(() => null);
            const afterCol = await target.channel.messages.fetch({ after: target.id, limit: conf.context_after }).catch(() => null);
            const before = beforeCol ? [...beforeCol.values()].reverse() : [];
            const after = afterCol ? [...afterCol.values()].reverse() : [];

            // ── 固化證據 ──
            // 被檢舉訊息若含圖片，直接合併進單一張證據卡並上防雷（與偵測流程一致）
            const files = [];
            const card = await evidence.renderMessageCard(target, { embedImages: true }).catch(() => null);
            if (card) files.push(card.setSpoiler(true));
            files.push(evidence.buildContextMarkdown(before, target, after));

            // ── 建立私人討論串 ──
            const thread = await parent.threads.create({
                name: `檢舉-${target.author.username}-${func.getLocalDate()}`.slice(0, 90),
                type: ChannelType.PrivateThread,
                invitable: false,
                reason: `檢舉案件（檢舉者 ${interaction.user.tag}）`,
            });

            const caseEmbed = new Discord.EmbedBuilder()
                .setTitle('🚩 檢舉案件')
                .setColor(0xFAA61A)
                .addFields(
                    { name: '被檢舉者', value: `<@${target.author.id}>`, inline: true },
                    { name: '檢舉者', value: `<@${reporterId}>`, inline: true },
                    { name: '來源頻道', value: `<#${target.channel.id}>`, inline: true },
                    { name: '原訊息', value: `[跳轉連結](${target.url})` },
                )
                .setFooter({ text: '管理員可於本討論串中執行 /close 結案' })
                .setTimestamp();
            if (!card) caseEmbed.addFields({ name: '註', value: '伺服器未安裝 canvas，未產生證據圖；脈絡仍以 .md 附件提供。' });

            // @ 檢舉者（提及即加入私人討論串，由其向管理員說明）+ @ 管理員身分組（若已設定）；管理員具 ManageThreads 權限可見
            const adminRoleId = conf.admin_role_id;
            const roleMention = adminRoleId ? ` <@&${adminRoleId}>` : '';
            const threadMsg = await thread.send({
                content: `<@${reporterId}>${roleMention} 已收到你的檢舉，請在此向管理員說明檢舉原因與情況。`,
                embeds: [caseEmbed],
                files,
                allowedMentions: { users: [reporterId], roles: adminRoleId ? [adminRoleId] : [] },
            });

            // ── 寫入 report（記錄討論串證據訊息 ID，供結案時轉貼證據圖到處分頻道） ──
            const info = db.prepare(
                `INSERT INTO report (guild_id, reporter_id, target_user_id, target_msg_id, channel_id, thread_id, thread_evidence_msg_id, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`
            ).run(interaction.guildId, reporterId, target.author.id, target.id, target.channel.id, thread.id, threadMsg.id, func.localISOTimeNow());

            stamps.push(now);
            rateMap.set(reporterId, stamps);

            await interaction.editReply(`✅ 已建立檢舉案件 **#${info.lastInsertRowid}**，請至 <#${thread.id}> 向管理員說明。`);
        } catch (error) {
            console.error('report error:', error);
            await interaction.editReply('建立檢舉時發生錯誤，請稍後再試或聯絡管理員。').catch(() => {});
        }
    }
};
