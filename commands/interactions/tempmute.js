const Discord = require('discord.js');
const { PermissionFlagsBits, InteractionContextType } = require('discord.js');
const moderation = require('../../utility/moderation.js');
const pf = require('../../utility/punishFlow.js');
require('dotenv').config();

// 時長選項沿用統一定義（moderation.DURATION_CHOICES），轉成整數型 slash 選項
const DURATION_OPTIONS = moderation.DURATION_CHOICES.map(c => ({ name: c.label, value: Number(c.value) }));

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("tempmute")
        .setDescription("對指定成員定時禁言")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(o => o.setName("user").setDescription("處分對象").setRequired(true))
        .addIntegerOption(o => o.setName("duration").setDescription("禁言時長").setRequired(true).addChoices(...DURATION_OPTIONS))
        .addStringOption(o => o.setName("reason").setDescription("處分理由").setRequired(true).setMaxLength(500)),

    async execute(client, interaction) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
            await interaction.reply({ content: '你沒有禁言成員的權限。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const target = interaction.options.getUser("user");
        const durationMin = interaction.options.getInteger("duration");
        const reason = interaction.options.getString("reason");
        await interaction.deferReply();

        // 與右鍵流程相同，但不產生證據圖（evidenceSrc 省略）
        const { pid } = await moderation.finalizePunishment({
            guild: interaction.guild, executorId: interaction.user.id,
            targetUserId: target.id, type: 'mute', durationMin,
            reason, source: 'manual',
        });

        // 公開告知 + 30 秒撤回按鈕（限原處分者）
        const embed = pf.buildPunishNotice({ executorId: interaction.user.id, targetUserId: target.id, type: 'mute', durationMin, reason, pid });
        await interaction.editReply({ embeds: [embed], components: [pf.revokeRow(pid, interaction.user.id)] });
        setTimeout(() => interaction.editReply({ components: [] }).catch(() => {}), pf.REVOKE_WINDOW_MS);
    }
};
