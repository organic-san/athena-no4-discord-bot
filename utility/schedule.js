const fs = require('fs');
const path = require('path');
const Discord = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const DB = require('./database.js');
const gemini = require('./gemini.js');
const fetcher = require('./newsFetcher.js');
const notify = require('./notify.js');

// 日程預告自動化：輪詢官方公告 → 以 prompts/schedule.md 的規則交給模型整理 → 草稿送審核頻道
// → 管理員按 ✅ 後才建立戰鬥討論串、填入連結並發布；按 ❌ 則不處理（由管理員手動發布）。
// 設定在 config/schedule.json，規則與 prompt 每次產生時重新讀檔，/system pull 後即生效。
// sources.<版本>.sendImages 開啟時，公告圖片也一併交給模型（見 imageParts）。
// 依需求不計入 /costs 的使用量統計（費用由 Google 後台查看）。

const CONFIG_FILE = './config/schedule.json';
const RULES_FILE = './prompts/schedule.md';
const ADAPTER_FILE = './prompts/schedule-auto.txt';
const SOURCES = ['tw', 'jp'];
// 日版「維修後開始」的 pickup 募集公告與維修公告分開發布：通常早約 1 小時，實際觀察到最早 25 小時、最晚晚 17 小時。
const HOUR = 60 * 60 * 1000;
const PAIR_BEFORE_MS = 26 * HOUR;
const PAIR_AFTER_MS = 24 * HOUR;
// 抓取連續失敗幾次才通知，避免網站短暫異常就洗版。
const FAIL_ALERT_AFTER = 3;
const MSG_LIMIT = 2000;

// 公告圖片交給模型閱讀（日版常有只寫在圖裡的資訊）。Gemini 4 每張圖依解析度固定計 token（high = 1120），
// 縮圖不影響費用，只是為了讓整個請求壓在 inline 上限 20MB 內：原圖單張可達 9MB，縮到寬 1600 的 JPEG 約 250KB。
const IMAGE_MAX_WIDTH = 1600;
const IMAGE_MAX_DOWNLOAD = 30 * 1024 * 1024;
const IMAGE_BUDGET = 15 * 1024 * 1024; // base64 後的總量上限，保留空間給文字
const IMAGE_CONCURRENCY = 4;

const CATEGORY = {
    total_assault: { label: '總力戰', name: '總力戰' },
    grand_assault: { label: '大決戰', name: '大決戰' },
    unlimit: { label: '制約解除決戰', name: '制約解除決戰' },
    drill: { label: '合同火力演習／綜合戰術考試', name: { tw: '綜合戰術考試', jp: '合同火力演習' } },
    tactical: { label: '戰術大賽（戰術對抗戰）', name: null },
};

const STATUS_LABEL = {
    pending: '待審核', publishing: '處理中', published: '已發布', exported: '已輸出文字',
    rejected: '已標記為不處理', superseded: '已被新草稿取代', failed: '處理失敗', missing: '不存在',
};

const SCHEMA = {
    type: 'object',
    properties: {
        post: { type: 'string' },
        threads: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    key: { type: 'string' },
                    category: { type: 'string', enum: Object.keys(CATEGORY) },
                    subtitle: { type: 'string' },
                    start: { type: 'string' },
                    end: { type: 'string' },
                    imageIndex: { type: 'integer' },
                    tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['key', 'category', 'subtitle', 'start', 'end', 'imageIndex', 'tags'],
            },
        },
        coverImageIndex: { type: 'integer' },
        notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['post', 'threads', 'coverImageIndex', 'notes'],
};

const db = DB.getConnection();

// 既有資料庫不會經過 createDB.js，故在此 idempotent 補建。
db.prepare(`CREATE TABLE IF NOT EXISTS schedule_seen (
    source TEXT,
    article_id TEXT,
    revision TEXT,
    PRIMARY KEY (source, article_id)
)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS schedule_draft (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    data TEXT,
    status TEXT,
    created_at TEXT,
    decided_by TEXT,
    review_channel_id TEXT,
    review_message_id TEXT
)`).run();
// 早期版本的表沒有審核訊息欄位（草稿被取代時要移除舊按鈕）。
for (const col of ['review_channel_id', 'review_message_id']) {
    if (!db.prepare(`PRAGMA table_info(schedule_draft)`).all().some(c => c.name === col)) {
        db.prepare(`ALTER TABLE schedule_draft ADD COLUMN ${col} TEXT`).run();
    }
}

let timer = null;
let polling = false;
const failures = { tw: 0, jp: 0 };

function loadConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 作者的 Discord ID。一律以字串處理：Snowflake 超出 Number 的安全整數範圍。 */
function authorId() {
    return String(process.env.AUTHOR_USERID ?? '').trim();
}

/** 通知訊息：開頭提及作者，且只允許提及作者本人。 */
function notice(content) {
    const id = authorId();
    return {
        content: (id ? `<@${id}> ${content}` : content).slice(0, MSG_LIMIT),
        allowedMentions: { parse: [], users: id ? [id] : [] },
    };
}

/** 時間戳 → UTC+8 的「YYYY-MM-DD HH:mm」。 */
function fmtTime(ms) {
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** 依行切成不超過 Discord 上限的多則訊息（時間軸每行自帶反引號，依行切不會破壞格式）。 */
function splitMessages(text, limit = MSG_LIMIT) {
    const chunks = [];
    let cur = '';
    for (const line of text.split('\n')) {
        const next = cur ? `${cur}\n${line}` : line;
        if (next.length <= limit) { cur = next; continue; }
        if (cur) chunks.push(cur);
        cur = line;
        while (cur.length > limit) { chunks.push(cur.slice(0, limit)); cur = cur.slice(limit); }
    }
    if (cur) chunks.push(cur);
    return chunks;
}

/** 讀取各論壇的標籤與既有討論串標題（期數計算用）。 */
async function loadForums(guild, cfg) {
    const active = await guild.channels.fetchActiveThreads();
    const forums = new Map();
    for (const forumId of new Set(Object.values(cfg.forums))) {
        const forum = await guild.channels.fetch(forumId);
        if (forum?.type !== Discord.ChannelType.GuildForum) throw new Error(`頻道 ${forumId} 不是論壇頻道`);
        const archived = await forum.threads.fetchArchived({ limit: 100 });
        const titles = [
            ...active.threads.filter(t => t.parentId === forumId).values(),
            ...archived.threads.values(),
        ].map(t => t.name);
        forums.set(forumId, {
            name: forum.name,
            tags: forum.availableTags.map(t => ({ id: t.id, name: t.name })),
            titles,
        });
    }
    return forums;
}

/** 依論壇既有標題算出下一期；找不到同類標題回傳 null。 */
function nextNumber(titles, re) {
    let max = 0;
    for (const t of titles) {
        const m = t.match(re);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return max ? max + 1 : null;
}

const seasonRegex = label => new RegExp(`^${escapeRegex(label)}第(\\d+)賽季`);

/**
 * 依論壇既有標題組出討論串標題。assigned 記錄本份草稿已分配的編號（同類兩項時接續遞增）。
 * 回傳 { title, missing }，missing 為無法推算的部分（以 ? 代替，交管理員確認）。
 */
function threadTitle(t, source, label, titles, assigned) {
    const next = (re, key = re.source) => {
        const n = assigned.has(key) ? assigned.get(key) + 1 : nextNumber(titles, re);
        if (n !== null) assigned.set(key, n);
        return n;
    };

    if (t.category === 'tactical') {
        const season = next(seasonRegex(label));
        // 區依地形輪替：取同地形最近一季的區 +1。
        const zoneRe = source === 'tw'
            ? new RegExp(`^${escapeRegex(label)}第(\\d+)賽季\\s*${escapeRegex(t.subtitle)}(\\d+)區`)
            : new RegExp(`^${escapeRegex(label)}第(\\d+)賽季\\s*${escapeRegex(t.subtitle)}第(\\d+)區域`);
        let latest = null;
        for (const title of titles) {
            const m = title.match(zoneRe);
            if (m && (!latest || Number(m[1]) > latest.season)) latest = { season: Number(m[1]), zone: Number(m[2]) };
        }
        const zone = latest ? latest.zone + 1 : null;
        const s = season ?? '?', z = zone ?? '?';
        return {
            title: source === 'tw' ? `${label}第${s}賽季 ${t.subtitle}${z}區` : `${label}第${s}賽季 ${t.subtitle}第${z}區域`,
            missing: [season === null && '賽季', zone === null && `「${t.subtitle}」的區`].filter(Boolean),
        };
    }

    const cat = CATEGORY[t.category];
    const kind = typeof cat.name === 'string' ? cat.name : cat.name[source];
    if (t.category === 'drill') {
        const n = next(new RegExp(`^${escapeRegex(label + kind)}\\s*-\\s*第(\\d+)次${escapeRegex(t.subtitle)}`));
        return { title: `${label}${kind} - 第${n ?? '?'}次${t.subtitle}`, missing: n === null ? ['次數'] : [] };
    }
    const n = next(new RegExp(`^${escapeRegex(label)}第(\\d+)期${escapeRegex(kind)}`));
    return { title: `${label}第${n ?? '?'}期${kind} - ${t.subtitle}`, missing: n === null ? ['期數'] : [] };
}

function findTag(tags, name) {
    const norm = s => s.trim().toLowerCase();
    return tags.find(t => t.name === name) ?? tags.find(t => norm(t.name) === norm(name));
}

const GIF = Symbol('gif');

/**
 * 下載一張公告圖片並縮成給模型看的 JPEG（base64）。
 * GIF（家具互動動畫等，單張可達 40MB，不含日程資訊）回傳 GIF 標記不送；無法讀取時回傳 null。
 */
async function imageForModel(url) {
    if (/\.gif$/i.test(new URL(url).pathname)) return GIF;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30 * 1000) });
        if (!res.ok) return null;
        if (/gif/i.test(res.headers.get('content-type') || '')) return GIF;
        if (Number(res.headers.get('content-length')) > IMAGE_MAX_DOWNLOAD) return null;
        const img = await loadImage(Buffer.from(await res.arrayBuffer()));
        const scale = Math.min(1, IMAGE_MAX_WIDTH / img.width);
        const canvas = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // 透明 PNG 轉 JPEG 時避免變成黑底
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toBuffer('image/jpeg', { quality: 0.85 }).toString('base64');
    } catch (e) {
        console.warn(`[schedule] 圖片讀取失敗：${url}（${e.message}）`);
        return null;
    }
}

