const Discord = require('discord.js');
const { PermissionFlagsBits, ChannelType, InteractionContextType } = require('discord.js');
const gptConfig = require('../../utility/gptConfig.js');
const serverRules = require('../../utility/serverRules.js');
const isafe = require('../../utility/interactionSafe.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("chatconfig")
        .setDescription("設定可以 @ 我聊天的頻道與規則頻道")
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
        .addSubcommand(s => s.setName("clear").setDescription("清除全部（停用 @ 聊天）"))
        .addSubcommand(s => s
            .setName("rules").setDescription("設定規則頻道，讓我能讀取伺服器規則（不填頻道則移除）")
            .addChannelOption(o => o.setName("channel").setDescription("放置伺服器規則的頻道").setRequired(false)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))),

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
            const rulesId = gptConfig.getRulesChannel(guildId);
            const channels = list.length
                ? `目前可以 @我 聊天的頻道：\n${list.map(id => `- <#${id}>`).join('\n')}`
                : '尚未設定任何聊天頻道（@ 我聊天目前停用）。';
            await interaction.reply(`${channels}\n規則頻道：${rulesId ? `<#${rulesId}>` : '未設定'}`);
            return;
        }
        if (sub === 'clear') {
            gptConfig.clear(guildId);
            await interaction.reply('✅ 已清除全部，目前本伺服器不能以 @ 我聊天。');
            return;
        }
        if (sub === 'rules') {
            const channel = interaction.options.getChannel('channel');
            serverRules.invalidate(guildId);
            if (!channel) {
                gptConfig.setRulesChannel(guildId, null);
                await interaction.reply('✅ 已移除規則頻道，我將無法讀取伺服器規則。');
                return;
            }

            const perms = channel.permissionsFor?.(client.user);
            if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
                await interaction.reply({
                    content: `我在 <#${channel.id}> 沒有「檢視頻道」與「讀取訊息歷史」權限，無法讀取規則。`,
                    flags: Discord.MessageFlags.Ephemeral,
                });
                return;
            }

            // 設定後立即試讀一次：確認讀得到內容，同時預熱快取。讀取訊息可能超過 3 秒，先 defer。
            if (!await isafe.safeDefer(interaction)) return;
            gptConfig.setRulesChannel(guildId, channel.id);
            try {
                const text = await serverRules.get(interaction.guild);
                await interaction.editReply(text
                    ? `✅ 已設定規則頻道 <#${channel.id}>，讀到 ${text.length} 字。\n規則內容會快取 1 小時；修改規則後重新執行本指令即可立即更新。`
                    : `⚠️ 已設定規則頻道 <#${channel.id}>，但目前讀不到任何文字內容。`);
            } catch (err) {
                await interaction.editReply(`⚠️ 已設定規則頻道 <#${channel.id}>，但讀取失敗：${err.message}`);
            }
            return;
        }
    }
};
