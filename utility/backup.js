const fs = require('fs');
const path = require('path');
const DB = require('./database.js');
require('dotenv').config();

// 備份目錄。預設為專案根目錄下的 data/backup（跨平台可建立、可見）；
// 部署（如 Docker volume）可用 .env 的 BACKUP_DIR 覆寫為絕對路徑，例如 /data/backup。
const BACKUP_DIR = process.env.BACKUP_DIR || path.resolve('data', 'backup');
const RETENTION_DAYS = 7;
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 每日
const FILE_RE = /^backup_\d{4}-\d{2}-\d{2}\.db$/;

/** 確保備份目錄存在（含 /data 等中間目錄）。回傳是否可用。 */
function ensureDir() {
    try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        return true;
    } catch (e) {
        console.error(`[backup] 無法建立備份目錄 ${BACKUP_DIR}：${e.message}`);
        return false;
    }
}

/** 刪除超過保留天數的備份。 */
function cleanupOld() {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let files;
    try {
        files = fs.readdirSync(BACKUP_DIR);
    } catch {
        return;
    }
    for (const f of files) {
        if (!FILE_RE.test(f)) continue;
        const full = path.join(BACKUP_DIR, f);
        try {
            if (fs.statSync(full).mtimeMs < cutoff) {
                fs.unlinkSync(full);
                console.log(`[backup] 已刪除過期備份 ${f}`);
            }
        } catch (e) {
            console.error(`[backup] 刪除 ${f} 失敗：${e.message}`);
        }
    }
}

/** 執行一次備份：複製資料庫到備份目錄，再清理過期檔。 */
async function runBackup() {
    if (!ensureDir()) return;

    const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD（同日覆蓋）
    const dest = path.join(BACKUP_DIR, `backup_${stamp}.db`);
    try {
        // better-sqlite3 線上備份，安全處理鎖定
        await DB.getConnection().backup(dest);
        console.log(`[backup] 已備份資料庫至 ${dest}`);
    } catch (e) {
        console.error(`[backup] 備份失敗：${e.message}`);
        return;
    }
    cleanupOld();
}

/** 啟動每日備份排程（啟動時先備份一次）。 */
function start() {
    console.log(`[backup] 每日備份目錄：${BACKUP_DIR}（保留 ${RETENTION_DAYS} 天）`);
    runBackup().catch(e => console.error('[backup] 啟動備份失敗：', e));
    const timer = setInterval(() => runBackup().catch(e => console.error('[backup] 排程備份失敗：', e)), INTERVAL_MS);
    timer.unref?.();
}

module.exports = { start, runBackup };