/**
 * 把公告圖片轉成模型輸入：每張圖前加上與本文相同的 [IMG:n] 標記，讓模型能對應圖片位置與編號。
 * 回傳 { parts, sent, missed }；missed 為讀取失敗或超出總量而沒送出的張數（不含刻意略過的 GIF）。
 */
async function imageParts(images, resolution) {
    const level = `MEDIA_RESOLUTION_${String(resolution || 'high').toUpperCase()}`;
    const data = new Array(images.length).fill(null);
    for (let i = 0; i < images.length; i += IMAGE_CONCURRENCY) {
        const batch = images.slice(i, i + IMAGE_CONCURRENCY);
        (await Promise.all(batch.map(imageForModel))).forEach((d, j) => { data[i + j] = d; });
    }

    const parts = [];
    let total = 0, sent = 0, gifs = 0;
    data.forEach((d, i) => {
        if (d === GIF) { gifs++; return; }
        if (!d || total + d.length > IMAGE_BUDGET) return;
        total += d.length;
        sent++;
        parts.push({ text: `[IMG:${i + 1}]` }, { inlineData: { mimeType: 'image/jpeg', data: d }, mediaResolution: { level } });
    });
    console.log(`[schedule] 附上圖片 ${sent}/${images.length} 張（略過 GIF ${gifs} 張），約 ${(total / 1048576).toFixed(1)} MB`);
    return { parts, sent, missed: images.length - sent - gifs };
}

/** 呼叫模型整理公告，回傳解析後的 JSON。extraParts 接在文字之後（例如公告圖片）。 */
async function generate(cfg, userText, extraParts = []) {
    const systemInstruction = fs.readFileSync(RULES_FILE, 'utf-8') + '\n\n' + fs.readFileSync(ADAPTER_FILE, 'utf-8');
    const response = await gemini.withRetry(() => gemini.ai.models.generateContent({
        model: cfg.model,
        contents: [{ role: 'user', parts: [{ text: userText }, ...extraParts] }],
        config: {
            systemInstruction,
            maxOutputTokens: cfg.maxOutputTokens,
            thinkingConfig: { thinkingLevel: cfg.thinkingLevel },
            responseMimeType: 'application/json',
            responseJsonSchema: SCHEMA,
        },
    }));

    const u = response.usageMetadata;
    console.log(`[schedule] ${cfg.model} input ${u?.promptTokenCount ?? '?'}, output ${u?.candidatesTokenCount ?? '?'}, thinking ${u?.thoughtsTokenCount ?? 0}`);

    const text = response.text;
    if (!text?.trim()) {
        const finish = response.candidates?.[0]?.finishReason;
        throw new Error(finish === 'MAX_TOKENS'
            ? `模型輸出超過上限（maxOutputTokens = ${cfg.maxOutputTokens}，thinking 也會佔用）`
            : `模型沒有產生內容（${response.promptFeedback?.blockReason || finish || '未知原因'}）`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`模型輸出不是合法的 JSON：${text.slice(0, 200)}`);
    }
}

