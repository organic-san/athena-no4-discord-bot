const Discord = require('discord.js');
const { PermissionFlagsBits, ChannelType, InteractionContextType } = require('discord.js');
const gptConfig = require('../../utility/gptConfig.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("chatconfig")
        .setDescription("設定可以 @ 我聊天的頻道（可多個）")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(s => s
            .setName("add").setDescription("新增一個聊天頻道")
            .addChannelOption(o => o.setName("channel").setDescription("允許 @ 我聊天的頻道").setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand(s => s
            .setName("remove").setDescription("移除一個聊天頻道")
            .addChannelOption(o => o.setName("channel").setDescription("要移除的頻道").setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand(s => s.setName("list").setDescription("列出目前所有聊天頻道"))
        .addSubcommand(s => s.setName("clear").setDescription("清除全部（停用 @ 聊天）")),

    async execute(client, interaction) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: '只有管理員才能設定。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (sub === 'add') {
            const channel = interaction.options.getChannel('channel');
            const added = gptConfig.addChannel(guildId, channel.id);
            await interaction.reply(added
                ? `✅ 已新增聊天頻道 <#${channel.id}>，在該頻道 @我 即可和我聊天。`
                : `<#${channel.id}> 已經是聊天頻道了。`);
            return;
        }
        if (sub === 'remove') {
            const channel = interaction.options.getChannel('channel');
            const removed = gptConfig.removeChannel(guildId, channel.id);
            await interaction.reply(removed ? `✅ 已移除 <#${channel.id}>。` : `<#${channel.id}> 不在聊天頻道清單中。`);
            return;
        }
        if (sub === 'list') {
            const list = gptConfig.getChannels(guildId);
            await interaction.reply(list.length
                ? `目前可以 @我 聊天的頻道：\n${list.map(id => `- <#${id}>`).join('\n')}`
                : '尚未設定任何聊天頻道（@ 我聊天目前停用）。');
            return;
        }
        if (sub === 'clear') {
            gptConfig.clear(guildId);
            await interaction.reply('✅ 已清除全部，目前本伺服器不能以 @ 我聊天。');
            return;
        }
    }
};
