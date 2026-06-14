const Discord = require('discord.js');
const { PermissionFlagsBits } = require('discord.js');
const DB = require('../utility/database.js');
const func = require('../utility/functions.js');
const moderation = require('../utility/moderation.js');
const evidence = require('../utility/evidence.js');
const pf = require('../utility/punishFlow.js');
require('dotenv').config();

const db = DB.getConnection();

const REVOKE_WINDOW_MS = 30 * 1000; // 告知訊息上撤回按鈕的有效時間

function isAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

/**
 * 共用：執行處分 → 記錄 → 證據&結論發布 → 違規過多檢查 →（如有檢舉）更新 report。
 * @returns {Promise<{ pid:number, summary:string }>}
 */
async function finalizePunishment(interaction, { guild, targetUserId, type, durationMin, reason, source, report, evidenceSrc }) {
    // 1. Discord 實際執行
    let actionResult;
    try {
        actionResult = await moderation.applyDiscordAction(guild, targetUserId, type, durationMin, reason);
    } catch (e) {
        actionResult = { ok: false, error: String(e?.message || e) };
    }

    // 2. 寫入紀錄
    const pid = moderation.insertPunishment({
        guildId: guild.id, targetUserId, type,
        durationMin: type === 'mute' ? durationMin : null,
        reason, source, executorId: interaction.user.id,
    });

    // 3. 證據圖 + 結論 → 處分發布頻道
    //    證據來源統一為描述物件：{ render: 訊息 }（重繪卡片）或 { transcribe: 訊息 }（轉貼既有圖）
    const files = [];
    if (evidenceSrc?.render) {
        const card = await evidence.renderMessageCard(evidenceSrc.render, { embedImages: true }).catch(() => null);
        if (card) files.push(card.setSpoiler(true));
    }
    if (evidenceSrc?.transcribe) {
        files.push(...await evidence.transcribeImages(evidenceSrc.transcribe).catch(() => []));
    }
    const embed = new Discord.EmbedBuilder()
        .setTitle(`⚖️ 處分執行 — ${moderation.TYPE_LABEL[type] || type}`)
        .setColor(type === 'ban' ? 0xED4245 : type === 'warn' ? 0xFAA61A : 0xE67E22)
        .addFields(
            { name: '處分編號', value: `#${pid}`, inline: true },
            { name: '對象', value: `<@${targetUserId}>`, inline: true },
            { name: '執行者', value: `<@${interaction.user.id}>`, inline: true },
            { name: '理由', value: reason || '（未填寫）' },
        )
        .setTimestamp();
    if (type === 'mute' && durationMin) embed.addFields({ name: '時長', value: pf.durationLabel(durationMin), inline: true });
    if (report) embed.setFooter({ text: `來自檢舉案件 #${report.id}` });
    if (!actionResult.ok) embed.addFields({ name: '⚠️ 執行狀態', value: actionResult.error || '執行失敗（紀錄已保存）' });

    const logMsgId = await moderation.postPunishmentLog(guild, embed, files);
    if (logMsgId) moderation.setEvidenceMsg(pid, logMsgId);

    // 4. 更新檢舉案件
    if (report) {
        db.prepare(`UPDATE report SET status = 'closed', punishment_id = ?, closed_at = ? WHERE id = ?`)
            .run(pid, func.localISOTimeNow(), report.id);
    }

    // 5. warn → 違規過多檢查
    let escalationNote = '';
    if (type === 'warn') {
        const esc = await moderation.checkEscalation(guild, targetUserId).catch(e => { console.error('escalation error:', e); return null; });
        if (esc?.action === 'ban-pending') escalationNote = '\n⚙️ 違規過多 Ban 警告：已凍結發言權限，於管理員頻道發送裁決訊息。';
        else if (esc) escalationNote = `\n⚙️ 違規過多觸發：${moderation.TYPE_LABEL[esc.action] || esc.action}。`;
    }

    const statusNote = actionResult.ok ? '' : `\n⚠️ Discord 執行未完成：${actionResult.error}（紀錄已保存）`;
    const summary = `✅ 已對 <@${targetUserId}> 執行**${moderation.TYPE_LABEL[type] || type}**（處分 #${pid}）。${statusNote}${escalationNote}`;
    return { pid, summary };
}

