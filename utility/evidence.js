const Discord = require('discord.js');
const func = require('./functions.js');

// node-canvas 為原生相依；以 lazy require 容錯，未安裝時退化為純文字附件（不致 crash）。
// 中文字型沿用同環境他專案做法：直接使用部署環境 fontconfig 提供的 "Noto Sans CJK"。
const CJK_FONT = '"Noto Sans CJK", sans-serif';
let canvas = null;
let canvasReady = false;
function loadCanvas() {
    if (canvasReady) return canvas;
    canvasReady = true;
    try {
        canvas = require('canvas');
    } catch (e) {
        canvas = null;
        // 載入失敗則退化為無圖；露出原因以利診斷（常見：缺原生函式庫或未編譯）。
        console.error('[evidence] canvas 載入失敗，證據卡片將無圖：', e?.message || e);
    }
    return canvas;
}

function wrapText(ctx, text, maxWidth) {
    const lines = [];
    for (const rawLine of text.split('\n')) {
        if (rawLine === '') { lines.push(''); continue; }
        let line = '';
        for (const ch of rawLine) {
            if (ctx.measureText(line + ch).width > maxWidth && line !== '') {
                lines.push(line);
                line = ch;
            } else {
                line += ch;
            }
        }
        lines.push(line);
    }
    return lines;
}

/** 圓角矩形路徑 */
function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** 以 cover（等比裁切置中）方式將圖片繪入指定圓角矩形 */
function drawImageCover(ctx, img, dx, dy, dw, dh, radius) {
    const scale = Math.max(dw / img.width, dh / img.height);
    const sw = dw / scale, sh = dh / scale;
    const sx = (img.width - sw) / 2, sy = (img.height - sh) / 2;
    ctx.save();
    roundRectPath(ctx, dx, dy, dw, dh, radius);
    ctx.clip();
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.restore();
}

/** 依圖片張數決定 grid 欄數（仿 Discord：1 大圖、2/4 兩欄、其餘三欄）。 */
function gridCols(n) {
    if (n <= 1) return 1;
    if (n === 2 || n === 4) return 2;
    return 3;
}

/** 下載訊息中的圖片附件並 loadImage（單張失敗／過大則略過）。 */
async function loadAttachmentImages(loadImage, message, max) {
    const atts = [...(message.attachments?.values() || [])]
        .filter(a => a.contentType?.startsWith('image/'))
        .slice(0, max);
    const imgs = [];
    for (const att of atts) {
        if (att.size > 8 * 1024 * 1024) continue; // 過大則略過
        try {
            const res = await fetch(att.url);
            if (!res.ok) continue;
            imgs.push(await loadImage(Buffer.from(await res.arrayBuffer())));
        } catch { /* 單張失敗略過 */ }
    }
    return imgs;
}

