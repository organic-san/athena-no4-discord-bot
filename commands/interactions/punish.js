const Discord = require('discord.js');
const { ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const pf = require('../../utility/punishFlow.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new ContextMenuCommandBuilder()
        .setName("給予處分")
        .setType(ApplicationCommandType.Message)
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '此指令僅能在伺服器中使用。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: '只有管理員才能給予處分。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const target = interaction.targetMessage;
        if (target.author.bot) {
            await interaction.reply({ content: '無法對機器人訊息給予處分。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        // 進入統一處分流程（來源＝指定訊息）：選類型 → (mute) 選時長 → 填理由
        const token = pf.messageToken(target.channel.id, target.id);
        await interaction.reply({
            content: `請選擇要對 <@${target.author.id}> 執行的處分：`,
            components: [pf.typeSelectRow(token)],
            flags: Discord.MessageFlags.Ephemeral,
        });
    }
};