/** 解析 pf 流程的處分情境（來源＝檢舉或指定訊息）。 */
async function resolvePunishContext(interaction, srcType, args) {
    if (srcType === 'r') {
        const report = db.prepare(`SELECT * FROM report WHERE id = ?`).get(Number(args[0]));
        if (!report) return { error: '找不到對應的檢舉案件。' };
        // 優先轉貼檢舉討論串第一則的證據圖（當初固化的處分圖片）；否則退而重繪原訊息
        let evidenceSrc = null;
        if (report.thread_evidence_msg_id && report.thread_id) {
            const th = await interaction.guild.channels.fetch(report.thread_id).catch(() => null);
            const eviMsg = th ? await th.messages.fetch(report.thread_evidence_msg_id).catch(() => null) : null;
            if (eviMsg) evidenceSrc = { transcribe: eviMsg };
        }
        if (!evidenceSrc) {
            const ch = await interaction.guild.channels.fetch(report.channel_id).catch(() => null);
            const srcMsg = ch ? await ch.messages.fetch(report.target_msg_id).catch(() => null) : null;
            if (srcMsg) evidenceSrc = { render: srcMsg };
        }
        return { targetUserId: report.target_user_id, report, source: 'report_close', evidenceSrc };
    }
    if (srcType === 'm') {
        const [channelId, msgId] = args;
        const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
        const srcMsg = ch ? await ch.messages.fetch(msgId).catch(() => null) : null;
        if (!srcMsg) return { error: '原訊息已不存在，無法判定對象。' };
        return { targetUserId: srcMsg.author.id, report: null, source: 'manual', evidenceSrc: { render: srcMsg }, sourceMessage: srcMsg };
    }
    return { error: '未知的處分來源。' };
}

/** 處分告知 embed（公開於執行頻道，由誰處分誰、原因）。 */
function buildPunishNotice(interaction, { targetUserId, type, durationMin, reason, pid }) {
    const label = moderation.TYPE_LABEL[type] || type;
    const embed = new Discord.EmbedBuilder()
        .setTitle(`⚖️ 處分：${label}`)
        .setColor(type === 'ban' ? 0xED4245 : type === 'warn' ? 0xFAA61A : 0xE67E22)
        .setDescription(`<@${interaction.user.id}> 對 <@${targetUserId}> 處以**${label}**`)
        .addFields({ name: '原因', value: reason || '（未填寫）' })
        .setFooter({ text: `處分 #${pid}` })
        .setTimestamp();
    if (type === 'mute' && durationMin) embed.addFields({ name: '時長', value: pf.durationLabel(durationMin), inline: true });
    return embed;
}

/** 撤回按鈕（限原處分者、30 秒內有效）。 */
function revokeRow(pid, executorId) {
    return new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder()
            .setCustomId(`revoke:${pid}:${executorId}:${Date.now()}`)
            .setLabel('撤回').setStyle(Discord.ButtonStyle.Danger).setEmoji('↩️'),
    );
}