module.exports = {
    /**
     * 將一則訊息算繪為仿 Discord 樣式的證據卡片。
     * @param {object} message
     * @param {{ embedImages?: boolean }} [options] embedImages：將上傳的圖片直接繪入同一張卡片。
     * @returns {Promise<Discord.AttachmentBuilder|null>} 缺 canvas 時回 null。
     */
    async renderMessageCard(message, options = {}) {
        const cv = loadCanvas();
        if (!cv) return null;

        const { createCanvas, loadImage } = cv;
        const FONT = CJK_FONT;
        const author = message.author;
        const content = message.content || '（無文字內容）';
        const timeStr = message.createdAt.toISOString().replace('T', ' ').slice(0, 19);

        const width = 720;
        const padding = 16;
        const avatarSize = 40;
        const textX = padding + avatarSize + 14;
        const textWidth = width - textX - padding;
        const lineHeight = 21;
        const headerHeight = 24;

        // 內嵌圖片：先下載並計算 grid 佈局（最多 10 張，即 Discord 單則訊息附件上限）
        const MAX_IMAGES = 10;
        const gap = 6;
        const imgs = options.embedImages ? await loadAttachmentImages(loadImage, message, MAX_IMAGES) : [];
        let cols = 0, cellW = 0, cellH = 0, gridH = 0;
        if (imgs.length) {
            cols = gridCols(imgs.length);
            cellW = cols === 1 ? Math.min(textWidth, 400) : Math.floor((textWidth - gap * (cols - 1)) / cols);
            cellH = Math.round(cellW * (cols === 1 ? 0.6 : 0.72));
            const rows = Math.ceil(imgs.length / cols);
            gridH = rows * cellH + (rows - 1) * gap;
        }

        // 附件註記：以「實際內嵌張數」描述，確保文字與圖片一致
        const totalAttach = message.attachments?.size || 0;
        let attachNote = null;
        if (options.embedImages) {
            if (totalAttach > 0) {
                attachNote = imgs.length === totalAttach
                    ? `📎 ${totalAttach} 張圖片`
                    : `📎 共 ${totalAttach} 個附件（已內嵌 ${imgs.length} 張圖片）`;
            }
        } else if (totalAttach) {
            attachNote = `📎 ${totalAttach} 個附件`;
        }

        // 先以暫時 canvas 量測文字高度
        const tmp = createCanvas(width, 100);
        const tctx = tmp.getContext('2d');
        tctx.font = `15px ${FONT}`;
        const lines = wrapText(tctx, content, textWidth);

        let bodyHeight = headerHeight + lines.length * lineHeight;
        if (attachNote) bodyHeight += lineHeight;
        if (imgs.length) bodyHeight += 8 + gridH;
        const height = padding * 2 + Math.max(avatarSize, bodyHeight);

        const cvs = createCanvas(width, height);
        const ctx = cvs.getContext('2d');

        // 背景（Discord 深色）
        ctx.fillStyle = '#36393f';
        ctx.fillRect(0, 0, width, height);

        // 頭像（圓形）。loadImage 直接吃 URL 在 node-canvas 不可靠，先抓成 buffer 再載入。
        try {
            const avatarURL = author.displayAvatarURL({ extension: 'png', size: 64 });
            const res = await fetch(avatarURL);
            const img = await loadImage(Buffer.from(await res.arrayBuffer()));
            ctx.save();
            ctx.beginPath();
            ctx.arc(padding + avatarSize / 2, padding + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(img, padding, padding, avatarSize, avatarSize);
            ctx.restore();
        } catch {
            ctx.fillStyle = '#5865f2';
            ctx.beginPath();
            ctx.arc(padding + avatarSize / 2, padding + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // 使用者名稱 + 時間
        let y = padding + 14;
        ctx.textBaseline = 'alphabetic';
        ctx.font = `bold 15px ${FONT}`;
        ctx.fillStyle = '#ffffff';
        const name = author.username || 'unknown';
        ctx.fillText(name, textX, y);
        const nameWidth = ctx.measureText(name).width;
        ctx.font = `12px ${FONT}`;
        ctx.fillStyle = '#a3a6aa';
        ctx.fillText(timeStr, textX + nameWidth + 10, y);

        // 內文
        y += headerHeight - 4;
        ctx.font = `15px ${FONT}`;
        ctx.fillStyle = '#dcddde';
        for (const line of lines) {
            ctx.fillText(line, textX, y);
            y += lineHeight;
        }
        if (attachNote) {
            ctx.fillStyle = '#a3a6aa';
            ctx.fillText(attachNote, textX, y);
            y += lineHeight;
        }

        // 圖片 grid（仿 Discord：依張數 1/2/3 欄、等比裁切、圓角；最後一列不滿則靠左）
        if (imgs.length) {
            const gy = y + 4;
            for (let i = 0; i < imgs.length; i++) {
                const col = i % cols, row = Math.floor(i / cols);
                const dx = textX + col * (cellW + gap);
                const dy = gy + row * (cellH + gap);
                drawImageCover(ctx, imgs[i], dx, dy, cellW, cellH, 8);
            }
        }

        const buffer = cvs.toBuffer('image/png');
        return new Discord.AttachmentBuilder(buffer, { name: `evidence_${message.id}.png` });
    },

    /**
     * 下載訊息中的圖片附件，轉成「防雷」附件以供轉貼到他處（單張失敗／過大略過）。
     * 統一用於：偵測停權轉貼通報證據圖、檢舉結案轉貼討論串證據圖。
     * @returns {Promise<Discord.AttachmentBuilder[]>}
     */
    async transcribeImages(message, max = 4) {
        const out = [];
        for (const att of message?.attachments?.values() || []) {
            if (out.length >= max) break;
            if (!att.contentType?.startsWith('image/')) continue;
            if (att.size > 8 * 1024 * 1024) continue; // 過大則略過
            try {
                const res = await fetch(att.url);
                if (!res.ok) continue;
                const buf = Buffer.from(await res.arrayBuffer());
                out.push(new Discord.AttachmentBuilder(buf, { name: att.name }).setSpoiler(true));
            } catch { /* 單張失敗略過 */ }
        }
        return out;
    },

    /**
     * 將前 N 則 + 目標 + 後 M 則整理成 Markdown 脈絡附件。
     * @param {Array} before 由舊到新排序
     * @param {object} target 目標訊息
     * @param {Array} after 由舊到新排序
     */
    buildContextMarkdown(before, target, after) {
        const fmt = (m, isTarget) => {
            const time = m.createdAt.toISOString().replace('T', ' ').slice(0, 19);
            const marker = isTarget ? ' **← 被檢舉訊息**' : '';
            const tag = m.author?.tag || m.author?.username || m.author?.id || 'unknown';
            let body = (m.content || '').trim() || '（無文字內容）';
            if (m.attachments?.size) body += `\n  > 📎 ${m.attachments.size} 個附件`;
            return `### [${time}] ${tag}${marker}\n${body}\n`;
        };

        let md = `# 檢舉脈絡擷取\n\n`;
        md += `> 產生時間：${func.localISOTimeNow()}\n`;
        md += `> 來源頻道 ID：${target.channelId || target.channel?.id || 'unknown'}\n\n`;
        md += `---\n\n`;
        for (const m of before) md += fmt(m, false) + '\n';
        md += `---\n\n` + fmt(target, true) + '\n' + `---\n\n`;
        for (const m of after) md += fmt(m, false) + '\n';

        const buffer = Buffer.from(md, 'utf-8');
        return new Discord.AttachmentBuilder(buffer, { name: `context_${target.id}.md` });
    },

    isCanvasAvailable() {
        return !!loadCanvas();
    },
};