/**
 * 把一組公告整理成草稿資料（不寫資料庫、不建立任何東西；正式流程與測試共用）。
 * 回傳 { source, articles, post, threads, notes }，post 中的 {{THREAD:key}} 於發布時換成討論串連結。
 */
async function buildDraft(client, source, articles) {
    const cfg = loadConfig();
    const label = cfg.sources[source].label;
    const guild = await client.guilds.fetch(cfg.guildId);

    for (const a of articles) await fetcher.loadHtml(a);
    const images = [];
    const docs = articles.map((a, i) =>
        `### 公告 ${i + 1}：${a.title}\n發布時間：${fmtTime(a.publishedAt)} (UTC+8)\n\n${fetcher.htmlToText(a.html, a.url, images)}`);

    const forums = await loadForums(guild, cfg);
    const tagLines = Object.entries(cfg.forums)
        .map(([cat, fid]) => `- ${CATEGORY[cat].label}：${forums.get(fid).tags.map(t => t.name).join('、') || '（無）'}`);

    const nextSeason = nextNumber(forums.get(cfg.forums.tactical)?.titles ?? [], seasonRegex(label));

    const pics = cfg.sources[source].sendImages
        ? await imageParts(images, cfg.imageResolution)
        : { parts: [], sent: 0, missed: 0 };

    const result = await generate(cfg, [
        `伺服器：${label}`,
        `今天日期：${fmtTime(Date.now()).slice(0, 10)}`,
        '',
        '## 各論壇可用標籤',
        ...tagLines,
        '',
        '## 參考資訊',
        `- 戰術大賽下一個賽季：${nextSeason ? `第${nextSeason}賽季` : '（無法推算）'}`,
        '',
        '## 公告',
        docs.join('\n\n'),
        ...(pics.sent ? ['', `## 公告圖片`, `以下附上公告中的圖片（共 ${pics.sent} 張，GIF 除外），每張前面標有對應的 [IMG:n]。`] : []),
    ].join('\n'), pics.parts);

    const notes = [...(result.notes ?? [])];
    if (pics.missed) notes.push(`有 ${pics.missed} 張公告圖片讀取失敗或超出總量，沒有交給模型，其中的資訊可能遺漏`);
    const threads = [];
    const assigned = new Map(); // 同一份草稿有兩個同類項目時，期數接續遞增

    for (const t of result.threads ?? []) {
        const forumId = cfg.forums[t.category];
        const forum = forums.get(forumId);
        if (!CATEGORY[t.category] || !forum) { notes.push(`無法對應論壇：${t.category} ${t.subtitle}`); continue; }

        const named = threadTitle(t, source, label, forum.titles, assigned);
        const title = named.title.slice(0, 100);
        if (named.missing.length) notes.push(`「${title}」找不到可推算的前一期討論串（${named.missing.join('、')}），請手動確認`);

        const tags = [];
        for (const name of t.tags ?? []) {
            const tag = findTag(forum.tags, name);
            if (!tag) notes.push(`標籤「${name}」不存在於論壇「${forum.name}」`);
            else if (!tags.some(x => x.id === tag.id)) tags.push(tag);
        }

        const imageUrl = t.imageIndex > 0 ? images[t.imageIndex - 1] ?? null : null;
        if (!imageUrl) notes.push(`「${title}」沒有主視覺圖`);

        threads.push({
            key: String(t.key),
            title,
            forumId,
            tagIds: tags.slice(0, 5).map(x => x.id),
            tagNames: tags.slice(0, 5).map(x => x.name),
            dateRange: t.category === 'tactical' || !t.end ? `${t.start}~` : `${t.start} - ${t.end}`,
            imageUrl,
        });
    }

    const coverImageUrl = result.coverImageIndex > 0 ? images[result.coverImageIndex - 1] ?? null : null;
    if (!coverImageUrl) notes.push('預告沒有選到主視覺圖');

    const post = (result.post ?? '').replace(/^\s*```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    for (const th of threads) {
        if (!post.includes(`{{THREAD:${th.key}}}`)) notes.push(`預告中沒有「${th.title}」的連結位置，發布後需手動補上`);
    }
    for (const [, key] of post.matchAll(/\{\{THREAD:([^}]+)\}\}/g)) {
        if (!threads.some(t => t.key === key)) notes.push(`預告中的連結位置 {{THREAD:${key}}} 沒有對應的討論串`);
    }

    return {
        source,
        articles: articles.map(a => ({ id: a.id, title: a.title, url: a.url })),
        post,
        coverImageUrl,
        threads,
        notes,
    };
}

/** 套用討論串連結、表情與通知身分組，產生最終文字。links：key → 要填入的文字。 */
function renderPost(draft, cfg, links) {
    let text = draft.post.replace(/\{\{THREAD:([^}]+)\}\}/g, (m, key) => links[key] ?? '');
    for (const [code, emoji] of Object.entries(cfg.emojis)) text = text.replaceAll(code, emoji);
    const src = cfg.sources[draft.source];
    return text.replace(src.notifyText, `<@&${src.roleId}>`);
}

/** 送出草稿預覽：說明 → 預告本文 → 討論串與待確認事項（components 掛在最後一則）。 */
async function sendPreview(channel, draft, cfg, header, components = [], ping = false) {
    const quiet = { allowedMentions: { parse: [] } };
    const sources = draft.articles.map(a => `[${a.title}](<${a.url}>)`).join('\n');
    const intro = `${header}\n${sources}`;
    await channel.send(ping ? notice(intro) : { content: intro.slice(0, MSG_LIMIT), ...quiet });

    const body = renderPost(draft, cfg, Object.fromEntries(draft.threads.map(t => [t.key, `（討論串：${t.title}）`])));
    for (const chunk of splitMessages(body)) await channel.send({ content: chunk, ...quiet });

    const summary = [
        `**預告主視覺**：${draft.coverImageUrl ? `[連結](${draft.coverImageUrl})` : '無'}`,
        '',
        `**討論串**${draft.threads.length ? '' : '：無'}`,
        ...draft.threads.map(t => `- ${t.title}\n  <#${t.forumId}>｜${t.dateRange}｜標籤：${t.tagNames.join('、') || '無'}｜${t.imageUrl ? `[主視覺](${t.imageUrl})` : '無主視覺'}`),
        ...(draft.notes.length ? ['', '**待確認**', ...draft.notes.map(n => `- ${n}`)] : []),
    ].join('\n');
    const chunks = splitMessages(summary);
    let last;
    for (let i = 0; i < chunks.length; i++) {
        last = await channel.send({ content: chunks[i], ...quiet, components: i === chunks.length - 1 ? components : [] });
    }
    return last;
}

