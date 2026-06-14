const Discord = require('discord.js');
const { PermissionFlagsBits, InteractionContextType } = require('discord.js');
const moderation = require('../../utility/moderation.js');
const pf = require('../../utility/punishFlow.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("warn")
        .setDescription("對指定成員給予警告（累積會觸發違規過多）")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(o => o.setName("user").setDescription("處分對象").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("處分理由").setRequired(true).setMaxLength(500)),

    async execute(client, interaction) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: '只有管理員才能執行處分。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const target = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");
        await interaction.deferReply();

        // 與右鍵流程相同，但不產生證據圖（evidenceSrc 省略）
        const { pid } = await moderation.finalizePunishment({
            guild: interaction.guild, executorId: interaction.user.id,
            targetUserId: target.id, type: 'warn', durationMin: null,
            reason, source: 'manual',
        });

        // 公開告知 + 30 秒撤回按鈕（限原處分者）
        const embed = pf.buildPunishNotice({ executorId: interaction.user.id, targetUserId: target.id, type: 'warn', reason, pid });
        await interaction.editReply({ embeds: [embed], components: [pf.revokeRow(pid, interaction.user.id)] });
        setTimeout(() => interaction.editReply({ components: [] }).catch(() => {}), pf.REVOKE_WINDOW_MS);
    }
};
