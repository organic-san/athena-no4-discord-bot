const Discord = require('discord.js');
const { PermissionFlagsBits } = require('discord.js');
const schedule = require('../utility/schedule.js');
const notify = require('../utility/notify.js');
const isafe = require('../utility/interactionSafe.js');

/** 在原訊息後附上處理結果並移除按鈕（超過字數上限時截掉原文尾端）。 */
function withResult(message, result) {
    const room = 2000 - result.length - 2;
    const base = message.content.length > room ? message.content.slice(0, room - 1) + '…' : message.content;
    return { content: `${base}\n\n${result}`, components: [], allowedMentions: { parse: [] } };
}

module.exports = {
    name: "scheduleInteraction",
    event: Discord.Events.InteractionCreate,
    async execute(client, interaction) {
        if (!interaction.isButton()) return;
        const [ns, action, idStr] = interaction.customId.split(':');
        if (ns !== 'sched') return;
        console.log(`button: ${interaction.customId}, from: ${interaction.guild?.name ?? 'DM'}, user: ${interaction.user.tag} (ID: ${interaction.user.id})`);

        try {
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({ content: '只有管理員才能操作。', flags: Discord.MessageFlags.Ephemeral });
                return;
            }
            const draftId = Number(idStr);

            if (action === 'reject') {
                if (!schedule.reject(draftId, interaction.user.id)) {
                    await interaction.reply({ content: '這份草稿已經處理過了。', flags: Discord.MessageFlags.Ephemeral });
                    return;
                }
                await interaction.update(withResult(interaction.message, `❌ 已由 <@${interaction.user.id}> 標記為不處理`));
                return;
            }

            if (action === 'approve' || action === 'export') {
                const mode = action === 'approve' ? 'publish' : 'export';
                // 建立討論串、下載圖片可能超過 3 秒，先 ack。
                await interaction.deferUpdate();
                let res;
                try {
                    res = await schedule.materialize(client, draftId, interaction.user.id, mode);
                } catch (err) {
                    console.error(`[schedule] 草稿 #${draftId} 處理失敗：`, err);
                    notify.error(`日程預告草稿 #${draftId} 處理失敗`, err);
                    const created = (err.created ?? []).map(t => `- ${t.url}`).join('\n');
                    await interaction.editReply(withResult(interaction.message,
                        `⚠️ 處理失敗：\`${String(err.message).slice(0, 300)}\`` + (created ? `\n已建立的討論串（需手動處理）：\n${created}` : '')));
                    return;
                }
                if (res.already) {
                    await interaction.followUp({ content: `這份草稿${schedule.STATUS_LABEL[res.already] ?? res.already}。`, flags: Discord.MessageFlags.Ephemeral });
                    return;
                }

                const warn = res.warnings.length ? `\n${res.warnings.map(w => `⚠️ ${w}`).join('\n')}` : '';
                if (mode === 'publish') {
                    await interaction.editReply(withResult(interaction.message,
                        `✅ 已由 <@${interaction.user.id}> 發布：${res.postUrl}（討論串 ${res.threads.length} 個）${warn}`));
                    return;
                }
                await interaction.editReply(withResult(interaction.message,
                    `📄 已由 <@${interaction.user.id}> 建立討論串 ${res.threads.length} 個並輸出文字（未發布）${warn}`));
                const files = [{ attachment: Buffer.from(res.text, 'utf-8'), name: `schedule-${draftId}.txt` }];
                if (res.coverFile) files.push(res.coverFile);
                await interaction.followUp({
                    content: `📄 草稿 #${draftId} 的預告文字（討論串連結已填入）${res.coverFile ? '與主視覺圖' : ''}`,
                    files,
                    allowedMentions: { parse: [] },
                });
            }
        } catch (err) {
            if (isafe.isDead(err)) {
                isafe.logDead(interaction, err, `處理日程按鈕 ${interaction.customId} 時互動已失效`);
                return;
            }
            console.error(err);
            notify.error(`處理日程按鈕 ${interaction.customId} 時發生錯誤`, err);
        }
    }
};