function reviewButtons(draftId) {
    return [new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId(`sched:approve:${draftId}`).setLabel('發布').setEmoji('✅').setStyle(Discord.ButtonStyle.Success),
        new Discord.ButtonBuilder().setCustomId(`sched:export:${draftId}`).setLabel('建立討論串並輸出文字').setEmoji('📄').setStyle(Discord.ButtonStyle.Primary),
        new Discord.ButtonBuilder().setCustomId(`sched:text:${draftId}`).setLabel('不建立討論串，只輸出文字').setEmoji('📋').setStyle(Discord.ButtonStyle.Primary),
        new Discord.ButtonBuilder().setCustomId(`sched:reject:${draftId}`).setLabel('不處理').setEmoji('❌').setStyle(Discord.ButtonStyle.Secondary),
    )];
}

/** 一組公告 → 寫入草稿並送審核頻道。note 附在標題後（例如取代了哪份草稿）。 */
async function createDraft(client, source, articles, note = '') {
    const cfg = loadConfig();
    const draft = await buildDraft(client, source, articles);
    const info = db.prepare(`INSERT INTO schedule_draft (source, data, status, created_at) VALUES (?, ?, 'pending', ?)`)
        .run(source, JSON.stringify(draft), new Date().toISOString());
    const id = Number(info.lastInsertRowid);
    const channel = await client.channels.fetch(cfg.reviewChannelId);
    const msg = await sendPreview(channel, draft, cfg, `📝 **日程預告草稿 #${id}**（${cfg.sources[source].label}）${note}`, reviewButtons(id), true);
    db.prepare(`UPDATE schedule_draft SET review_channel_id = ?, review_message_id = ? WHERE id = ?`).run(channel.id, msg.id, id);
    console.log(`[schedule] 已送出草稿 #${id}（${source}）`);
}

/** 日版：pickup 是否屬於這次維修（期間寫「メンテナンス後」且發布時間在配對範圍內）。 */
function pairsWith(pickup, maintenance) {
    const diff = pickup.publishedAt - maintenance.publishedAt;
    return pickup.afterMaintenance && diff >= -PAIR_BEFORE_MS && diff <= PAIR_AFTER_MS;
}

function pickupsNear(all, maintenance) {
    return all.filter(p => p.kind === 'jp_pickup' && pairsWith(p, maintenance));
}

