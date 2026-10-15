const crypto = require('crypto');

// 蔚藍檔案官方公告來源。兩個網站的頁面都是前端動態載入，這裡直接呼叫其背後的 JSON API
// （非公開 API，網站改版可能失效；呼叫端負責連續失敗時通知）。
//
// 回傳的文章統一為：
// { source, id, kind, title, publishedAt(ms), revision, url, html }
//   kind：tw_update（國際版更新日誌）／jp_maintenance／jp_pickup；其餘公告不回傳。
//   revision：用來偵測公告被修改；國際版取 threadModifyDate，日版 API 沒有修改時間，取內文雜湊。
//   html：國際版清單不含內文，需另外以 loadHtml() 取得。
//   afterMaintenance：僅 jp_pickup，見 startsAfterMaintenance()。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 20 * 1000;

const TW = {
    api: 'https://forum.nexon.com/api/v1',
    alias: 'bluearchivetw',
    boardId: '3352', // 📜更新日誌
    referer: 'https://forum.nexon.com/bluearchiveTW/main',
};
const JP_API = 'https://api-web.bluearchive.jp/api/news';

async function getJson(url, headers = {}) {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`);
    return res.json();
}

async function listTw() {
    const data = await getJson(
        `${TW.api}/board/${TW.boardId}/threads?alias=${TW.alias}&pageNo=1&paginationType=PAGING&pageSize=10&blockSize=5&hideType=WEB`,
        { Referer: TW.referer },
    );
    if (!Array.isArray(data.threads)) throw new Error('國際版論壇 API 回應格式不符（缺少 threads）');
    return data.threads.map(t => ({
        source: 'tw',
        id: String(t.threadId),
        kind: 'tw_update',
        title: t.title,
        publishedAt: t.createDate * 1000,
        revision: String(t.threadModifyDate ?? t.createDate),
        url: `https://forum.nexon.com/bluearchiveTW/board_view?board=${TW.boardId}&thread=${t.threadId}`,
        html: null,
    }));
}

/**
 * pickup 募集是否隨維修開始：期間寫「メンテナンス後 ～」的屬於某次維修（通常比維修公告早約 1 小時發布）；
 * 寫明時刻（如「11:00 ～」）的是兩次維修之間的期中募集，不會有對應的維修公告。
 * （2024-11～2026-10 的 68 篇中 65 篇符合此規則。）
 */
function startsAfterMaintenance(html) {
    const text = (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    const m = text.match(/\d{4}年\d+月\d+日\([^)]+\)\s*(メンテナンス後|\d{1,2}:\d{2})\s*[~～]/);
    return !m || m[1] === 'メンテナンス後';
}

function jpKind(row) {
    // title 是分類名稱（メンテナンス／お知らせ…），實際標題在 summary。
    const heading = row.summary || '';
    if (heading.startsWith('メンテナンスのお知らせ')) return 'jp_maintenance';
    if (heading.startsWith('ピックアップ募集紹介')) return 'jp_pickup';
    return null;
}

async function listJp() {
    const data = await getJson(`${JP_API}/list?typeId=&pageNum=20&pageIndex=1`, { Referer: 'https://bluearchive.jp/' });
    if (!Array.isArray(data?.data?.rows)) throw new Error('日版官網 API 回應格式不符（缺少 data.rows）');
    return data.data.rows
        .map(r => ({
            source: 'jp',
            id: String(r.id),
            kind: jpKind(r),
            title: r.summary,
            publishedAt: r.publishTime,
            revision: crypto.createHash('sha1').update(r.content || '').digest('hex'),
            url: `https://bluearchive.jp/news/newsJump/${r.id}`,
            html: r.content || '',
            afterMaintenance: jpKind(r) === 'jp_pickup' ? startsAfterMaintenance(r.content) : undefined,
        }))
        .filter(a => a.kind);
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', middot: '·', times: '×' };

function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

module.exports = {
    /** 列出某來源近期的相關公告（新到舊不保證，日版有置頂）。 */
    list(source) {
        if (source === 'tw') return listTw();
        if (source === 'jp') return listJp();
        throw new Error(`未知的來源：${source}`);
    },

    /** 確保文章帶有 HTML 內文（國際版需另外取得）。 */
    async loadHtml(article) {
        if (article.html !== null) return article;
        const t = await getJson(`${TW.api}/thread/${article.id}?alias=${TW.alias}`, { Referer: TW.referer });
        if (typeof t.content !== 'string') throw new Error(`國際版文章 ${article.id} 缺少內文`);
        article.html = t.content;
        return article;
    },

    /**
     * HTML 轉純文字給模型閱讀。
     * - 圖片換成 [IMG:n]，網址依序推入 images（多篇文章共用同一個陣列，編號連續）。
     * - 刪除線保留為 ~~文字~~：公告常用刪除線修正維修結束時間，去掉標記會讓新舊時間並存而無法分辨。
     * - 表格儲存格以「 | 」分隔，保留國際版日程表的欄位結構。
     */
    htmlToText(html, base, images) {
        let s = html
            .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
            .replace(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (m, src) => {
                let url;
                try { url = new URL(decodeEntities(src), base).href; } catch { return ''; }
                images.push(url);
                return ` [IMG:${images.length}] `;
            })
            .replace(/<\/?(s|del|strike)\b[^>]*>/gi, '~~')
            .replace(/<\/t[dh]>/gi, ' | ')
            .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
            .replace(/<[^>]+>/g, '');
        s = decodeEntities(s)
            .replace(/[ \t ]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n+\|/g, ' |') // 儲存格內的 <p> 會在分隔符前斷行，併回同一列
            .replace(/~~\s*~~/g, '')
            .replace(/\n{3,}/g, '\n\n');
        return s.trim();
    },
};
