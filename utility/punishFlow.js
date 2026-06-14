const Discord = require('discord.js');
const moderation = require('./moderation.js');

/**
 * 統一的「處分選擇流程」UI 與 customId 規範。
 *
 * 由兩個入口共用：
 *   - /close 結案（來源＝檢舉案件，token = `r:<reportId>`）
 *   - 右鍵「給予處分」（來源＝指定訊息，token = `m:<channelId>:<msgId>`）
 *
 * 流程：選類型 → (mute 時) 選時長 → 填理由 Modal。各步驟 customId：
 *   pf:type:<token>
 *   pf:dur:<token>
 *   pf:modal:<token>:<type>:<dur>
 *
 * token 本身含冒號，故解析時需先讀 srcType 再決定吃幾段（見 parseSource）。
 */

const TYPE_OPTIONS = [
    { label: '警告 (warn)', value: 'warn', emoji: '⚠️' },
    { label: '禁言 (mute)', value: 'mute', emoji: '🔇' },
    { label: '踢出 (kick)', value: 'kick', emoji: '👢' },
    { label: '停權 (ban)', value: 'ban', emoji: '🔨' },
];

module.exports = {
    TYPE_OPTIONS,

    reportToken: (reportId) => `r:${reportId}`,
    messageToken: (channelId, msgId) => `m:${channelId}:${msgId}`,

    /** 處分類型選單 */
    typeSelectRow(srcToken) {
        return new Discord.ActionRowBuilder().addComponents(
            new Discord.StringSelectMenuBuilder()
                .setCustomId(`pf:type:${srcToken}`)
                .setPlaceholder('選擇處分類型')
                .addOptions(TYPE_OPTIONS)
        );
    },

    /** 任意 customId 的禁言時長選單（供非 pf 流程，如 Ban 裁決改定時禁言） */
    durationSelectRowRaw(customId) {
        return new Discord.ActionRowBuilder().addComponents(
            new Discord.StringSelectMenuBuilder()
                .setCustomId(customId)
                .setPlaceholder('選擇禁言時長')
                .addOptions(moderation.DURATION_CHOICES)
        );
    },

    /** pf 流程的禁言時長選單 */
    durationSelectRow(srcToken) {
        return this.durationSelectRowRaw(`pf:dur:${srcToken}`);
    },

    /** 任意 customId 的理由 Modal（供非 pf 流程，如偵測停權） */
    reasonModalRaw(customId, type) {
        const modal = new Discord.ModalBuilder()
            .setCustomId(customId)
            .setTitle(`填寫理由 — ${moderation.TYPE_LABEL[type] || type}`);
        const input = new Discord.TextInputBuilder()
            .setCustomId('reason')
            .setLabel('處分理由')
            .setStyle(Discord.TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500);
        modal.addComponents(new Discord.ActionRowBuilder().addComponents(input));
        return modal;
    },

    /** pf 流程的理由 Modal */
    reasonModal(srcToken, type, dur = 0) {
        return this.reasonModalRaw(`pf:modal:${srcToken}:${type}:${dur}`, type);
    },

    /**
     * 解析 pf customId 在 ['pf', step] 之後的片段。
     * @param {string[]} parts 例如 ['r','42'] 或 ['m','<ch>','<msg>','mute','60']
     * @returns {{ srcType:string, args:string[], token:string, tail:string[] }|null}
     *   tail 為來源之後的剩餘片段（modal step 的 [type, dur]）
     */
    parseSource(parts) {
        const srcType = parts[0];
        if (srcType === 'r') return { srcType, args: [parts[1]], token: `r:${parts[1]}`, tail: parts.slice(2) };
        if (srcType === 'm') return { srcType, args: [parts[1], parts[2]], token: `m:${parts[1]}:${parts[2]}`, tail: parts.slice(3) };
        return null;
    },

    /** 將分鐘數轉為可讀標籤（委派 moderation，單一定義來源） */
    durationLabel(min) {
        return moderation.durationLabel(min);
    },
};