/** 某來源最新的一組公告（國際版：最新更新日誌；日版：最新維修公告＋配對的募集公告）。 */
async function latestGroup(source) {
    const articles = await fetcher.list(source);
    const latest = kind => articles.filter(a => a.kind === kind).sort((a, b) => b.publishedAt - a.publishedAt)[0];
    const head = latest(source === 'tw' ? 'tw_update' : 'jp_maintenance');
    if (!head) throw new Error('找不到最新的公告');
    return source === 'tw' ? [head] : [head, ...pickupsNear(articles, head)];
}

/** 找出包含某篇公告的最新一份草稿。 */
function draftOf(source, articleId) {
    const rows = db.prepare(`SELECT * FROM schedule_draft WHERE source = ? ORDER BY id DESC LIMIT 20`).all(source);
    return rows.find(r => JSON.parse(r.data).articles.some(a => a.id === articleId)) ?? null;
}

/** 在草稿的審核訊息（帶按鈕的那則）後附註，並替換按鈕。 */
async function annotateReview(client, row, note, components) {
    try {
        const channel = await client.channels.fetch(row.review_channel_id);
        const msg = await channel.messages.fetch(row.review_message_id);
        const room = MSG_LIMIT - note.length - 2;
        const base = msg.content.length > room ? msg.content.slice(0, room - 1) + '…' : msg.content;
        await msg.edit({ content: `${base}\n\n${note}`, components, allowedMentions: { parse: [] } });
    } catch (e) {
        console.warn(`[schedule] 無法更新草稿 #${row.id} 的審核訊息：`, e.message);
    }
}

/** 把待審核草稿標記為被取代，並移除舊審核訊息上的按鈕。已被處理過回傳 false。 */
async function supersede(client, row, newNote) {
    const ok = db.prepare(`UPDATE schedule_draft SET status = 'superseded' WHERE id = ? AND status = 'pending'`).run(row.id).changes > 0;
    if (ok) await annotateReview(client, row, `↪️ ${newNote}`, []);
    return ok;
}

/** 取代用的新草稿產生失敗時，把舊草稿恢復為待審核並放回按鈕，避免兩份都無法操作。 */
async function restore(client, row) {
    const ok = db.prepare(`UPDATE schedule_draft SET status = 'pending' WHERE id = ? AND status = 'superseded'`).run(row.id).changes > 0;
    if (ok) await annotateReview(client, row, '↩️ 新草稿產生失敗，此草稿恢復為待審核（不含晚到的募集公告）', reviewButtons(row.id));
}

async function pollSource(client, source) {
    const articles = await fetcher.list(source);
    const seen = new Map(db.prepare(`SELECT article_id, revision FROM schedule_seen WHERE source = ?`).all(source)
        .map(r => [r.article_id, r.revision]));
    const markSeen = a => db.prepare(`INSERT INTO schedule_seen (source, article_id, revision) VALUES (?, ?, ?)
        ON CONFLICT(source, article_id) DO UPDATE SET revision = excluded.revision`).run(source, a.id, a.revision);

    // 初次執行只記錄現有公告，不對歷史公告產生草稿。
    if (seen.size === 0) {
        articles.forEach(markSeen);
        console.log(`[schedule] ${source} 初次執行，記錄 ${articles.length} 篇既有公告`);
        return;
    }

    const cfg = loadConfig();
    const review = await client.channels.fetch(cfg.reviewChannelId);

    for (const a of articles.filter(a => seen.has(a.id) && seen.get(a.id) !== a.revision)) {
        markSeen(a);
        await review.send(notice(`🔄 公告已修改：[${a.title}](<${a.url}>)\n若已產生草稿或發布預告，請確認內容是否需要更新。`));
    }

    const fresh = articles.filter(a => !seen.has(a.id));
    const groups = []; // { articles, note }
    if (source === 'tw') {
        for (const a of fresh) groups.push({ articles: [a] });
    } else {
        const handled = new Set(); // 已排入草稿的維修公告
        for (const m of fresh.filter(a => a.kind === 'jp_maintenance')) {
            handled.add(m.id);
            groups.push({ articles: [m, ...pickupsNear(articles, m)] });
        }
        for (const p of fresh.filter(a => a.kind === 'jp_pickup')) {
            if (!p.afterMaintenance) {
                // 期中募集：沒有對應的維修公告，不產生草稿。
                markSeen(p);
                await review.send(notice(`🆕 期中募集公告（不隨維修開始，未產生草稿）：[${p.title}](<${p.url}>)`));
                continue;
            }
            const m = articles.find(a => a.kind === 'jp_maintenance' && pairsWith(p, a));
            if (!m) {
                // 通常比維修公告早約 1 小時；配對範圍內先不標記，等維修公告出現再一起處理。
                if (Date.now() - p.publishedAt < PAIR_BEFORE_MS) continue;
                markSeen(p);
                await review.send(notice(`🆕 募集公告找不到對應的維修公告，未產生草稿：[${p.title}](<${p.url}>)`));
                continue;
            }
            if (handled.has(m.id)) continue; // 本輪已與維修公告一起排入
            // 維修公告的草稿已先送出：仍待審核就重新產生（含這篇募集），已處理過則通知手動補上。
            markSeen(p);
            handled.add(m.id);
            const old = draftOf('jp', m.id);
            if (old && await supersede(client, old, `募集公告晚於本草稿發布，已重新產生草稿`)) {
                groups.push({ articles: [m, ...pickupsNear(articles, m)], note: `（含晚到的募集公告，取代 #${old.id}）`, replaces: old });
            } else {
                const state = old ? `草稿 #${old.id} ${STATUS_LABEL[db.prepare(`SELECT status FROM schedule_draft WHERE id = ?`).get(old.id).status]}` : '維修公告沒有草稿';
                await review.send(notice(`🆕 募集公告晚於維修公告發布（${state}），請手動補上：[${p.title}](<${p.url}>)`));
            }
        }
    }

    for (const { articles: group, note, replaces } of groups) {
        // 先標記再產生：產生失敗時不會每輪重試、重複消耗模型額度，改由管理員以 /system schedule test 重跑。
        group.forEach(markSeen);
        try {
            await createDraft(client, source, group, note);
        } catch (err) {
            console.error('[schedule] 草稿產生失敗：', err);
            notify.error('日程預告草稿產生失敗', err);
            if (replaces) await restore(client, replaces);
            const links = group.map(a => `[${a.title}](<${a.url}>)`).join('\n');
            await review.send(notice(`⚠️ 日程預告草稿產生失敗：\n${links}\n\`${String(err.message).slice(0, 500)}\``
                + (replaces ? `\n草稿 #${replaces.id} 已恢復為待審核，晚到的募集公告請手動補上。` : '')));
        }
    }
}

