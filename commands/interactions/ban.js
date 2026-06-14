const Discord = require('discord.js');
const { PermissionFlagsBits, InteractionContextType } = require('discord.js');
const moderation = require('../../utility/moderation.js');
const pf = require('../../utility/punishFlow.js');
require('dotenv').config();

// 刪除訊息時間選項沿用統一定義（含「不刪除」），轉成整數型 slash 選項
const DELETE_OPTIONS = moderation.DELETE_CHOICES.map(c => ({ name: c.label, value: Number(c.value) }));

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("ban")
        .setDescription("將指定使用者停權（Ban）")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addUserOption(o => o.setName("user").setDescription("處分對象").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("處分理由").setRequired(true).setMaxLength(500))
        .addIntegerOption(o => o.setName("delete").setDescription("刪除多久內的訊息").setRequired(true).addChoices(...DELETE_OPTIONS)),

    async execute(client, interaction) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
            await interaction.reply({ content: '你沒有停權成員的權限。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const target = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");
        const banDeleteSeconds = interaction.options.getInteger("delete") ?? 0;
        await interaction.deferReply();

        // 與右鍵流程相同，但不產生證據圖（evidenceSrc 省略）
        const { pid } = await moderation.finalizePunishment({
            guild: interaction.guild, executorId: interaction.user.id,
            targetUserId: target.id, type: 'ban', durationMin: null,
            reason, source: 'manual', banDeleteSeconds,
        });

        // 公開告知 + 30 秒撤回按鈕（限原處分者）
        const embed = pf.buildPunishNotice({ executorId: interaction.user.id, targetUserId: target.id, type: 'ban', reason, pid });
        await interaction.editReply({ embeds: [embed], components: [pf.revokeRow(pid, interaction.user.id)] });
        setTimeout(() => interaction.editReply({ components: [] }).catch(() => {}), pf.REVOKE_WINDOW_MS);
    }
};
