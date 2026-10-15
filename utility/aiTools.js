const system = require('./system.js');
const modConfig = require('./modConfig.js');
const moderation = require('./moderation.js');
const commandList = require('./commandList.js');
const gptConfig = require('./gptConfig.js');
const serverRules = require('./serverRules.js');

// 提供給 Gemini function calling 的唯讀工具。
// 安全原則：發問者身分一律取自 ctx（由程式依 Discord 事件組出），工具不接受 userId 之類的參數，
// 模型因此無從查詢他人資料。處分紀錄刻意不提供，由 system prompt 引導使用者改用指令查詢。
// ctx = { userId, guild }；available(ctx) 不通過的工具不會宣告給模型。

const USAGE_PERIODS = {
    today: { label: '今日', fetch: id => system.getDailyUsage(id) },
    month: { label: '本月', fetch: id => system.getMonthlyUsage(id) },
    total: { label: '累計', fetch: id => system.getTotalUsage(id) },
};

const ESCALATION_ACTION = {
    ban: '停權（系統先無限期禁言，由管理員裁決是否停權）',
    kick: '踢出',
    mute: '禁言',
    warn: '追加警告',
};

const TOOLS = {
    get_my_usage: {
        declaration: {
            name: 'get_my_usage',
            description: '查詢發問者本人使用 AI 聊天的次數、token 用量與估算費用（美元）。只能查發問者自己。',
            parametersJsonSchema: {
                type: 'object',
                properties: {
                    period: { type: 'string', enum: Object.keys(USAGE_PERIODS), description: 'today=今日、month=本月、total=累計' },
                },
                required: ['period'],
            },
        },
        handler(ctx, { period }) {
            const p = USAGE_PERIODS[period] ?? USAGE_PERIODS.month;
            const u = p.fetch(ctx.userId);
            return {
                period: p.label,
                requests: u.queryCount,
                inputTokens: u.inputTokens,
                outputTokens: u.outputTokens,
                costUSD: Number(u.cost.toFixed(6)),
            };
        },
    },

    get_escalation_rules: {
        declaration: {
            name: 'get_escalation_rules',
            description: '查詢本伺服器的自動處分升級規則：在一段期間內累積多少次警告，系統會自動執行什麼處分。',
            parametersJsonSchema: { type: 'object', properties: {} },
        },
        handler(ctx) {
            const rules = modConfig.getRules(ctx.guild.id).map(r => ({
                window: moderation.formatHours(r.window_hours),
                warnThreshold: r.warn_threshold,
                action: ESCALATION_ACTION[r.action] || r.action,
                ...(r.action === 'mute' && r.duration_min != null ? { duration: moderation.formatMinutes(r.duration_min) } : {}),
            }));
            return rules.length ? { rules } : { rules, note: '本伺服器沒有設定自動升級規則' };
        },
    },

    get_bot_commands: {
        declaration: {
            name: 'get_bot_commands',
            description: '取得本機器人可供一般成員使用的指令與功能說明。',
            parametersJsonSchema: { type: 'object', properties: {} },
        },
        handler() {
            return { commands: commandList.map(c => ({ command: c.name, description: c.value })) };
        },
    },

    get_server_rules: {
        declaration: {
            name: 'get_server_rules',
            description: '讀取本伺服器規則頻道的規則全文。被問到伺服器規則、某行為是否違規、某類內容該發在哪個頻道時使用。'
                + '規則中的 <#頻道ID>、<@&身分組ID> 可原樣輸出，Discord 會顯示為名稱。',
            parametersJsonSchema: { type: 'object', properties: {} },
        },
        available: ctx => gptConfig.getRulesChannel(ctx.guild.id) !== null,
        async handler(ctx) {
            const text = await serverRules.get(ctx.guild);
            if (text === null) return { note: '本伺服器沒有設定規則頻道' };
            return text ? { rules: text } : { note: '規則頻道目前沒有文字內容' };
        },
    },
};

module.exports = {
    /** 提供給模型的 function declarations；ctx 省略時（例如切換模型前的測試）宣告全部工具。 */
    declarations(ctx) {
        return Object.values(TOOLS)
            .filter(t => !ctx || !t.available || t.available(ctx))
            .map(t => t.declaration);
    },

    /** 執行模型要求的工具呼叫，回傳 functionResponse 的 response 內容（成功為 output，失敗為 error）。 */
    async run(call, ctx) {
        console.log(`[aiTools] ${call.name} ${JSON.stringify(call.args ?? {})}, user ${ctx.userId}, guild ${ctx.guild.id}`);
        const tool = TOOLS[call.name];
        if (!tool) return { error: `未知的工具：${call.name}` };
        try {
            return { output: await tool.handler(ctx, call.args ?? {}) };
        } catch (err) {
            console.error(`[aiTools] ${call.name} 執行失敗:`, err);
            return { error: '查詢失敗' };
        }
    },
};
