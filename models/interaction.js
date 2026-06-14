const Discord = require('discord.js');
require('dotenv').config();

module.exports = {
    name: "interaction",
    event: Discord.Events.InteractionCreate,
    async execute(client, interaction) {
        // 處理斜線指令與右鍵選單（Message Context Menu）；其餘（按鈕/選單/Modal）交給 modInteraction.js
        if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;

        const command = client.interactionCmds.get(interaction.commandName);
        if (!command) return;

        let commandName = interaction.commandName;
        if (interaction.isChatInputCommand() && interaction.options.getSubcommand(false)) {
            commandName += "/" + interaction.options.getSubcommand(false);
        }
        const kind = interaction.isMessageContextMenuCommand() ? 'context menu' : 'slash command';
        console.log(`${kind}: ${commandName}, from: ${interaction.guild?.name ?? 'DM'}, user: ${interaction.user.tag} (ID: ${interaction.user.id})`);

        try {
            if (command.tag === "interaction") await command.execute(client, interaction);
        } catch (error) {
            console.error(error);
            try {
                const msg = "在處理過程中發生意外的錯誤：```" + error + "```請稍後再試一次。\n" + `<@${process.env.AUTHOR_USERID}>`;
                await interaction.reply({ content: msg }).catch(async () => {
                    await interaction.editReply({ content: msg, embeds: [], components: [] });
                });
            } catch (err) {
                console.error(err);
            }
        }
    }
}