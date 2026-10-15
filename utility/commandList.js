// 對一般成員公開的指令說明。/help 與 AI 工具 get_bot_commands 共用，避免兩邊說法不一致。
module.exports = [
    {
        name: "/chat `prompt`",
        value: "我會回答你的問題或提示。",
    },
    {
        name: "在指定頻道 @我",
        value: "在管理員設定的頻道裡標註我，就能直接和我聊天。",
    },
    {
        name: "/costs `period`",
        value: "查詢 API 使用量與估算費用。\n選項：`今日` / `本月` / `累計`",
    },
    {
        name: "/modlog-me",
        value: "查詢自己的處分紀錄。",
    },
    {
        name: "右鍵/長按訊息 →「檢舉訊息」",
        value: "對於伺服器中違規的訊息，可以透過我檢舉，交給管理員處理。",
    },
    {
        name: "/help",
        value: "顯示此幫助訊息。",
    },
];
