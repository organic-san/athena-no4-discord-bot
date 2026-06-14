const Discord = require('discord.js');
const DB = require('./database.js');
const func = require('./functions.js');
const modConfig = require('./modConfig.js');
const evidence = require('./evidence.js');
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
        // 排除「違規過多待裁決凍結」：它只是暫時止血的 hold，本身不計為處分，
        // 待管理員以 confirm/dur 裁決後才會就地轉成真正的處分（停權／定時禁言）。
        return db.prepare(
            `SELECT * FROM punishment WHERE guild_id = ? AND target_user_id = ? AND source != 'escalation_freeze'
             ORDER BY created_at DESC LIMIT ?`
        ).all(guildId, userId, limit);
    },

    // ── 違規過多待裁決凍結（escalation_freeze）：暫時 hold，非處分 ──
    /** 取得某用戶尚未裁決的凍結（用於避免重複觸發）。 */
    getPendingFreeze(guildId, userId) {
        return db.prepare(
            `SELECT * FROM punishment WHERE guild_id = ? AND target_user_id = ?
             AND source = 'escalation_freeze' AND revoked = 0 ORDER BY id DESC LIMIT 1`
        ).get(guildId, userId);
    },

    /**
     * 原子地「認領並轉換」一筆待裁決凍結為真正的處分（compare-and-swap）。
     * WHERE 條件含 source='escalation_freeze'，故並發/連點只有第一個會成功，杜絕重複資料。
     * @returns {boolean} 是否由本次呼叫認領成功。
     */
    resolveFreeze(id, fields) {
        const keys = Object.keys(fields);
        const set = keys.map(k => `${k} = ?`).join(', ');
        const info = db.prepare(
            `UPDATE punishment SET ${set} WHERE id = ? AND source = 'escalation_freeze'`
        ).run(...keys.map(k => fields[k]), id);
        return info.changes > 0;
    },

    /** 原子地刪除一筆待裁決凍結（解除凍結用；非處分故直接移除，不留撤回紀錄）。 */
    deleteFreeze(id) {
        const info = db.prepare(`DELETE FROM punishment WHERE id = ? AND source = 'escalation_freeze'`).run(id);
        return info.changes > 0;
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
        const rules = modConfig.getRules(guild.id); // 已依「嚴重度 → 門檻」排序，取第一條達標者
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
            // 已有未裁決的凍結則不重複觸發（避免堆疊多筆 hold 與重複裁決訊息）。
            if (this.getPendingFreeze(guild.id, userId)) {
                console.log(`[auto] 違規過多：user ${userId} 已有待裁決凍結，略過重複觸發`);
                return { action: 'ban-pending', ruleId: matched.id };
            }
            // Ban 永遠經人類拍板：先以無限期凍結止血（source=escalation_freeze，本身不計處分），再發 Ban 裁決訊息。
            const res = await this.applyDiscordAction(guild, userId, 'mute', -1, reason).catch(e => ({ ok: false, error: String(e) }));
            const freezeId = this.insertPunishment({
                guildId: guild.id, targetUserId: userId, type: 'mute', durationMin: -1,
                reason, source: 'escalation_freeze', executorId: 'SYSTEM',
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

    /**
     * 統一處分收尾：Discord 執行 → 寫紀錄 → (可選)證據圖&結論發布 → 違規過多檢查 →（如有檢舉）更新 report。
     * 由右鍵「給予處分」、/close 結案、Ban 裁決、偵測停權、以及 /warn /tempmute /kick /ban 共用。
     * evidenceSrc 省略（null）時不產生任何圖片，僅發送純文字結論 embed。
     * @returns {Promise<{ pid:number, summary:string }>}
     */
    async finalizePunishment({ guild, executorId, targetUserId, type, durationMin = null, reason, source, report = null, evidenceSrc = null }) {
        // 1. Discord 實際執行
        let actionResult;
        try {
            actionResult = await this.applyDiscordAction(guild, targetUserId, type, durationMin, reason);
        } catch (e) {
            actionResult = { ok: false, error: String(e?.message || e) };
        }

        // 2. 寫入紀錄
        const pid = this.insertPunishment({
            guildId: guild.id, targetUserId, type,
            durationMin: type === 'mute' ? durationMin : null,
            reason, source, executorId,
        });

        // 2.5 warn → 違規過多檢查（緊接 insert，中間無 await：insert 與 countWarns 在同一 tick
        //      內完成，兩者的計算對並發呼叫具原子性，避免同一人並發 warn 時重複數到。）
        let esc = null;
        if (type === 'warn') {
            esc = await this.checkEscalation(guild, targetUserId).catch(e => { console.error('escalation error:', e); return null; });
        }

        // 3. 證據圖 + 結論 → 處分發布頻道
        //    證據來源統一為描述物件：{ render: 訊息 }（重繪卡片）或 { transcribe: 訊息 }（轉貼既有圖）；
        //    省略時（如斜線指令）不產生任何圖片。
        const files = [];
        if (evidenceSrc?.render) {
            const card = await evidence.renderMessageCard(evidenceSrc.render, { embedImages: true }).catch(() => null);
            if (card) files.push(card.setSpoiler(true));
        }
        if (evidenceSrc?.transcribe) {
            files.push(...await evidence.transcribeImages(evidenceSrc.transcribe).catch(() => []));
        }
        const embed = new Discord.EmbedBuilder()
            .setTitle(`⚖️ 處分執行 — ${TYPE_LABEL[type] || type}`)
            .setColor(type === 'ban' ? 0xED4245 : type === 'warn' ? 0xFAA61A : 0xE67E22)
            .addFields(
                { name: '處分編號', value: `#${pid}`, inline: true },
                { name: '對象', value: `<@${targetUserId}>`, inline: true },
                { name: '執行者', value: `<@${executorId}>`, inline: true },
                { name: '理由', value: reason || '（未填寫）' },
            )
            .setTimestamp();
        if (type === 'mute' && durationMin) embed.addFields({ name: '時長', value: this.durationLabel(durationMin), inline: true });
        if (report) embed.setFooter({ text: `來自檢舉案件 #${report.id}` });
        if (!actionResult.ok) embed.addFields({ name: '⚠️ 執行狀態', value: actionResult.error || '執行失敗（紀錄已保存）' });

        const logMsgId = await this.postPunishmentLog(guild, embed, files);
        if (logMsgId) this.setEvidenceMsg(pid, logMsgId);

        // 4. 更新檢舉案件
        if (report) {
            db.prepare(`UPDATE report SET status = 'closed', punishment_id = ?, closed_at = ? WHERE id = ?`)
                .run(pid, func.localISOTimeNow(), report.id);
        }

        // 5. 違規過多結果（已於 2.5 取得 esc）轉為摘要附註
        let escalationNote = '';
        if (esc?.action === 'ban-pending') escalationNote = '\n⚙️ 違規過多 Ban 警告：已凍結發言權限，於管理員頻道發送裁決訊息。';
        else if (esc) escalationNote = `\n⚙️ 違規過多觸發：${TYPE_LABEL[esc.action] || esc.action}。`;

        const statusNote = actionResult.ok ? '' : `\n⚠️ Discord 執行未完成：${actionResult.error}（紀錄已保存）`;
        const summary = `✅ 已對 <@${targetUserId}> 執行**${TYPE_LABEL[type] || type}**（處分 #${pid}）。${statusNote}${escalationNote}`;
        return { pid, summary };
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
