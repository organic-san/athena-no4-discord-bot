const Discord = require('discord.js');
const DB = require('./database.js');
const func = require('./functions.js');
const modConfig = require('./modConfig.js');
require('dotenv').config();

const db = DB.getConnection();

// Discord timeout 上限為 28 天，作為「無限期凍結」使用；duration_min = -1 代表凍結。
const FREEZE_MIN = 28 * 24 * 60; // 40320
const MAX_TIMEOUT_MS = FREEZE_MIN * 60 * 1000 - 1000; // 略低於 Discord 28 天上限，避免邊界被拒

// 禁言時長選單（分鐘）。上限 28 天為 Discord timeout 上限。
const DURATION_CHOICES = [
    { label: '5 分鐘', value: '5' },
    { label: '10 分鐘', value: '10' },
    { label: '30 分鐘', value: '30' },
    { label: '1 小時', value: '60' },
    { label: '4 小時', value: '240' },
    { label: '8 小時', value: '480' },
    { label: '1 天', value: '1440' },
    { label: '3 天', value: '4320' },
    { label: '7 天', value: '10080' },
    { label: '14 天', value: '20160' },
    { label: '28 天', value: '40320' },
];

const TYPE_LABEL = { warn: '警告', mute: '禁言', kick: '踢出', ban: '停權' };
const SOURCE_LABEL = { manual: '管理員處理', report_close: '檢舉結案', auto_escalation: '違規過多', detection: '偵測停權' };

