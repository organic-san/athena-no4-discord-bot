const { REST, Routes } = require('discord.js');
require('dotenv').config();

// 清除已註冊的斜線指令：對目標路由 PUT 空陣列即可清空。
const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
	// 清除全局指令
	try {
		console.log('Clearing global application (/) commands...');
		await rest.put(
			Routes.applicationCommands(process.env.BOT_USERID),
			{ body: [] },
		);
		console.log('Successfully cleared global commands.');
	} catch (error) {
		console.error('Failed to clear global commands:', error);
	}

	// 清除單一伺服器（MAIN_GUILDID）指令
	if (process.env.MAIN_GUILDID) {
		try {
			console.log(`Clearing guild application (/) commands for ${process.env.MAIN_GUILDID}...`);
			await rest.put(
				Routes.applicationGuildCommands(process.env.BOT_USERID, process.env.MAIN_GUILDID),
				{ body: [] },
			);
			console.log('Successfully cleared guild commands.');
		} catch (error) {
			console.error('Failed to clear guild commands:', error);
		}
	} else {
		console.log('MAIN_GUILDID not set, skipping guild command clear.');
	}
})();
