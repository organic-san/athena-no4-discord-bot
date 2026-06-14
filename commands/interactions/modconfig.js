const Discord = require('discord.js');
const { PermissionFlagsBits, ChannelType, InteractionContextType } = require('discord.js');
const modConfig = require('../../utility/modConfig.js');
const moderation = require('../../utility/moderation.js');
require('dotenv').config();

const CHANNEL_KEYS = {
    admin_notify: 'admin_notify_channel_id',
    punish: 'punish_channel_id',
    report_parent: 'report_thread_parent_id',
};

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("modconfig")
        .setDescription("社群安全與審核系統設定")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(s => s.setName("show").setDescription("顯示目前設定"))
        .addSubcommand(s => s
            .setName("channel").setDescription("設定功能頻道")
            .addStringOption(o => o.setName("type").setDescription("頻道用途").setRequired(true)
                .addChoices(
                    { name: "管理員告知頻道", value: "admin_notify" },
                    { name: "處分發布頻道", value: "punish" },
                    { name: "檢舉討論串母頻道", value: "report_parent" },
                ))
            .addChannelOption(o => o.setName("channel").setDescription("目標頻道").setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand(s => s
            .setName("role").setDescription("設定管理員身分組（通報訊息會標註此身分組）")
            .addRoleOption(o => o.setName("role").setDescription("管理員身分組").setRequired(true)))
        .addSubcommand(s => s
            .setName("detection").setDescription("開關即時威脅偵測")
            .addBooleanOption(o => o.setName("enabled").setDescription("是否啟用").setRequired(true)))
        .addSubcommand(s => s
            .setName("behavior").setDescription("行為參數（只填要修改的項目）")
            .addIntegerOption(o => o.setName("mute_min").setDescription("連發禁言時長 K（分鐘）").setMinValue(1))
            .addIntegerOption(o => o.setName("context_before").setDescription("脈絡前 N 則").setMinValue(0).setMaxValue(100))
            .addIntegerOption(o => o.setName("context_after").setDescription("脈絡後 M 則").setMinValue(0).setMaxValue(100))
            .addStringOption(o => o.setName("rate_limit").setDescription("檢舉速率（次數/分鐘，如 5/5）")))
        .addSubcommandGroup(g => g
            .setName("rule").setDescription("違規過多自動處分規則")
            .addSubcommand(s => s
                .setName("add").setDescription("新增規則")
                .addIntegerOption(o => o.setName("window").setDescription("在一定時間內（小時）").setRequired(true).setMinValue(1))
                .addIntegerOption(o => o.setName("threshold").setDescription("達到 warn 次數").setRequired(true).setMinValue(1))
                .addStringOption(o => o.setName("action").setDescription("達標動作").setRequired(true)
                    .addChoices(
                        { name: "禁言 mute", value: "mute" },
                        { name: "踢出 kick", value: "kick" },
                        { name: "停權 ban（由管理員確認）", value: "ban" },
                    ))
                .addIntegerOption(o => o.setName("duration").setDescription("動作為 mute 時的時長（分鐘）").setMinValue(1)))
            .addSubcommand(s => s
                .setName("remove").setDescription("刪除規則")
                .addIntegerOption(o => o.setName("id").setDescription("規則 ID").setRequired(true)))
            .addSubcommand(s => s.setName("list").setDescription("列出所有規則"))),

    async execute(client, interaction) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: '只有管理員才能使用此指令。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        // ── 違規過多規則 ──
        if (group === 'rule') {
            if (sub === 'add') {
                const action = interaction.options.getString('action');
                const duration = interaction.options.getInteger('duration');
                if (action === 'mute' && !duration) {
                    await interaction.reply({ content: '動作為 mute 時必須提供 duration（分鐘）。', flags: Discord.MessageFlags.Ephemeral });
                    return;
                }
                const id = modConfig.addRule(
                    guildId,
                    interaction.options.getInteger('window'),
                    interaction.options.getInteger('threshold'),
                    action,
                    action === 'mute' ? duration : null,
                );
                await interaction.reply(`✅ 已新增規則 #${id}。`);
                return;
            }
            if (sub === 'remove') {
                const ok = modConfig.removeRule(guildId, interaction.options.getInteger('id'));
                await interaction.reply(ok ? '✅ 已刪除規則。' : '找不到該規則。');
                return;
            }
            if (sub === 'list') {
                const rules = modConfig.getRules(guildId);
                if (rules.length === 0) { await interaction.reply('目前沒有任何違規過多自動處分規則。'); return; }
                const lines = rules.map(r =>
                    `**#${r.id}**：${moderation.formatHours(r.window_hours)}內 warn ≥ ${r.warn_threshold} → ${moderation.TYPE_LABEL[r.action] || r.action}` +
                    (r.action === 'mute' ? `（${moderation.formatMinutes(r.duration_min)}）` : ''));
                const embed = new Discord.EmbedBuilder()
                    .setTitle('違規過多自動處分規則').setColor(0x5865F2).setDescription(lines.join('\n'));
                await interaction.reply({ embeds: [embed] });
                return;
            }
        }

        // ── show ──
        if (sub === 'show') {
            const c = modConfig.get(guildId);
            const fmtCh = id => id ? `<#${id}>` : '未設定';
            const embed = new Discord.EmbedBuilder()
                .setTitle('社群安全與審核系統設定').setColor(0x4285F4)
                .addFields(
                    { name: '管理員告知頻道', value: fmtCh(c.admin_notify_channel_id), inline: true },
                    { name: '管理員身分組', value: c.admin_role_id ? `<@&${c.admin_role_id}>` : '未設定', inline: true },
                    { name: '處分發布頻道', value: fmtCh(c.punish_channel_id), inline: true },
                    { name: '檢舉討論串母頻道', value: fmtCh(c.report_thread_parent_id), inline: true },
                    { name: '即時威脅偵測', value: c.detection_enabled ? '✅ 啟用' : '❌ 關閉', inline: true },
                    { name: '連發禁言時長 K', value: moderation.formatMinutes(c.detection_mute_min), inline: true },
                    { name: '檢舉速率', value: `${c.report_rate_limit}（次/分）`, inline: true },
                    { name: '脈絡前 N 則', value: `${c.context_before}`, inline: true },
                    { name: '脈絡後 M 則', value: `${c.context_after}`, inline: true },
                )
                .setFooter({ text: '寫死參數：偵測時間窗 30 秒、跨頻道門檻 3' });
            await interaction.reply({ embeds: [embed] });
            return;
        }

        // ── channel ──
        if (sub === 'channel') {
            const type = interaction.options.getString('type');
            const channel = interaction.options.getChannel('channel');
            modConfig.set(guildId, CHANNEL_KEYS[type], channel.id);
            await interaction.reply(`✅ 已將 **${type}** 設定為 <#${channel.id}>。`);
            return;
        }

        // ── role ──
        if (sub === 'role') {
            const role = interaction.options.getRole('role');
            modConfig.set(guildId, 'admin_role_id', role.id);
            await interaction.reply({ content: `✅ 已將管理員身分組設定為 <@&${role.id}>。`, allowedMentions: { parse: [] } });
            return;
        }

        // ── detection ──
        if (sub === 'detection') {
            const enabled = interaction.options.getBoolean('enabled');
            const c = modConfig.get(guildId);
            if (enabled && !c.admin_notify_channel_id) {
                await interaction.reply({ content: '啟用偵測前須先設定管理員告知頻道（`/modconfig channel type:管理員告知頻道`）。', flags: Discord.MessageFlags.Ephemeral });
                return;
            }
            modConfig.set(guildId, 'detection_enabled', enabled ? 1 : 0);
            await interaction.reply(`✅ 即時威脅偵測已${enabled ? '啟用' : '關閉'}。`);
            return;
        }

        // ── behavior ──
        if (sub === 'behavior') {
            const changes = [];
            const muteMin = interaction.options.getInteger('mute_min');
            const cb = interaction.options.getInteger('context_before');
            const ca = interaction.options.getInteger('context_after');
            const rl = interaction.options.getString('rate_limit');
            if (muteMin != null) { modConfig.set(guildId, 'detection_mute_min', muteMin); changes.push(`連發禁言時長 = ${muteMin} 分`); }
            if (cb != null) { modConfig.set(guildId, 'context_before', cb); changes.push(`脈絡前 = ${cb} 則`); }
            if (ca != null) { modConfig.set(guildId, 'context_after', ca); changes.push(`脈絡後 = ${ca} 則`); }
            if (rl != null) {
                if (!/^\d+\/\d+$/.test(rl)) { await interaction.reply({ content: '檢舉速率格式須為 `次數/分鐘`，例如 `5/5`。', flags: Discord.MessageFlags.Ephemeral }); return; }
                modConfig.set(guildId, 'report_rate_limit', rl); changes.push(`檢舉速率 = ${rl}`);
            }
            await interaction.reply(changes.length ? `✅ 已更新：\n- ${changes.join('\n- ')}` : '未提供任何要修改的項目。');
            return;
        }
    }
};