/** 檢查一次所有來源；已有檢查進行中時不重複執行，回傳 false。 */
async function poll(client) {
    if (polling) return false;
    polling = true;
    try {
        for (const source of SOURCES) {
            try {
                await pollSource(client, source);
                if (failures[source] >= FAIL_ALERT_AFTER) notify.log(`<@${authorId()}> ✅ 日程公告抓取已恢復（${source}）`);
                failures[source] = 0;
            } catch (err) {
                failures[source]++;
                console.error(`[schedule] ${source} 抓取失敗（連續 ${failures[source]} 次）：`, err);
                if (failures[source] === FAIL_ALERT_AFTER) notify.error(`日程公告抓取連續失敗 ${FAIL_ALERT_AFTER} 次（${source}），網站 API 可能已變更`, err);
            }
        }
    } finally {
        polling = false;
    }
    return true;
}

/** 伺服器的附件上限（依加成等級）。日版主視覺可達 9MB，超過上限會讓整個討論串建立失敗。 */
function uploadLimit(guild) {
    return { 2: 50, 3: 100 }[guild.premiumTier] * 1024 * 1024 || 10 * 1024 * 1024;
}

async function downloadImage(url, limit) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30 * 1000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > limit) throw new Error(`檔案 ${(buffer.length / 1048576).toFixed(1)} MB 超過伺服器上傳上限`);
    let name = decodeURIComponent(path.basename(new URL(url).pathname)).replace(/[^\w.\-]/g, '_') || 'banner';
    if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) name += '.png';
    return { attachment: buffer, name };
}

