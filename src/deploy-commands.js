require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
const token = process.env.DISCORD_TOKEN;

if (!clientId || !guildId || !token) {
  console.error('Missing CLIENT_ID, GUILD_ID, or DISCORD_TOKEN in .env');
  process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, 'plugins');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
  } else {
    console.warn(`[WARN] The command at ${filePath} is missing a required "data" or "execute" property.`);
  }
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log(`Deploying ${commands.length} commands to guild ${guildId}…`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('Commands deployed.');
  } catch (error) {
    console.error('Failed to deploy commands:', error);
  }
})();