module.exports = {
    FREEZE_MIN,
    DURATION_CHOICES,
    TYPE_LABEL,
    SOURCE_LABEL,

    /** 分鐘 → 可讀時間（1440 的倍數顯示為天、60 的倍數顯示為小時，否則分鐘）。 */
    formatMinutes(min) {
        min = Number(min);
        if (min < 0) return '無限期';
        if (min === 0) return '0 分鐘';
        if (min % 1440 === 0) return `${min / 1440} 天`;
        if (min % 60 === 0) return `${min / 60} 小時`;
        return `${min} 分鐘`;
    },

    /** 小時 → 可讀時間（24 的倍數顯示為天，否則小時）。 */
    formatHours(hours) {
        hours = Number(hours);
        if (hours % 24 === 0 && hours !== 0) return `${hours / 24} 天`;
        return `${hours} 小時`;
    },

    /** 將禁言分鐘數轉為可讀標籤（統一委派 formatMinutes）。 */
    durationLabel(min) {
        return this.formatMinutes(min);
    },

    /** 組合處分紀錄查詢用的 embed（/modlog 與 /modlog-me 共用）。 */
    buildModlogEmbed(user, records, activeWarns) {
        const lines = records.map(r => {
            const time = (r.created_at || '').replace('T', ' ');
            const dur = r.type === 'mute' && r.duration_min != null
                ? (r.duration_min < 0 ? '（無限期凍結）' : `（${this.durationLabel(r.duration_min)}）`) : '';
            const revoked = r.revoked ? ' ~~已撤銷~~' : '';
            const src = SOURCE_LABEL[r.source] || r.source;
            return `**#${r.id}** \`${TYPE_LABEL[r.type] || r.type}\`${dur}${revoked} — ${src}\n` +
                `　${time}　理由：${r.reason || '（無）'}`;
        });
        return new Discord.EmbedBuilder()
            .setTitle(`📒 ${user.username} 的處分紀錄`)
            .setColor(0x5865F2)
            .setDescription(lines.join('\n\n').slice(0, 4000) || '（無）')
            .setFooter({ text: `共 ${records.length} 筆（最多顯示 25 筆）｜未撤銷警告：${activeWarns}` });
    },

    /**
     * 寫入一筆處分紀錄，回傳新紀錄 id。
     */
    insertPunishment({ guildId, targetUserId, type, durationMin = null, reason = null,
        evidenceMsgId = null, source, executorId }) {
        const info = db.prepare(
            `INSERT INTO punishment
                (guild_id, target_user_id, type, duration_min, reason, evidence_msg_id, source, executor_id, revoked, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
        ).run(guildId, targetUserId, type, durationMin, reason, evidenceMsgId, source, executorId, func.localISOTimeNow());
        return info.lastInsertRowid;
    },

    getPunishment(id) {
        return db.prepare(`SELECT * FROM punishment WHERE id = ?`).get(id);
    },

    setEvidenceMsg(id, msgId) {
        db.prepare(`UPDATE punishment SET evidence_msg_id = ? WHERE id = ?`).run(msgId, id);
    },

    updatePunishment(id, fields) {
        const keys = Object.keys(fields);
        if (keys.length === 0) return;
        const set = keys.map(k => `${k} = ?`).join(', ');
        db.prepare(`UPDATE punishment SET ${set} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
    },

    revokePunishment(id) {
        const info = db.prepare(
            `UPDATE punishment SET revoked = 1, revoked_at = ? WHERE id = ? AND revoked = 0`
        ).run(func.localISOTimeNow(), id);
        return info.changes > 0;
    },

    getUserPunishments(guildId, userId, limit = 25) {
        return db.prepare(
            `SELECT * FROM punishment WHERE guild_id = ? AND target_user_id = ?
             ORDER BY created_at DESC LIMIT ?`
        ).all(guildId, userId, limit);
    },

    /** 計算某用戶在時間窗（小時）內未撤銷的 warn 數。 */
    countWarns(guildId, userId, windowHours) {
        const since = new Date(Date.now() - windowHours * 3600 * 1000);
        const tzoffset = since.getTimezoneOffset() * 60000;
        const sinceISO = new Date(since.getTime() - tzoffset).toISOString().slice(0, 19);
        const r = db.prepare(
            `SELECT COUNT(*) AS c FROM punishment
             WHERE guild_id = ? AND target_user_id = ? AND type = 'warn' AND revoked = 0 AND created_at >= ?`
        ).get(guildId, userId, sinceISO);
        return r.c;
    },

    /**
     * 在 Discord 上實際執行處分。呼叫端需自行 try/catch。
     * @returns {Promise<{ok:boolean, error?:string}>}
     */
    async applyDiscordAction(guild, userId, type, durationMin, reason) {
        if (type === 'warn') return { ok: true };

        if (type === 'ban') {
            await guild.bans.create(userId, { reason: reason || '審核系統處分' });
            return { ok: true };
        }

        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return { ok: false, error: '找不到該成員（可能已離開伺服器）。' };

        if (type === 'mute') {
            const ms = durationMin != null && durationMin >= 0
                ? Math.min(durationMin * 60000, MAX_TIMEOUT_MS)
                : MAX_TIMEOUT_MS;
            await member.timeout(ms, reason || '審核系統處分');
            return { ok: true };
        }
        if (type === 'kick') {
            await member.kick(reason || '審核系統處分');
            return { ok: true };
        }
        return { ok: false, error: `未知的處分類型：${type}` };
    },

    /** 解除某成員的禁言／凍結。 */
    async clearTimeout(guild, userId, reason) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return { ok: false, error: '找不到該成員。' };
        await member.timeout(null, reason || '解除禁言');
        return { ok: true };
    },

    /** 將處分結論貼到處分發布頻道，回傳該訊息 id（無頻道則回 null）。 */
    async postPunishmentLog(guild, embed, files = []) {
        const conf = modConfig.get(guild.id);
        if (!conf.punish_channel_id) return null;
        const channel = await guild.channels.fetch(conf.punish_channel_id).catch(() => null);
        if (!channel) return null;
        const sent = await channel.send({ embeds: [embed], files }).catch(() => null);
        return sent ? sent.id : null;
    },

    /**
     * 完整撤回一筆處分：標記撤回 + 解除該用戶禁言（停權則 unban）+ 於處分頻道發布撤回訊息。
     * 供 /modrevoke 與撤回按鈕共用。
     * @returns {Promise<{ok:boolean, error?:string, already?:boolean, punishment?:object, unmuteErr?:string, unbanErr?:string}>}
     */
    async revokePunishmentFull(guild, id, executorId) {
        const p = this.getPunishment(id);
        if (!p) return { ok: false, error: '找不到該處分。' };
        if (p.guild_id !== guild.id) return { ok: false, error: '該處分不屬於本伺服器。' };
        if (p.revoked) return { ok: false, already: true, error: '該處分已是撤回狀態。' };

        this.revokePunishment(id);

        // 解除該用戶禁言狀態；停權則改為 unban（已 ban 的用戶不在伺服器，不需解禁）
        let unmuteErr = null, unbanErr = null;
        if (p.type === 'ban') {
            try { await guild.bans.remove(p.target_user_id, `撤回處分 #${id}`); }
            catch (e) { unbanErr = String(e?.message || e); }
        } else {
            const r = await this.clearTimeout(guild, p.target_user_id, `撤回處分 #${id}`)
                .catch(e => ({ ok: false, error: String(e?.message || e) }));
            // 找不到成員（已離開）視為無需解禁，不算錯誤
            if (!r.ok && r.error !== '找不到該成員。') unmuteErr = r.error;
        }

        // 於處分頻道發布撤回標示
        const embed = new Discord.EmbedBuilder()
            .setTitle(`↩️ 撤回處分 #${id}`)
            .setColor(0x99AAB5)
            .addFields(
                { name: '原處分', value: TYPE_LABEL[p.type] || p.type, inline: true },
                { name: '對象', value: `<@${p.target_user_id}>`, inline: true },
                { name: '操作者', value: executorId === 'SYSTEM' ? 'SYSTEM' : `<@${executorId}>`, inline: true },
                { name: '原理由', value: p.reason || '（無）' },
            )
            .setTimestamp();
        if (p.type === 'ban') embed.addFields({ name: '處置', value: unbanErr ? `⚠️ 解除停權失敗：${unbanErr}` : '已解除停權（unban）' });
        else embed.addFields({ name: '處置', value: unmuteErr ? `⚠️ 解除禁言失敗：${unmuteErr}` : '已解除禁言狀態' });
        await this.postPunishmentLog(guild, embed);

        return { ok: true, punishment: p, unmuteErr, unbanErr };
    },

    /**
     * 新增 warn 後檢查違規過多並自動處置。
     * @returns {Promise<{action:string, ruleId:number}|null>} 觸發的動作，未觸發回 null。
     */
    async checkEscalation(guild, userId) {
        const rules = modConfig.getRules(guild.id); // 已依 warn_threshold DESC 排序
        let matched = null;
        for (const rule of rules) {
            const cnt = this.countWarns(guild.id, userId, rule.window_hours);
            if (cnt >= rule.warn_threshold) { matched = rule; break; }
        }
        if (!matched) return null;

        const action = matched.action;
        const reason = `違規過多：${this.formatHours(matched.window_hours)}內警告達 ${matched.warn_threshold} 次`;
        console.log(`[auto] 違規過多觸發：${guild.name} (${guild.id}), user ${userId}, 規則 #${matched.id} → ${action}`);

        if (action === 'ban') {
            // Ban 永遠經人類拍板：先以無限期凍結止血，再發 Ban 裁決訊息。
            const res = await this.applyDiscordAction(guild, userId, 'mute', -1, reason).catch(e => ({ ok: false, error: String(e) }));
            const freezeId = this.insertPunishment({
                guildId: guild.id, targetUserId: userId, type: 'mute', durationMin: -1,
                reason: reason + '（待管理員裁決）', source: 'auto_escalation', executorId: 'SYSTEM',
            });
            await this.postBanVerdict(guild, freezeId, userId, reason, res.ok ? null : res.error);
            return { action: 'ban-pending', ruleId: matched.id };
        }

        // warn / mute / kick：自動執行 + 記錄 + 發布
        const res = await this.applyDiscordAction(guild, userId, action, matched.duration_min, reason)
            .catch(e => ({ ok: false, error: String(e) }));
        const pid = this.insertPunishment({
            guildId: guild.id, targetUserId: userId, type: action, durationMin: matched.duration_min ?? null,
            reason, source: 'auto_escalation', executorId: 'SYSTEM',
        });

        const embed = new Discord.EmbedBuilder()
            .setTitle(`⚙️ 違規過多處置：${TYPE_LABEL[action] || action}`)
            .setColor(0xE67E22)
            .setDescription(`<@${userId}> 觸發違規過多處置。`)
            .addFields(
                { name: '處分編號', value: `#${pid}`, inline: true },
                { name: '類型', value: TYPE_LABEL[action] || action, inline: true },
                { name: '理由', value: reason },
            )
            .setTimestamp();
        if (action === 'mute' && matched.duration_min) {
            embed.addFields({ name: '時長', value: this.formatMinutes(matched.duration_min), inline: true });
        }
        if (!res.ok) embed.addFields({ name: '⚠️ 執行狀態', value: res.error || '執行失敗' });
        const msgId = await this.postPunishmentLog(guild, embed);
        if (msgId) this.setEvidenceMsg(pid, msgId);

        return { action, ruleId: matched.id };
    },

    /** 在管理員告知頻道發送 Ban 裁決訊息。 */
    async postBanVerdict(guild, freezePunishmentId, userId, reason, freezeError) {
        const conf = modConfig.get(guild.id);
        if (!conf.admin_notify_channel_id) return;
        const channel = await guild.channels.fetch(conf.admin_notify_channel_id).catch(() => null);
        if (!channel) return;

        const embed = new Discord.EmbedBuilder()
            .setTitle('🔨 用戶違規過多停權確認')
            .setColor(0xED4245)
            .setDescription(`<@${userId}> 因違規過多已達停權 Ban 門檻，暫時處分**無限期禁言**。\n須由管理員判斷最終處置。`)
            .addFields(
                { name: '對象', value: `<@${userId}> (${userId})` },
                { name: '理由', value: reason },
            )
            .setTimestamp();
        if (freezeError) embed.addFields({ name: '⚠️ 凍結狀態', value: freezeError });

        const row = new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setCustomId(`ban:confirm:${freezePunishmentId}:${userId}`)
                .setLabel('正式 Ban').setStyle(Discord.ButtonStyle.Danger).setEmoji('🔨'),
            new Discord.ButtonBuilder()
                .setCustomId(`ban:totimeout:${freezePunishmentId}:${userId}`)
                .setLabel('改為定時禁言').setStyle(Discord.ButtonStyle.Primary).setEmoji('⏳'),
            new Discord.ButtonBuilder()
                .setCustomId(`ban:unmute:${freezePunishmentId}:${userId}`)
                .setLabel('解除禁言').setStyle(Discord.ButtonStyle.Secondary).setEmoji('✅'),
        );

        const { content, allowedMentions } = modConfig.adminMention(guild.id);
        await channel.send({ content, embeds: [embed], components: [row], allowedMentions }).catch(console.error);
    },
};