module.exports = {
    /** 啟動輪詢（clientReady 後呼叫）。 */
    start(client) {
        if (timer) return;
        // 發布途中 bot 重啟會讓草稿停在「處理中」且按鈕無法再操作；改為失敗並提醒人工確認。
        const stuck = db.prepare(`SELECT id FROM schedule_draft WHERE status = 'publishing'`).all().map(r => r.id);
        if (stuck.length) {
            db.prepare(`UPDATE schedule_draft SET status = 'failed' WHERE status = 'publishing'`).run();
            notify.log(`<@${authorId()}> ⚠️ 日程預告草稿 ${stuck.map(id => `#${id}`).join('、')} 在處理途中中斷（bot 重啟），已標記為處理失敗。請確認討論串與預告是否已建立或發布。`);
        }
        const minutes = loadConfig().pollMinutes || 10;
        setTimeout(() => poll(client), 30 * 1000);
        timer = setInterval(() => poll(client), minutes * 60 * 1000);
    },

    poll,

    /**
     * 以最新一筆公告走完整個產生流程，結果送到 channel。
     * 不寫資料庫、不建立討論串、不附審核按鈕。
     */
    async test(client, source, channel) {
        const cfg = loadConfig();
        const draft = await buildDraft(client, source, await latestGroup(source));
        await sendPreview(channel, draft, cfg, `🧪 **日程預告測試**（${cfg.sources[source].label}）：不會建立討論串，也不會發布`);
    },

    /**
     * 以最新一筆公告產生一份正式草稿（附審核按鈕）送到審核頻道，用來實際測試按鈕流程。
     * 不更動「已看過」紀錄，不影響自動輪詢。按 ✅ 會真的發布。
     */
    async draft(client, source) {
        await createDraft(client, source, await latestGroup(source), '（手動產生）');
    },

    STATUS_LABEL,

    /**
     * 處理草稿，依 mode：
     *   publish：建立討論串 → 填入連結 → 發到公告頻道（換成表情與身分組提及），回傳 { postUrl, threads, warnings }
     *   export：建立討論串 → 填入連結，不發布，回傳 { text, coverFile, threads, warnings }；text 保留 schedule.md 的可貼上格式
     *   text：同 export 但不建立討論串，連結位置留空待補
     * 回傳 { already } 表示已被處理。失敗時丟出錯誤，err.created 為已建立的討論串（需人工清理）。
     */
    async materialize(client, draftId, userId, mode) {
        const claim = db.prepare(`UPDATE schedule_draft SET status = 'publishing', decided_by = ? WHERE id = ? AND status = 'pending'`)
            .run(userId, draftId);
        if (!claim.changes) {
            const row = db.prepare(`SELECT status FROM schedule_draft WHERE id = ?`).get(draftId);
            return { already: row?.status ?? 'missing' };
        }

        const draft = JSON.parse(db.prepare(`SELECT data FROM schedule_draft WHERE id = ?`).get(draftId).data);
        const cfg = loadConfig();
        const created = [];
        const warnings = [];
        try {
            const guild = await client.guilds.fetch(cfg.guildId);
            const links = {};
            for (const t of mode === 'text' ? [] : draft.threads) {
                const forum = await guild.channels.fetch(t.forumId);
                const files = [];
                if (t.imageUrl) {
                    try { files.push(await downloadImage(t.imageUrl, uploadLimit(guild))); }
                    catch (e) { warnings.push(`「${t.title}」主視覺未附上（${e.message}）：${t.imageUrl}`); }
                }
                const thread = await forum.threads.create({
                    name: t.title,
                    message: { content: t.dateRange, files },
                    appliedTags: t.tagIds,
                });
                created.push(thread);
                links[t.key] = thread.url;
            }

            // 預告主視覺附在最後一則，顯示在貼文底部。
            const coverFiles = [];
            if (draft.coverImageUrl) {
                try { coverFiles.push(await downloadImage(draft.coverImageUrl, uploadLimit(guild))); }
                catch (e) { warnings.push(`預告主視覺未附上（${e.message}）：${draft.coverImageUrl}`); }
            }

            if (mode === 'export' || mode === 'text') {
                const text = draft.post.replace(/\{\{THREAD:([^}]+)\}\}/g, (m, key) => links[key] ?? '');
                db.prepare(`UPDATE schedule_draft SET status = 'exported' WHERE id = ?`).run(draftId);
                return { text, coverFile: coverFiles[0] ?? null, threads: created, warnings };
            }

            const channel = await client.channels.fetch(cfg.publishChannelId);
            const roleId = cfg.sources[draft.source].roleId;
            const chunks = splitMessages(renderPost(draft, cfg, links));
            let first = null;
            for (let i = 0; i < chunks.length; i++) {
                const msg = await channel.send({
                    content: chunks[i],
                    allowedMentions: first ? { parse: [] } : { roles: [roleId] },
                    files: i === chunks.length - 1 ? coverFiles : [],
                });
                first ??= msg;
            }

            db.prepare(`UPDATE schedule_draft SET status = 'published' WHERE id = ?`).run(draftId);
            return { postUrl: first?.url, threads: created, warnings };
        } catch (err) {
            db.prepare(`UPDATE schedule_draft SET status = 'failed' WHERE id = ?`).run(draftId);
            err.created = created;
            throw err;
        }
    },

    /** 標記為不處理；已被處理過回傳 false。 */
    reject(draftId, userId) {
        return db.prepare(`UPDATE schedule_draft SET status = 'rejected', decided_by = ? WHERE id = ? AND status = 'pending'`)
            .run(userId, draftId).changes > 0;
    },
};
