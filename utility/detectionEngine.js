const crypto = require('crypto');

// 寫死的判定參數（不開放設定）
const WINDOW_MS = 30 * 1000;       // 時間窗 30 秒
const CHANNEL_THRESHOLD = 4;       // 跨頻道數門檻

// userId → Array<{ channelId, fingerprint, ts }>
const records = new Map();

function makeFingerprint(content, attachmentCount) {
    // 僅在「正規化後仍有文字」時才產生文字指紋；空字串／undefined（含失去
    // Message Content intent 時的空 content）一律不產生 txt 指紋，避免被誤判為相同內容。
    const normalized = (content || '').trim().toLowerCase();
    if (normalized.length > 0) {
        return 'txt:' + crypto.createHash('sha1').update(normalized).digest('hex');
    }
    if (Number(attachmentCount) > 0) {
        return 'att:' + attachmentCount;
    }
    return null; // 無內容、無附件 → 不納入偵測
}

module.exports = {
    WINDOW_MS,
    CHANNEL_THRESHOLD,
    makeFingerprint,

    /**
     * 紀錄一則訊息並判定是否觸發跨頻道連發。
     * 指紋僅含 hash 與 metadata，30 秒後即清除，無任何持久化。
     * @returns {{triggered:boolean, fingerprint?:string, channels?:string[]}}
     */
    record(userId, channelId, content, attachmentCount, now = Date.now()) {
        const fingerprint = makeFingerprint(content, attachmentCount);
        if (!fingerprint) return { triggered: false };

        let arr = records.get(userId);
        if (!arr) { arr = []; records.set(userId, arr); }

        arr.push({ channelId, fingerprint, ts: now });

        // 滑動視窗：清除超過 30 秒的舊紀錄
        const cutoff = now - WINDOW_MS;
        arr = arr.filter(r => r.ts >= cutoff);
        records.set(userId, arr);

        // 統計相同 fingerprint 涵蓋的不重複頻道數
        const channels = new Set();
        for (const r of arr) {
            if (r.fingerprint === fingerprint) channels.add(r.channelId);
        }

        if (channels.size >= CHANNEL_THRESHOLD) {
            // 觸發後清除此用戶該指紋的紀錄，避免短時間內重複觸發
            const remaining = arr.filter(r => r.fingerprint !== fingerprint);
            records.set(userId, remaining);
            return { triggered: true, fingerprint, channels: [...channels] };
        }

        return { triggered: false };
    },

    /** 定期清理過期 / 空陣列。 */
    cleanup(now = Date.now()) {
        const cutoff = now - WINDOW_MS;
        for (const [userId, arr] of records) {
            const kept = arr.filter(r => r.ts >= cutoff);
            if (kept.length === 0) records.delete(userId);
            else records.set(userId, kept);
        }
    },

    _size() { return records.size; },
};

// 定期清理記憶體（每 60 秒）
const timer = setInterval(() => module.exports.cleanup(), 60 * 1000);
timer.unref?.();
