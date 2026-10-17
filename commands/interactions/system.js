const Discord = require('discord.js');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { exec } = require('child_process');

const DB = require("../../utility/database.js");
const isafe = require("../../utility/interactionSafe.js");
const modelConfig = require("../../utility/modelConfig.js");
const gemini = require("../../utility/gemini.js");
const schedule = require("../../utility/schedule.js");
require('dotenv').config();

function describeModel(p) {
    return `${p.name}｜thinking ${p.thinkingLevel}｜輸出上限 ${p.maxOutputTokens}｜$${p.inputPricePerM} / $${p.outputPricePerM} 每百萬 token（輸入/輸出）`;
}

/** git pull 後重新讀取 config/models.json 與 prompts/default.txt，回傳附加在輸出後的說明。 */
function reloadAfterPull() {
    const notes = [];
    try {
        modelConfig.reload();
        notes.push(`模型設定已重新載入，目前：${modelConfig.current().name}`);
    } catch (e) {
        notes.push(`⚠️ config/models.json 載入失敗，沿用原設定：${e.message}`);
    }
    try {
        gemini.reloadPrompt();
        notes.push('system prompt 已重新載入');
    } catch (e) {
        notes.push(`⚠️ prompts/default.txt 載入失敗，沿用原內容：${e.message}`);
    }
    return '\n' + notes.join('\n');
}

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("system")
        .setDescription("系統操作")
        .addStringOption(option =>
            option.setName("action")
                .setDescription("指令")
                .setRequired(true)
        ).addStringOption(option =>
            option.setName("args")
                .setDescription("參數")
                .setRequired(false)
        ),

    async execute(client, interaction) {

        if(interaction.user.id !== process.env.AUTHOR_USERID) {
            await interaction.reply('只有受限制的對象才能使用這個指令。').catch(console.error);
            return;
        }

        // 進來先 ack：pull / cmdupdate 等會 exec 外部程序（git pull、node 腳本可能 >3 秒），
        // 且回覆在 callback 內才送出 —— 先 deferReply 佔位，之後一律用 editReply 免得 ack 逾時。
        if (!await isafe.safeDefer(interaction)) return;

        const action = interaction.options.getString("action");
        const args = interaction.options.getString("args") || "";

        try {
            switch(action) {
            case "eval":
                const result = eval(args);
                await interaction.editReply(`\`\`\`js\n${result}\n\`\`\``);
                break;

            case "pull":
                exec("git pull", (err, stdout, stderr) => {
                    if (err) {
                        console.error(`exec error: ${err}`);
                        interaction.editReply(`執行失敗：\`\`\`${err}\`\`\``).catch(console.error);
                        return;
                    }
                    const reloadNote = reloadAfterPull();
                    if(stderr) {
                        console.error(`stderr: ${stderr}`);
                        interaction.editReply(`執行完成，輸出錯誤：\`\`\`${stderr}\`\`\`${reloadNote}`).catch(console.error);
                        return;
                    }
                    console.log(`stdout: ${stdout}`);
                    interaction.editReply(`執行完成，輸出：\`\`\`${stdout}\`\`\`${reloadNote}`).catch(console.error);
                });
                break;

            case "model": {
                // 每次都重讀 models.json，手動改檔或 pull 失敗時也能取得最新內容；格式有誤由外層 catch 回報。
                modelConfig.reload();
                const name = args.trim();
                if (!name) {
                    const list = modelConfig.list().map(n => `- ${describeModel(modelConfig.get(n))}`).join('\n');
                    await interaction.editReply(`目前：${describeModel(modelConfig.current())}\n可切換：\n${list}`);
                    break;
                }

                const profile = modelConfig.get(name);
                if (!profile) {
                    await interaction.editReply(`config/models.json 裡沒有 ${name}。可切換：${modelConfig.list().join('、')}`);
                    break;
                }

                // 先實際呼叫一次，模型名稱打錯或 thinkingLevel 不支援時就不切換，避免之後每則訊息都失敗。
                try {
                    await gemini.probe(profile);
                } catch (e) {
                    await interaction.editReply(`測試呼叫失敗，未切換：\`\`\`${e.message}\`\`\``);
                    break;
                }

                modelConfig.set(name);
                await interaction.editReply(`✅ 已切換：${describeModel(profile)}`);
                break;
            }

            case "schedule": {
                const [sub, source] = args.trim().split(/\s+/);
                if (sub === 'test' && ['tw', 'jp'].includes(source)) {
                    // 結果以一般訊息送到本頻道（本回覆 10 秒後會被刪除）；模型產生約需數十秒到數分鐘。
                    await interaction.editReply(`🧪 正在以最新${source === 'tw' ? '國際版' : '日版'}公告測試日程預告…`);
                    await schedule.test(client, source, interaction.channel);
                    await interaction.editReply('🧪 測試完成，結果如上。');
                } else if (sub === 'draft' && ['tw', 'jp'].includes(source)) {
                    await interaction.editReply(`📝 正在以最新${source === 'tw' ? '國際版' : '日版'}公告產生正式草稿…`);
                    await schedule.draft(client, source);
                    await interaction.editReply('📝 草稿已送到審核頻道（附按鈕；按 ✅ 會真的發布）。');
                } else if (sub === 'poll') {
                    await interaction.editReply(await schedule.poll(client)
                        ? '已檢查一次新公告（有新公告會送到審核頻道）。'
                        : '目前已有一次檢查正在進行中，請稍後再試。');
                } else {
                    await interaction.editReply('用法：`schedule test <tw|jp>`｜`schedule draft <tw|jp>`｜`schedule poll`');
                }
                break;
            }

            case 'cmdupdateg':
                exec('node create-slash-global.js', (error, stdout, stderr) => {
                    if (error) {
                        console.error(`執行 create-slash-global.js 時發生錯誤: ${error.message}`);
                        interaction.editReply(`執行 create-slash-global.js 時發生錯誤: ${error.message}`).catch(console.error);
                        return;
                    }
                    if (stderr) {
                        console.error(`stderr: ${stderr}`);
                        interaction.editReply(`錯誤: ${stderr}`).catch(console.error);
                        return;
                    }
                    console.log(`stdout: ${stdout}`);
                    interaction.editReply(`更新成功:\n\`\`\`${stdout}\`\`\``).catch(console.error);
                });
                break;

            case "restart":
            case "r":
                await interaction.editReply("正在重啟...").catch(console.error);
                DB.closeConnection();
                process.exit(0);
                break;

            default:
                const usage = "可用的操作：\n" +
                    "- eval <code>: eval program\n" +
                    "- pull: git pull (並重新載入 config/models.json)\n" +
                    "- model [name]: 查看／切換 Gemini 模型\n" +
                    "- schedule test <tw|jp>: 以最新公告測試日程預告（不建立討論串、不發布）\n" +
                    "- schedule draft <tw|jp>: 以最新公告產生正式草稿到審核頻道（附按鈕，✅ 會真的發布）\n" +
                    "- schedule poll: 立即檢查一次新公告\n" +
                    "- cmdupdate: cmd update\n" +
                    "- cmdupdateg: cmd update global\n" +
                    "- restart (r): restart bot";
                await interaction.editReply(`\n\`\`\`${usage}\`\`\``).catch(console.error);
            }
        } catch (err) {
            console.error(err);
            await interaction.editReply("在處理過程中發生意外的錯誤：```" + err + "```").catch(console.error);
            return;
        }

        setTimeout(() => {
            interaction.deleteReply().catch(console.error);
        }, 10 * 1000);
    }
};