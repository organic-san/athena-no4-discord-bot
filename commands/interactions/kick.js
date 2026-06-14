const Discord = require('discord.js');
const { PermissionFlagsBits, InteractionContextType } = require('discord.js');
const moderation = require('../../utility/moderation.js');
const pf = require('../../utility/punishFlow.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("kick")
        .setDescription("將指定成員踢出伺服器")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
        .addUserOption(o => o.setName("user").setDescription("處分對象").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("處分理由").setRequired(true).setMaxLength(500)),

    async execute(client, interaction) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)) {
            await interaction.reply({ content: '你沒有踢出成員的權限。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const target = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");
        await interaction.deferReply();

        // 與右鍵流程相同，但不產生證據圖（evidenceSrc 省略）
        const { pid } = await moderation.finalizePunishment({
            guild: interaction.guild, executorId: interaction.user.id,
            targetUserId: target.id, type: 'kick', durationMin: null,
            reason, source: 'manual',
        });

        // 公開告知 + 30 秒撤回按鈕（限原處分者）
        const embed = pf.buildPunishNotice({ executorId: interaction.user.id, targetUserId: target.id, type: 'kick', reason, pid });
        await interaction.editReply({ embeds: [embed], components: [pf.revokeRow(pid, interaction.user.id)] });
        setTimeout(() => interaction.editReply({ components: [] }).catch(() => {}), pf.REVOKE_WINDOW_MS);
    }
};
