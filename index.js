const Discord = require('discord.js');
const fs = require('fs');
const dotenv = require('dotenv');
const notify = require('./utility/notify');
dotenv.config();

const options = {
    restTimeOffset: 100,
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.GuildMembers,
        Discord.GatewayIntentBits.GuildVoiceStates,
        Discord.GatewayIntentBits.DirectMessages,
        Discord.GatewayIntentBits.MessageContent,
    ],
    makeCache: Discord.Options.cacheWithLimits({
        MessageManager: 50,
        GuildMemberManager: {
            maxSize: 200,
            keepOverLimit: member => member.id === member.client.user.id,
        },
    }),
    sweepers: {
        messages: { interval: 300, lifetime: 600 },
        users: { interval: 3600, filter: () => user => !user.bot },
    }
};
const client = new Discord.Client(options);

if (!fs.existsSync(process.env.DATABASE_URL)) {
    const createDB = require('./createDB');
    createDB();
}

client.once('clientReady', () => {
    console.log('Bot is online!');
    // 綁定 client 並發送上線通知
    notify.init(client);
    notify.log(`登入成功: ${Discord.time(new Date())}`);
    // 啟動每日資料庫備份排程
    require('./utility/backup').start();
});

const eventFiles = fs.readdirSync('./models').filter(file => file.endsWith('.js'));
for (const file of eventFiles) {
    const command = require(`./models/${file}`);
    client.on(command.event, (...args) => command.execute(client, ...args));
    delete require.cache[require.resolve(`./models/${file}`)];
}

client.interactionCmds = new Discord.Collection();
const interCmdFiles = fs.readdirSync('./commands/interactions').filter(file => file.endsWith('.js'));
for (const file of interCmdFiles) {
    const command = require(`./commands/interactions/${file}`);
    client.interactionCmds.set(command.data.name, command);
    delete require.cache[require.resolve(`./commands/interactions/${file}`)];
}

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
    notify.error('發生不可控制的錯誤', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    notify.error('發生意料之外的錯誤', error);
});

client.login(process.env.DISCORD_TOKEN);