module.exports = {
    name: "modInteraction",
    event: Discord.Events.InteractionCreate,
    async execute(client, interaction) {
        // 只處理按鈕 / 下拉選單 / Modal；其餘交給 interaction.js
        if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

        const id = interaction.customId;
        const [ns, action, ...rest] = id.split(':');
        if (!['close', 'pf', 'ban', 'det', 'revoke'].includes(ns)) return;

        // 每個互動觸發都留下 log（不含 Modal 輸入內容）
        const itype = interaction.isButton() ? 'button' : interaction.isStringSelectMenu() ? 'select-menu' : 'modal';
        const valueStr = interaction.isStringSelectMenu() ? ` values=[${interaction.values.join(',')}]` : '';
        console.log(`${itype}: ${id}${valueStr}, from: ${interaction.guild?.name ?? 'DM'}, user: ${interaction.user.tag} (ID: ${interaction.user.id})`);

        try {
            // ───────── /close 三顆按鈕 ─────────
            if (ns === 'close') {
                if (!isAdmin(interaction)) return interaction.reply({ content: '只有管理員才能操作。', flags: Discord.MessageFlags.Ephemeral });
                const reportId = Number(rest[0]);
                const report = db.prepare(`SELECT * FROM report WHERE id = ?`).get(reportId);
                if (!report) return interaction.reply({ content: '找不到對應的檢舉案件。', flags: Discord.MessageFlags.Ephemeral });

                if (action === 'punish') {
                    // 進入統一處分流程（來源＝檢舉案件）
                    await interaction.reply({ content: '請選擇處分類型：', components: [pf.typeSelectRow(pf.reportToken(reportId))], flags: Discord.MessageFlags.Ephemeral });
                    return;
                }
                if (action === 'delmsg') {
                    await interaction.deferReply(); // 公開傳送結果
                    const ch = await interaction.guild.channels.fetch(report.channel_id).catch(() => null);
                    const msg = ch ? await ch.messages.fetch(report.target_msg_id).catch(() => null) : null;
                    if (!msg) { await interaction.editReply('原訊息已不存在（證據已於檢舉時固化）。'); return; }
                    await msg.delete().catch(() => null);
                    await interaction.editReply('🗑️ 已刪除原訊息。');
                    return;
                }
                if (action === 'archive') {
                    // 以 update 編輯 /close 訊息本身：移除按鈕，讓誰都不能再按
                    await interaction.update({ content: '🔒 討論串已關閉，本案結束。', components: [] });
                    if (report.status !== 'closed') {
                        db.prepare(`UPDATE report SET status = 'closed', closed_at = ? WHERE id = ?`)
                            .run(func.localISOTimeNow(), report.id);
                    }
                    const thread = interaction.channel;
                    await thread.setLocked(true).catch(() => null);
                    await thread.setArchived(true).catch(() => null);
                    return;
                }
            }

            // ───────── 統一處分流程：選類型 → 選時長 → 填理由 → 執行 ─────────
            if (ns === 'pf') {
                if (!isAdmin(interaction)) return interaction.reply({ content: '只有管理員才能操作。', flags: Discord.MessageFlags.Ephemeral });
                const src = pf.parseSource(rest);
                if (!src) return interaction.reply({ content: '處分流程資料無效。', flags: Discord.MessageFlags.Ephemeral });

                if (action === 'type') {
                    const type = interaction.values[0];
                    if (type === 'mute') {
                        await interaction.update({ content: '請選擇禁言時長：', components: [pf.durationSelectRow(src.token)] });
                    } else {
                        await interaction.showModal(pf.reasonModal(src.token, type, 0));
                    }
                    return;
                }

                if (action === 'dur') {
                    const dur = interaction.values[0];
                    await interaction.showModal(pf.reasonModal(src.token, 'mute', dur));
                    return;
                }

                if (action === 'modal') {
                    const [type, durStr] = src.tail;
                    const durationMin = type === 'mute' ? Number(durStr) : null;
                    const reason = interaction.fields.getTextInputValue('reason');
                    await interaction.deferReply();

                    const ctx = await resolvePunishContext(interaction, src.srcType, src.args);
                    if (ctx.error) { await interaction.editReply(ctx.error); return; }

                    const { pid, summary } = await finalizePunishment(interaction, {
                        guild: interaction.guild, targetUserId: ctx.targetUserId, type, durationMin,
                        reason, source: ctx.source, report: ctx.report, evidenceSrc: ctx.evidenceSrc,
                    });

                    // 指定訊息（右鍵）：刪除原訊息（證據已固化於處分頻道）+ 公開告知 + 30 秒撤回按鈕
                    if (src.srcType === 'm') {
                        await ctx.sourceMessage?.delete().catch(() => null);
                        const embed = buildPunishNotice(interaction, { targetUserId: ctx.targetUserId, type, durationMin, reason, pid });
                        await interaction.editReply({ embeds: [embed], components: [revokeRow(pid, interaction.user.id)] });
                        setTimeout(() => interaction.editReply({ components: [] }).catch(() => {}), REVOKE_WINDOW_MS);
                    } else {
                        // 檢舉結案：回覆摘要文字
                        await interaction.editReply(summary);
                    }
                    return;
                }
            }

            // ───────── Ban 裁決 ─────────
            if (ns === 'ban') {
                if (!isAdmin(interaction)) return interaction.reply({ content: '只有管理員才能裁決。', flags: Discord.MessageFlags.Ephemeral });
                const freezeId = Number(rest[0]);
                const targetUserId = rest[1];

                if (action === 'confirm') {
                    await interaction.deferReply();
                    // 沿用凍結紀錄的理由，標註是基於哪條違規過多規則（如「120 天內警告達 4 次」）
                    const freeze = moderation.getPunishment(freezeId);
                    const baseReason = freeze?.reason ? freeze.reason.replace('（待管理員裁決）', '') : '違規過多停權';
                    // 走統一流程：執行停權 + 寫紀錄 + 發布處分頻道訊息
                    const { summary } = await finalizePunishment(interaction, {
                        guild: interaction.guild, targetUserId, type: 'ban', durationMin: null,
                        reason: `${baseReason}`, source: 'auto_escalation', report: null, evidenceSrc: null,
                    });
                    await interaction.message.edit({ components: [] }).catch(() => null);
                    await interaction.editReply(summary);
                    return;
                }

                if (action === 'totimeout') {
                    await interaction.reply({ content: '請選擇改為定時禁言的時長：', components: [pf.durationSelectRowRaw(`ban:dur:${freezeId}:${targetUserId}`)], flags: Discord.MessageFlags.Ephemeral });
                    return;
                }

                if (action === 'dur') {
                    await interaction.deferReply();
                    const durationMin = Number(interaction.values[0]);
                    let res;
                    try { res = await moderation.applyDiscordAction(interaction.guild, targetUserId, 'mute', durationMin, '違規過多：改為定時禁言'); }
                    catch (e) { res = { ok: false, error: String(e?.message || e) }; }
                    moderation.updatePunishment(freezeId, { duration_min: durationMin, reason: '違規過多：管理員改判定時禁言' });
                    await interaction.message.edit({ components: [] }).catch(() => null);

                    // 發布裁決結果到處分頻道
                    const embed = new Discord.EmbedBuilder()
                        .setTitle('⚖️ 違規過多 — 禁言')
                        .setColor(0xE67E22)
                        .addFields(
                            { name: '處分編號', value: `#${freezeId}`, inline: true },
                            { name: '對象', value: `<@${targetUserId}>`, inline: true },
                            { name: '執行者', value: `<@${interaction.user.id}>`, inline: true },
                            { name: '時長', value: pf.durationLabel(durationMin), inline: true },
                            { name: '說明', value: '由違規過多停權裁決改判為定時禁言' },
                        )
                        .setTimestamp();
                    if (!res.ok) embed.addFields({ name: '⚠️ 執行狀態', value: res.error || '執行失敗（紀錄已更新）' });
                    await moderation.postPunishmentLog(interaction.guild, embed);

                    await interaction.editReply(res.ok
                        ? `⏳ 已將 <@${targetUserId}> 改為定時禁言 ${pf.durationLabel(durationMin)}。`
                        : `⚠️ 調整失敗：${res.error}`);
                    return;
                }

                if (action === 'unmute') {
                    await interaction.deferReply();
                    await interaction.message.edit({ components: [] }).catch(() => null);
                    // 統一撤回流程：解除凍結 + 於處分頻道發布撤回標示
                    const r = await moderation.revokePunishmentFull(interaction.guild, freezeId, interaction.user.id).catch(() => null);
                    const warn = r?.unmuteErr ? `\n⚠️ 解除失敗：${r.unmuteErr}` : '';
                    await interaction.editReply(`✅ 已解除 <@${targetUserId}> 的凍結，並已於處分頻道發布標示。${warn}`);
                    return;
                }
            }

            // ───────── 偵測通報：解除禁言 / 停權 ─────────
            if (ns === 'det') {
                if (!isAdmin(interaction)) return interaction.reply({ content: '只有管理員才能操作。', flags: Discord.MessageFlags.Ephemeral });
                const targetUserId = rest[0];

                if (action === 'unmute') {
                    await interaction.deferReply();
                    let res;
                    try { res = await moderation.clearTimeout(interaction.guild, targetUserId, '管理員自偵測通報解除禁言'); }
                    catch (e) { res = { ok: false, error: String(e?.message || e) }; }
                    await interaction.message.edit({ components: [] }).catch(() => null);
                    await interaction.editReply(res.ok
                        ? `✅ 已解除 <@${targetUserId}> 的禁言。`
                        : `⚠️ 解除失敗：${res.error}`);
                    return;
                }

                if (action === 'ban') {
                    // 將證據圖所在訊息引用（rest = userId[:channelId:msgId]）一併帶進 Modal
                    await interaction.showModal(pf.reasonModalRaw(`det:banmodal:${rest.join(':')}`, 'ban'));
                    return;
                }

                if (action === 'banmodal') {
                    const eviChannelId = rest[1], eviMsgId = rest[2];
                    const reason = interaction.fields.getTextInputValue('reason');
                    await interaction.deferReply();

                    // 取偵測通報當下產生的證據圖訊息，交由統一流程轉貼到處分頻道
                    let notifyMsg = null;
                    if (eviChannelId && eviMsgId) {
                        const ch = await interaction.guild.channels.fetch(eviChannelId).catch(() => null);
                        notifyMsg = ch ? await ch.messages.fetch(eviMsgId).catch(() => null) : null;
                    }

                    const { summary } = await finalizePunishment(interaction, {
                        guild: interaction.guild, targetUserId, type: 'ban', durationMin: null,
                        reason, source: 'detection', report: null,
                        evidenceSrc: notifyMsg ? { transcribe: notifyMsg } : null,
                    });
                    await interaction.message?.edit({ components: [] }).catch(() => null);
                    await interaction.editReply(summary);
                    return;
                }
            }

            // ───────── 處分告知訊息的撤回按鈕（限原處分者、30 秒內） ─────────
            if (ns === 'revoke') {
                const pid = Number(action); // customId = revoke:<pid>:<executorId>:<ts>
                const executorId = rest[0];
                const ts = Number(rest[1]);
                if (interaction.user.id !== executorId) {
                    return interaction.reply({ content: '只有原處分者可以撤回此處分。', flags: Discord.MessageFlags.Ephemeral });
                }
                if (ts && Date.now() - ts > REVOKE_WINDOW_MS) {
                    await interaction.reply({ content: '撤回時限已過（30 秒），請改用 `/modrevoke`。', flags: Discord.MessageFlags.Ephemeral });
                    await interaction.message.edit({ components: [] }).catch(() => null);
                    return;
                }
                await interaction.deferUpdate();
                // 統一撤回流程：標記 + 解除禁言/unban + 於處分頻道發布撤回標示
                await moderation.revokePunishmentFull(interaction.guild, pid, interaction.user.id).catch(() => null);
                // 更新原訊息：標示已撤回、移除按鈕
                const old = interaction.message.embeds[0];
                const embed = old
                    ? Discord.EmbedBuilder.from(old).setColor(0x99AAB5).setTitle('↩️ 處分（已撤回）')
                    : new Discord.EmbedBuilder().setTitle('↩️ 已撤回').setColor(0x99AAB5);
                await interaction.editReply({ embeds: [embed], components: [] }).catch(() => null);
                return;
            }
        } catch (error) {
            console.error('modInteraction error:', error);
            const msg = '處理互動時發生錯誤：```' + (error?.message || error) + '```';
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: msg, components: [] }).catch(() => {});
            } else {
                await interaction.reply({ content: msg, flags: Discord.MessageFlags.Ephemeral }).catch(() => {});
            }
        }
    }
};
