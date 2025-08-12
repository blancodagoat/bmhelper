require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, ChannelType, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const https = require('https');
const http = require('http');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

client.commands = new Collection();
const LOG_CHANNEL_ID = '1382195029300346983';
const TICKET_ARCHIVE_CATEGORY_ID = process.env.TICKET_ARCHIVE_CATEGORY_ID || null;

// Role IDs
const WELCOME_ROLE_ID = '1381967901740765264'; // Role given to new members
const RESOLVED_ROLE_ID = '1381968331321507890'; // Role given when ticket is resolved

// Ticket tracking
const activeTickets = new Map(); // userId -> ticketData
const ticketCounter = new Map(); // guildId -> counter

// Media caching system
const mediaCache = new Map(); // messageId -> mediaInfo
const CACHE_DIR = './media_cache';

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Helper function to download and cache media
async function downloadAndCacheMedia(url, messageId, filename) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https:') ? https : http;
        const filePath = path.join(CACHE_DIR, filename);
        
        const file = fs.createWriteStream(filePath);
        
        protocol.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                resolve(filePath);
            });
            
            file.on('error', (err) => {
                fs.unlink(filePath, () => {}); // Delete the file if there's an error
                reject(err);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

// Helper function to clean up cached media
function cleanupCachedMedia(messageId) {
    const mediaInfo = mediaCache.get(messageId);
    if (mediaInfo && mediaInfo.files) {
        mediaInfo.files.forEach(filePath => {
            if (fs.existsSync(filePath)) {
                fs.unlink(filePath, (err) => {
                    if (err) console.error(`Failed to delete cached file: ${err}`);
                });
            }
        });
        mediaCache.delete(messageId);
    }
}

// Helper function to send logs
async function sendLog(embed) {
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (logChannel && logChannel.isTextBased()) {
      await logChannel.send({ embeds: [embed] });
    }
  } catch (error) {
    // Only log to console if it's not a permissions error (which is expected if bot can't see the channel)
    if (error.code !== 50001) {
      console.error('Failed to send log:', error);
    }
  }
}

// Helper function to create log embed
function createLogEmbed(title, description, color = 0x2b2d31, fields = []) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp()
    .addFields(fields);
}

// Helper function to get next ticket number
function getNextTicketNumber(guildId) {
  const current = ticketCounter.get(guildId) || 0;
  ticketCounter.set(guildId, current + 1);
  return current + 1;
}

// Helper function to create transcript
async function createTranscript(channel, ticketData) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const transcript = messages.reverse().map(msg => {
      const timestamp = msg.createdAt.toISOString();
      const author = msg.author.tag;
      const content = msg.content || '[No content]';
      const attachments = msg.attachments.size > 0 ? `[${msg.attachments.size} attachment(s)]` : '';
      return `[${timestamp}] ${author}: ${content} ${attachments}`;
    }).join('\n');

    const transcriptEmbed = createLogEmbed(
      '📜 Ticket Transcript',
      `Transcript for ticket #${ticketData.number}`,
      0x2b2d31,
      [
        { name: 'Ticket', value: `#${ticketData.number}`, inline: true },
        { name: 'Opener', value: ticketData.opener.tag, inline: true },
        { name: 'Status', value: ticketData.status, inline: true },
        { name: 'Created', value: `<t:${Math.floor(ticketData.createdAt / 1000)}:F>`, inline: true },
        { name: 'Closed', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
        { name: 'Transcript', value: transcript.length > 1024 ? transcript.substring(0, 1021) + '...' : transcript }
      ]
    );

    await sendLog(transcriptEmbed);
    return transcript;
  } catch (error) {
    console.error('Failed to create transcript:', error);
    return null;
  }
}

// Helper function to archive ticket
async function archiveTicket(channel, ticketData) {
  try {
    if (TICKET_ARCHIVE_CATEGORY_ID) {
      await channel.setParent(TICKET_ARCHIVE_CATEGORY_ID, { lockPermissions: false });
      await channel.setName(`archived-${channel.name}`);
      
      // Update permissions to be read-only for everyone
      const everyoneRole = channel.guild.roles.everyone;
      await channel.permissionOverwrites.set([
        { id: everyoneRole, deny: [PermissionsBitField.Flags.SendMessages] },
        { id: ticketData.opener.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory] }
      ]);

      // Add archive info to channel topic
      const archiveInfo = `ARCHIVED | Closed by: ${ticketData.closedBy?.tag || 'Unknown'} | Reason: ${ticketData.closeReason || 'No reason provided'}`;
      await channel.setTopic(archiveInfo);

      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to archive ticket:', error);
    return false;
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // Clean up any remaining cached media on startup
  if (fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR);
    files.forEach(file => {
      const filePath = path.join(CACHE_DIR, file);
      fs.unlink(filePath, (err) => {
        if (err) console.error(`Failed to clean up cached file: ${err}`);
      });
    });
    console.log(`Cleaned up ${files.length} cached media files on startup`);
  }
});

// Clean up cached media on bot shutdown
process.on('SIGINT', () => {
  console.log('Cleaning up cached media files...');
  if (fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR);
    files.forEach(file => {
      const filePath = path.join(CACHE_DIR, file);
      fs.unlink(filePath, (err) => {
        if (err) console.error(`Failed to clean up cached file: ${err}`);
      });
    });
    console.log(`Cleaned up ${files.length} cached media files on shutdown`);
  }
  process.exit(0);
});

// Periodic cleanup of old cached media (every 30 minutes)
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes
  
  mediaCache.forEach((mediaInfo, messageId) => {
    if (now - mediaInfo.timestamp > maxAge) {
      cleanupCachedMedia(messageId);
    }
  });
  
  // Also clean up orphaned files in cache directory
  if (fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR);
    files.forEach(file => {
      const filePath = path.join(CACHE_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtime.getTime() > maxAge) {
        fs.unlink(filePath, (err) => {
          if (err) console.error(`Failed to clean up old cached file: ${err}`);
        });
      }
    });
  }
}, 30 * 60 * 1000); // Run every 30 minutes

// Message Events
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  // Cache media files if present
  if (message.attachments.size > 0) {
      const mediaFiles = [];
      const mediaUrls = [];
      
      for (const attachment of message.attachments.values()) {
          // Check if it's an image or media file
          if (attachment.contentType && (
              attachment.contentType.startsWith('image/') ||
              attachment.contentType.startsWith('video/') ||
              attachment.contentType.startsWith('audio/')
          )) {
              try {
                  const filename = `${message.id}_${Date.now()}_${attachment.name}`;
                  const filePath = await downloadAndCacheMedia(attachment.url, message.id, filename);
                  mediaFiles.push(filePath);
                  mediaUrls.push(attachment.url);
              } catch (error) {
                  console.error(`Failed to cache media: ${error}`);
              }
          }
      }
      
      if (mediaFiles.length > 0) {
          mediaCache.set(message.id, {
              files: mediaFiles,
              urls: mediaUrls,
              author: message.author.id,
              timestamp: Date.now(),
              channelId: message.channel.id
          });
      }
  }
  
  const embed = createLogEmbed(
    '📝 Message Created',
    `**Channel:** <#${message.channel.id}>\n**Author:** ${message.author.tag} (${message.author.id})`,
    0x00ff00,
    [
      { name: 'Content', value: message.content || 'No text content', inline: false },
      { name: 'Attachments', value: message.attachments.size > 0 ? `${message.attachments.size} file(s)` : 'None', inline: true }
    ]
  );
  
  if (message.attachments.size > 0) {
      const attachmentList = Array.from(message.attachments.values()).map(att => 
          `[${att.name}](${att.url})`
      ).join('\n');
      embed.addFields({ name: '📎 Files', value: attachmentList, inline: false });
  }
  
  await sendLog(embed);
});

client.on('messageDelete', async (message) => {
  if (message.author?.bot) return;
  
  const embed = createLogEmbed(
    '🗑️ Message Deleted',
    `**Channel:** <#${message.channel.id}>\n**Author:** ${message.author?.tag || 'Unknown'} (${message.author?.id || 'Unknown'})`,
    0xff0000,
    [
      { name: 'Content', value: message.content || 'No text content', inline: false },
      { name: 'Deleted At', value: new Date().toISOString(), inline: true }
    ]
  );
  
  // Check if we have cached media for this message
  const cachedMedia = mediaCache.get(message.id);
  if (cachedMedia && cachedMedia.files.length > 0) {
      embed.addFields({ 
          name: '📸 Cached Media', 
          value: `Found ${cachedMedia.files.length} cached file(s)`, 
          inline: false 
      });
      
      // Send the log first
      await sendLog(embed);
      
      // Then send each cached media file individually
      for (let i = 0; i < cachedMedia.files.length; i++) {
          const filePath = cachedMedia.files[i];
          const originalUrl = cachedMedia.urls[i];
          
          if (fs.existsSync(filePath)) {
              try {
                  const mediaEmbed = new EmbedBuilder()
                      .setTitle(`📸 Deleted Media ${i + 1}/${cachedMedia.files.length}`)
                      .setDescription(`**Original Message:** ${message.id}\n**Author:** ${message.author?.tag || 'Unknown'}\n**Channel:** <#${message.channel.id}>`)
                      .setColor(0xff6b6b)
                      .setTimestamp();
                  
                  // Send the file with the embed
                  const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
                  if (logChannel) {
                      await logChannel.send({
                          embeds: [mediaEmbed],
                          files: [{
                              attachment: filePath,
                              name: `deleted_media_${message.id}_${i + 1}${path.extname(filePath)}`
                          }]
                      });
                  }
              } catch (error) {
                  console.error(`Failed to send cached media: ${error}`);
              }
          }
      }
      
      // Clean up cached files after sending
      cleanupCachedMedia(message.id);
  } else {
      // No cached media, just send the basic log
      sendLog(embed);
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return;
  
  const embed = createLogEmbed(
    '✏️ Message Edited',
    `Message edited in ${newMessage.channel}`,
    0xffff00,
    [
      { name: 'Author', value: `${newMessage.author.tag} (${newMessage.author.id})`, inline: true },
      { name: 'Channel', value: `${newMessage.channel.name} (${newMessage.channel.id})`, inline: true },
      { name: 'Before', value: oldMessage.content || 'No content' },
      { name: 'After', value: newMessage.content || 'No content' }
    ]
  );
  
  await sendLog(embed);
});

// Member Events
client.on('guildMemberAdd', async (member) => {
  // Automatically assign welcome role
  try {
    const welcomeRole = member.guild.roles.cache.get(WELCOME_ROLE_ID);
    if (welcomeRole) {
      await member.roles.add(welcomeRole);
      console.log(`Assigned welcome role to ${member.user.tag}`);
    }
  } catch (error) {
    console.error('Failed to assign welcome role:', error);
  }

  const embed = createLogEmbed(
    '👋 Member Joined',
    `${member.user.tag} joined the server`,
    0x00ff00,
    [
      { name: 'User', value: `${member.user.tag} (${member.user.id})`, inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: 'Member Count', value: member.guild.memberCount.toString(), inline: true },
      { name: 'Welcome Role', value: '✅ Assigned', inline: true }
    ]
  );
  
  await sendLog(embed);
});

client.on('guildMemberRemove', async (member) => {
  const embed = createLogEmbed(
    '👋 Member Left',
    `${member.user.tag} left the server`,
    0xff8800,
    [
      { name: 'User', value: `${member.user.tag} (${member.user.id})`, inline: true },
      { name: 'Joined At', value: member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>` : 'Unknown', inline: true },
      { name: 'Member Count', value: member.guild.memberCount.toString(), inline: true }
    ]
  );
  
  await sendLog(embed);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  // Nickname change
  if (oldMember.nickname !== newMember.nickname) {
    const embed = createLogEmbed(
      '📝 Nickname Changed',
      `${newMember.user.tag}'s nickname was updated`,
      0xffff00,
      [
        { name: 'User', value: `${newMember.user.tag} (${newMember.user.id})`, inline: true },
        { name: 'Before', value: oldMember.nickname || 'None', inline: true },
        { name: 'After', value: newMember.nickname || 'None', inline: true }
      ]
    );
    
    await sendLog(embed);
  }
  
  // Role changes
  const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
  const removedRoles = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id));
  
  if (addedRoles.size > 0) {
    const embed = createLogEmbed(
      '➕ Role Added',
      `${newMember.user.tag} received role(s)`,
      0x00ff00,
      [
        { name: 'User', value: `${newMember.user.tag} (${newMember.user.id})`, inline: true },
        { name: 'Roles Added', value: addedRoles.map(r => r.name).join(', '), inline: true }
      ]
    );
    
    await sendLog(embed);
  }
  
  if (removedRoles.size > 0) {
    const embed = createLogEmbed(
      '➖ Role Removed',
      `${newMember.user.tag} lost role(s)`,
      0xff8800,
      [
        { name: 'User', value: `${newMember.user.tag} (${newMember.user.id})`, inline: true },
        { name: 'Roles Removed', value: removedRoles.map(r => r.name).join(', '), inline: true }
      ]
    );
    
    await sendLog(embed);
  }
});

// Server Events
client.on('channelCreate', async (channel) => {
  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice) {
    const embed = createLogEmbed(
      '📝 Channel Created',
      `New ${channel.type === ChannelType.GuildText ? 'text' : 'voice'} channel created`,
      0x00ff00,
      [
        { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
        { name: 'Type', value: channel.type === ChannelType.GuildText ? 'Text' : 'Voice', inline: true },
        { name: 'Category', value: channel.parent?.name || 'None', inline: true }
      ]
    );
    
    await sendLog(embed);
  }
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (oldChannel.type === ChannelType.GuildText || oldChannel.type === ChannelType.GuildVoice) {
    const embed = createLogEmbed(
      '✏️ Channel Updated',
      `Channel ${newChannel.name} was updated`,
      0xffff00,
      [
        { name: 'Channel', value: `${newChannel.name} (${newChannel.id})`, inline: true },
        { name: 'Type', value: newChannel.type === ChannelType.GuildText ? 'Text' : 'Voice', inline: true }
      ]
    );
    
    await sendLog(embed);
  }
});

client.on('channelDelete', async (channel) => {
  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice) {
    const embed = createLogEmbed(
      '🗑️ Channel Deleted',
      `Channel ${channel.name} was deleted`,
      0xff0000,
      [
        { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
        { name: 'Type', value: channel.type === ChannelType.GuildText ? 'Text' : 'Voice', inline: true },
        { name: 'Category', value: channel.parent?.name || 'None', inline: true }
      ]
    );
    
    await sendLog(embed);
  }
});

client.on('roleCreate', async (role) => {
  const embed = createLogEmbed(
    '➕ Role Created',
    `New role ${role.name} was created`,
    0x00ff00,
    [
      { name: 'Role', value: `${role.name} (${role.id})`, inline: true },
      { name: 'Color', value: role.hexColor, inline: true },
      { name: 'Permissions', value: role.permissions.toArray().join(', ') || 'None', inline: true }
    ]
  );
  
  await sendLog(embed);
});

client.on('roleUpdate', async (oldRole, newRole) => {
  const embed = createLogEmbed(
    '✏️ Role Updated',
    `Role ${newRole.name} was updated`,
    0xffff00,
    [
      { name: 'Role', value: `${newRole.name} (${newRole.id})`, inline: true },
      { name: 'Color', value: `${oldRole.hexColor} → ${newRole.hexColor}`, inline: true },
      { name: 'Permissions', value: newRole.permissions.toArray().join(', ') || 'None', inline: true }
    ]
  );
  
  await sendLog(embed);
});

client.on('roleDelete', async (role) => {
  const embed = createLogEmbed(
    '🗑️ Role Deleted',
    `Role ${role.name} was deleted`,
    0xff0000,
    [
      { name: 'Role', value: `${role.name} (${role.id})`, inline: true },
      { name: 'Color', value: role.hexColor, inline: true }
    ]
  );
  
  await sendLog(embed);
});

client.on('guildUpdate', async (oldGuild, newGuild) => {
  const embed = createLogEmbed(
    '⚙️ Server Updated',
    `Server settings were updated`,
    0xffff00,
    [
      { name: 'Server', value: newGuild.name, inline: true }
    ]
  );
  
  await sendLog(embed);
});

client.on('emojiCreate', async (emoji) => {
  const embed = createLogEmbed(
    '😀 Emoji Added',
    `New emoji ${emoji.name} was added`,
    0x00ff00,
    [
      { name: 'Emoji', value: `${emoji.name} (${emoji.id})`, inline: true },
      { name: 'Animated', value: emoji.animated ? 'Yes' : 'No', inline: true }
    ]
  );
  
  await sendLog(embed);
});

client.on('emojiDelete', async (emoji) => {
  const embed = createLogEmbed(
    '🗑️ Emoji Removed',
    `Emoji ${emoji.name} was removed`,
    0xff0000,
    [
      { name: 'Emoji', value: `${emoji.name} (${emoji.id})`, inline: true },
      { name: 'Animated', value: emoji.animated ? 'Yes' : 'No', inline: true }
    ]
  );
  
  await sendLog(embed);
});

// Voice Events
client.on('voiceStateUpdate', async (oldState, newState) => {
  // Join voice channel
  if (!oldState.channelId && newState.channelId) {
    const embed = createLogEmbed(
      '🎤 Joined Voice',
      `${newState.member.user.tag} joined a voice channel`,
      0x00ff00,
      [
        { name: 'User', value: `${newState.member.user.tag} (${newState.member.user.id})`, inline: true },
        { name: 'Channel', value: `${newState.channel.name} (${newState.channel.id})`, inline: true }
      ]
    );
    
    await sendLog(embed);
  }
  
  // Leave voice channel
  if (oldState.channelId && !newState.channelId) {
    const embed = createLogEmbed(
      '🔇 Left Voice',
      `${oldState.member.user.tag} left a voice channel`,
      0xff8800,
      [
        { name: 'User', value: `${oldState.member.user.tag} (${oldState.member.user.id})`, inline: true },
        { name: 'Channel', value: `${oldState.channel?.name || 'Unknown'} (${oldState.channelId})`, inline: true }
      ]
    );
    
    await sendLog(embed);
  }
  
  // Move between voice channels
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    const embed = createLogEmbed(
      '🔄 Moved Voice',
      `${newState.member.user.tag} moved between voice channels`,
      0xffff00,
      [
        { name: 'User', value: `${newState.member.user.tag} (${newState.member.user.id})`, inline: true },
        { name: 'From', value: `${oldState.channel?.name || 'Unknown'} (${oldState.channelId})`, inline: true },
        { name: 'To', value: `${newState.channel.name} (${newState.channel.id})`, inline: true }
      ]
    );
    
    await sendLog(embed);
  }
});

// Ban/Unban Events
client.on('guildBanAdd', async (ban) => {
  const embed = createLogEmbed(
    '🔨 Member Banned',
    `${ban.user.tag} was banned from the server`,
    0xff0000,
    [
      { name: 'User', value: `${ban.user.tag} (${ban.user.id})`, inline: true },
      { name: 'Reason', value: ban.reason || 'No reason provided', inline: true }
    ]
  );
  
  await sendLog(embed);
});

client.on('guildBanRemove', async (ban) => {
  const embed = createLogEmbed(
    '🔓 Member Unbanned',
    `${ban.user.tag} was unbanned from the server`,
    0x00ff00,
    [
      { name: 'User', value: `${ban.user.tag} (${ban.user.id})`, inline: true }
    ]
  );
  
  await sendLog(embed);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction, client);
      return;
    }

    if (interaction.isButton()) {
      const customId = interaction.customId;
      if (customId === 'ticket_open') {
        await handleOpenTicket(interaction);
        return;
      }
      if (customId === 'ticket_claim') {
        await handleClaimTicket(interaction);
        return;
      }
      if (customId === 'ticket_unclaim') {
        await handleUnclaimTicket(interaction);
        return;
      }
      if (customId === 'ticket_rename') {
        await handleRenameTicket(interaction);
        return;
      }
      if (customId === 'ticket_add_member') {
        await handleAddMember(interaction);
        return;
      }
      if (customId === 'ticket_remove_member') {
        await handleRemoveMember(interaction);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'ticket_reason_modal') {
        await handleTicketReasonModal(interaction);
        return;
      }
      if (interaction.customId === 'ticket_rename_modal') {
        await handleTicketRenameModal(interaction);
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'ticket_member_select') {
        await handleMemberSelection(interaction);
        return;
      }
      if (interaction.customId === 'ticket_close_select') {
        await handleTicketCloseSelect(interaction);
        return;
      }
    }
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: 'An error occurred while executing that action.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: 'An error occurred while executing that action.', ephemeral: true }).catch(() => {});
    }
  }
});

// Log purge command usage
client.on('messageDeleteBulk', async (messages) => {
  const embed = createLogEmbed(
    '🧹 Messages Purged',
    `${messages.size} messages were bulk deleted`,
    0xff8800,
    [
      { name: 'Channel', value: `${messages.first().channel.name} (${messages.first().channel.id})`, inline: true },
      { name: 'Count', value: messages.size.toString(), inline: true }
    ]
  );
  
  await sendLog(embed);
});

// Load commands
const commandsPath = path.join(__dirname, 'plugins');
if (fs.existsSync(commandsPath)) {
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if (command && command.data && command.execute) {
      client.commands.set(command.data.name, command);
    }
  }
}

// Enhanced ticket system functions
async function handleOpenTicket(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'This can only be used in a server.', ephemeral: true });
  }

  const guild = interaction.guild;
  const opener = interaction.user;

  // Check if user already has an active ticket
  if (activeTickets.has(opener.id)) {
    const existingTicket = activeTickets.get(opener.id);
    if (existingTicket.status === 'open') {
      return interaction.reply({ 
        content: `You already have an active ticket: ${existingTicket.channel}`, 
        ephemeral: true 
      });
    }
  }

  // Check cooldown (5 minutes)
  const lastTicket = activeTickets.get(opener.id);
  if (lastTicket && Date.now() - lastTicket.createdAt < 300000) {
    const remaining = Math.ceil((300000 - (Date.now() - lastTicket.createdAt)) / 1000);
    return interaction.reply({ 
      content: `Please wait ${remaining} seconds before opening another ticket.`, 
      ephemeral: true 
    });
  }

  // Show reason modal
  const modal = new ModalBuilder()
    .setCustomId('ticket_reason_modal')
    .setTitle('Ticket Reason');

  const reasonInput = new TextInputBuilder()
    .setCustomId('ticket_reason')
    .setLabel('Why are you opening this ticket?')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Please describe your issue or question...')
    .setRequired(true)
    .setMaxLength(1000);

  const firstActionRow = new ActionRowBuilder().addComponents(reasonInput);
  modal.addComponents(firstActionRow);

  await interaction.showModal(modal);
}

async function handleTicketReasonModal(interaction) {
  const reason = interaction.fields.getTextInputValue('ticket_reason');
  const guild = interaction.guild;
  const opener = interaction.user;

  const staffRoleId = process.env.STAFF_ROLE_ID;
  const categoryId = process.env.TICKET_CATEGORY_ID;

  // Get next ticket number
  const ticketNumber = getNextTicketNumber(guild.id);
  const channelName = `ticket-${ticketNumber}`;

  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: opener.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
  ];
  
  if (staffRoleId) {
    overwrites.push({ 
      id: staffRoleId, 
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages] 
    });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: categoryId || null,
    permissionOverwrites: overwrites,
    topic: `Ticket #${ticketNumber} | Opener: ${opener.id} | Reason: ${reason}`
  });

  // Create ticket data
  const ticketData = {
    number: ticketNumber,
    opener: opener,
    channel: channel,
    reason: reason,
    status: 'open',
    claimedBy: null,
    createdAt: Date.now(),
    members: [opener.id],
    guildId: guild.id
  };

  activeTickets.set(opener.id, ticketData);

  // Create ticket embed
  const embed = new EmbedBuilder()
    .setTitle(`Ticket #${ticketNumber}`)
    .setDescription(`**Reason:** ${reason}\n\nA staff member will be with you shortly.`)
    .setColor(0x00ff00)
    .setTimestamp()
    .addFields(
      { name: 'Status', value: '🟢 Open', inline: true },
      { name: 'Opener', value: opener.tag, inline: true },
      { name: 'Claimed By', value: 'Unclaimed', inline: true }
    );

  // Create action buttons
  const claimButton = new ButtonBuilder()
    .setCustomId('ticket_claim')
    .setLabel('Claim Ticket')
    .setStyle(ButtonStyle.Primary);

  const closeSelect = new StringSelectMenuBuilder()
    .setCustomId('ticket_close_select')
    .setPlaceholder('Close ticket...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('✅ Resolved')
        .setDescription('Ticket was successfully resolved')
        .setValue('resolved')
        .setEmoji('✅'),
      new StringSelectMenuOptionBuilder()
        .setLabel('❌ Declined')
        .setDescription('Ticket was declined/not resolved')
        .setValue('declined')
        .setEmoji('❌')
    );

  const renameButton = new ButtonBuilder()
    .setCustomId('ticket_rename')
    .setLabel('Rename')
    .setStyle(ButtonStyle.Secondary);

  const memberButton = new ButtonBuilder()
    .setCustomId('ticket_add_member')
    .setLabel('Add Member')
    .setStyle(ButtonStyle.Secondary);

  const row1 = new ActionRowBuilder().addComponents(claimButton);
  const row2 = new ActionRowBuilder().addComponents(closeSelect);
  const row3 = new ActionRowBuilder().addComponents(renameButton, memberButton);

  await channel.send({ 
    content: `<@${opener.id}>`, 
    embeds: [embed], 
    components: [row1, row2, row3] 
  });

  // Log ticket creation
  const logEmbed = createLogEmbed(
    '🎫 Ticket Created',
    `New ticket #${ticketNumber} created by ${opener.tag}`,
    0x00ff00,
    [
      { name: 'Ticket', value: `#${ticketNumber}`, inline: true },
      { name: 'User', value: `${opener.tag} (${opener.id})`, inline: true },
      { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
      { name: 'Reason', value: reason, inline: true },
      { name: 'Category', value: channel.parent?.name || 'None', inline: true }
    ]
  );

  await sendLog(logEmbed);
  await interaction.reply({ content: `Ticket #${ticketNumber} created: ${channel}`, ephemeral: true });
}

async function handleClaimTicket(interaction) {
  const member = interaction.member;
  const isStaff = process.env.STAFF_ROLE_ID && member.roles.cache.has(process.env.STAFF_ROLE_ID);
  const isOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;

  if (!isStaff && !isOwner) {
    return interaction.reply({ content: 'You do not have permission to claim tickets.', ephemeral: true });
  }

  // Find ticket data
  const ticketData = Array.from(activeTickets.values()).find(ticket => 
    ticket.channel.id === interaction.channel.id
  );

  if (!ticketData) {
    return interaction.reply({ content: 'This is not a valid ticket channel.', ephemeral: true });
  }

  if (ticketData.claimedBy) {
    return interaction.reply({ content: 'This ticket is already claimed.', ephemeral: true });
  }

  // Claim the ticket
  ticketData.claimedBy = interaction.user;
  ticketData.status = 'claimed';

  // Update channel topic
  const topic = interaction.channel.topic?.replace(/Claimed By: .*/, `Claimed By: ${interaction.user.id}`) || 
                `Ticket #${ticketData.number} | Opener: ${ticketData.opener.id} | Claimed By: ${interaction.user.id}`;
  await interaction.channel.setTopic(topic);

  // Update embed
  const messages = await interaction.channel.messages.fetch({ limit: 10 });
  const ticketMessage = messages.find(msg => msg.embeds.length > 0 && msg.embeds[0].title?.includes('Ticket #'));
  
  if (ticketMessage) {
    try {
      const embed = EmbedBuilder.from(ticketMessage.embeds[0])
        .setColor(0xffff00)
        .spliceFields(2, 1, { name: 'Claimed By', value: interaction.user.tag, inline: true })
        .spliceFields(0, 1, { name: 'Status', value: '🟡 Claimed', inline: true });

      await ticketMessage.edit({ embeds: [embed] });
    } catch (error) {
      console.log('Could not update ticket embed (missing permissions)');
    }
  }

  // Update buttons
  const unclaimButton = new ButtonBuilder()
    .setCustomId('ticket_unclaim')
    .setLabel('Unclaim Ticket')
    .setStyle(ButtonStyle.Secondary);

  const closeSelect = new StringSelectMenuBuilder()
    .setCustomId('ticket_close_select')
    .setPlaceholder('Close ticket...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('✅ Resolved')
        .setDescription('Ticket was successfully resolved')
        .setValue('resolved')
        .setEmoji('✅'),
      new StringSelectMenuOptionBuilder()
        .setLabel('❌ Declined')
        .setDescription('Ticket was declined/not resolved')
        .setValue('declined')
        .setEmoji('❌')
    );

  const renameButton = new ButtonBuilder()
    .setCustomId('ticket_rename')
    .setLabel('Rename')
    .setStyle(ButtonStyle.Secondary);

  const memberButton = new ButtonBuilder()
    .setCustomId('ticket_add_member')
    .setLabel('Add Member')
    .setStyle(ButtonStyle.Secondary);

  const row1 = new ActionRowBuilder().addComponents(unclaimButton);
  const row2 = new ActionRowBuilder().addComponents(closeSelect);
  const row3 = new ActionRowBuilder().addComponents(renameButton, memberButton);

  await interaction.channel.send({ 
    content: `🎯 Ticket claimed by ${interaction.user.tag}`,
    components: [row1, row2, row3]
  });

  await interaction.reply({ content: 'Ticket claimed successfully!', ephemeral: true });
}

async function handleUnclaimTicket(interaction) {
  const member = interaction.member;
  const isStaff = process.env.STAFF_ROLE_ID && member.roles.cache.has(process.env.STAFF_ROLE_ID);
  const isOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;

  if (!isStaff && !isOwner) {
    return interaction.reply({ content: 'You do not have permission to unclaim tickets.', ephemeral: true });
  }

  // Find ticket data
  const ticketData = Array.from(activeTickets.values()).find(ticket => 
    ticket.channel.id === interaction.channel.id
  );

  if (!ticketData) {
    return interaction.reply({ content: 'This is not a valid ticket channel.', ephemeral: true });
  }

  if (!ticketData.claimedBy || ticketData.claimedBy.id !== interaction.user.id) {
    return interaction.reply({ content: 'You can only unclaim tickets that you claimed.', ephemeral: true });
  }

  // Unclaim the ticket
  ticketData.claimedBy = null;
  ticketData.status = 'open';

  // Update channel topic
  const topic = interaction.channel.topic?.replace(/Claimed By: .*/, '') || 
                `Ticket #${ticketData.number} | Opener: ${ticketData.opener.id}`;
  await interaction.channel.setTopic(topic);

  // Update embed
  const messages = await interaction.channel.messages.fetch({ limit: 10 });
  const ticketMessage = messages.find(msg => msg.embeds.length > 0 && msg.embeds[0].title?.includes('Ticket #'));
  
  if (ticketMessage) {
    try {
      const embed = EmbedBuilder.from(ticketMessage.embeds[0])
        .setColor(0x00ff00)
        .spliceFields(2, 1, { name: 'Claimed By', value: 'Unclaimed', inline: true })
        .spliceFields(0, 1, { name: 'Status', value: '🟢 Open', inline: true });

      await ticketMessage.edit({ embeds: [embed] });
    } catch (error) {
      console.log('Could not update ticket embed (missing permissions)');
    }
  }

  // Update buttons
  const claimButton = new ButtonBuilder()
    .setCustomId('ticket_claim')
    .setLabel('Claim Ticket')
    .setStyle(ButtonStyle.Primary);

  const closeSelect = new StringSelectMenuBuilder()
    .setCustomId('ticket_close_select')
    .setPlaceholder('Close ticket...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('✅ Resolved')
        .setDescription('Ticket was successfully resolved')
        .setValue('resolved')
        .setEmoji('✅'),
      new StringSelectMenuOptionBuilder()
        .setLabel('❌ Declined')
        .setDescription('Ticket was declined/not resolved')
        .setValue('declined')
        .setEmoji('❌')
    );

  const renameButton = new ButtonBuilder()
    .setCustomId('ticket_rename')
    .setLabel('Rename')
    .setStyle(ButtonStyle.Secondary);

  const memberButton = new ButtonBuilder()
    .setCustomId('ticket_add_member')
    .setLabel('Add Member')
    .setStyle(ButtonStyle.Secondary);

  const row1 = new ActionRowBuilder().addComponents(claimButton);
  const row2 = new ActionRowBuilder().addComponents(closeSelect);
  const row3 = new ActionRowBuilder().addComponents(renameButton, memberButton);

  await interaction.channel.send({ 
    content: `🔓 Ticket unclaimed by ${interaction.user.tag}`,
    components: [row1, row2, row3]
  });

  await interaction.reply({ content: 'Ticket unclaimed successfully!', ephemeral: true });
}

async function handleRenameTicket(interaction) {
  const member = interaction.member;
  const isStaff = process.env.STAFF_ROLE_ID && member.roles.cache.has(process.env.STAFF_ROLE_ID);
  const isOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;

  if (!isStaff && !isOwner) {
    return interaction.reply({ content: 'You do not have permission to rename tickets.', ephemeral: true });
  }

  // Show rename modal
  const modal = new ModalBuilder()
    .setCustomId('ticket_rename_modal')
    .setTitle('Rename Ticket');

  const nameInput = new TextInputBuilder()
    .setCustomId('ticket_new_name')
    .setLabel('New Ticket Name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Enter new ticket name...')
    .setRequired(true)
    .setMaxLength(100);

  const firstActionRow = new ActionRowBuilder().addComponents(nameInput);
  modal.addComponents(firstActionRow);

  await interaction.showModal(modal);
}

async function handleTicketRenameModal(interaction) {
  const newName = interaction.fields.getTextInputValue('ticket_new_name');
  
  try {
    await interaction.channel.setName(newName);
    await interaction.reply({ content: `Ticket renamed to: ${newName}`, ephemeral: true });
  } catch (error) {
    await interaction.reply({ content: 'Failed to rename ticket. Check bot permissions.', ephemeral: true });
  }
}

async function handleAddMember(interaction) {
  const member = interaction.member;
  const isStaff = process.env.STAFF_ROLE_ID && member.roles.cache.has(process.env.STAFF_ROLE_ID);
  const isOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;

  if (!isStaff && !isOwner) {
    return interaction.reply({ content: 'You do not have permission to add members to tickets.', ephemeral: true });
  }

  // Create member selection menu
  const select = new StringSelectMenuBuilder()
    .setCustomId('ticket_member_select')
    .setPlaceholder('Select a member to add...')
    .setMinValues(1)
    .setMaxValues(1);

  // Get guild members (excluding bots and already added members)
  const ticketData = Array.from(activeTickets.values()).find(ticket => 
    ticket.channel.id === interaction.channel.id
  );

  if (!ticketData) {
    return interaction.reply({ content: 'This is not a valid ticket channel.', ephemeral: true });
  }

  const guildMembers = interaction.guild.members.cache
    .filter(m => !m.user.bot && !ticketData.members.includes(m.id))
    .first(25); // Limit to 25 options

  guildMembers.forEach(member => {
    select.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(member.user.tag)
        .setDescription(`ID: ${member.id}`)
        .setValue(member.id)
    );
  });

  const row = new ActionRowBuilder().addComponents(select);
  await interaction.reply({ content: 'Select a member to add:', components: [row], ephemeral: true });
}

async function handleMemberSelection(interaction) {
  const memberId = interaction.values[0];
  const member = await interaction.guild.members.fetch(memberId);
  
  if (!member) {
    return interaction.update({ content: 'Member not found.', components: [], ephemeral: true });
  }

  // Add member to ticket
  await interaction.channel.permissionOverwrites.create(member, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true
  });

  // Update ticket data
  const ticketData = Array.from(activeTickets.values()).find(ticket => 
    ticket.channel.id === interaction.channel.id
  );

  if (ticketData && !ticketData.members.includes(memberId)) {
    ticketData.members.push(memberId);
  }

  await interaction.update({ 
    content: `✅ Added ${member.user.tag} to the ticket!`, 
    components: [], 
    ephemeral: true 
  });

  await interaction.channel.send(`👥 **${member.user.tag}** has been added to this ticket.`);
}

async function handleRemoveMember(interaction) {
  const member = interaction.member;
  const isStaff = process.env.STAFF_ROLE_ID && member.roles.cache.has(process.env.STAFF_ROLE_ID);
  const isOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;

  if (!isStaff && !isOwner) {
    return interaction.reply({ content: 'You do not have permission to remove members from tickets.', ephemeral: true });
  }

  // Create member selection menu for removal
  const select = new StringSelectMenuBuilder()
    .setCustomId('ticket_member_remove_select')
    .setPlaceholder('Select a member to remove...')
    .setMinValues(1)
    .setMaxValues(1);

  // Get ticket data
  const ticketData = Array.from(activeTickets.values()).find(ticket => 
    ticket.channel.id === interaction.channel.id
  );

  if (!ticketData) {
    return interaction.reply({ content: 'This is not a valid ticket channel.', ephemeral: true });
  }

  // Get members in ticket (excluding opener and staff)
  const ticketMembers = ticketData.members.filter(id => 
    id !== ticketData.opener.id && 
    id !== process.env.STAFF_ROLE_ID
  );

  if (ticketMembers.length === 0) {
    return interaction.reply({ content: 'No members to remove.', ephemeral: true });
  }

  ticketMembers.forEach(memberId => {
    const member = interaction.guild.members.cache.get(memberId);
    if (member) {
      select.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(member.user.tag)
          .setDescription(`ID: ${member.id}`)
          .setValue(member.id)
      );
    }
  });

  const row = new ActionRowBuilder().addComponents(select);
  await interaction.reply({ content: 'Select a member to remove:', components: [row], ephemeral: true });
}

async function handleCloseTicket(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'This can only be used in a server.', ephemeral: true });
  }

  const member = interaction.member;
  const isStaff = process.env.STAFF_ROLE_ID && member.roles.cache.has(process.env.STAFF_ROLE_ID);
  const isOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;

  // Find ticket data
  const ticketData = Array.from(activeTickets.values()).find(ticket => 
    ticket.channel.id === interaction.channel.id
  );

  if (!ticketData) {
    return interaction.reply({ content: 'This is not a valid ticket channel.', ephemeral: true });
  }

  // Check permissions
  const isOpener = ticketData.opener.id === interaction.user.id;
  if (!isStaff && !isOwner && !isOpener) {
    return interaction.reply({ content: 'Only staff, owners, or the ticket opener can close this ticket.', ephemeral: true });
  }

  // Show close selection menu
  const select = new StringSelectMenuBuilder()
    .setCustomId('ticket_close_select')
    .setPlaceholder('Close ticket...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('✅ Resolved')
        .setDescription('Ticket was successfully resolved')
        .setValue('resolved')
        .setEmoji('✅'),
      new StringSelectMenuOptionBuilder()
        .setLabel('❌ Declined')
        .setDescription('Ticket was declined/not resolved')
        .setValue('declined')
        .setEmoji('❌')
    );

  const row = new ActionRowBuilder().addComponents(select);
  await interaction.update({ content: 'Select how you are closing this ticket:', components: [row] });
}

async function handleTicketCloseSelect(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'This can only be used in a server.', ephemeral: true });
  }

  const closeType = interaction.values[0]; // 'resolved' or 'declined'
  const member = interaction.member;
  const isStaff = process.env.STAFF_ROLE_ID && member.roles.cache.has(process.env.STAFF_ROLE_ID);
  const isOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;

  // Find ticket data
  const ticketData = Array.from(activeTickets.values()).find(ticket => 
    ticket.channel.id === interaction.channel.id
  );

  if (!ticketData) {
    return interaction.reply({ content: 'This is not a valid ticket channel.', ephemeral: true });
  }

  // Check permissions
  const isOpener = ticketData.opener.id === interaction.user.id;
  if (!isStaff && !isOwner && !isOpener) {
    return interaction.reply({ content: 'Only staff, owners, or the ticket opener can close this ticket.', ephemeral: true });
  }

  // Update ticket data
  ticketData.status = 'closed';
  ticketData.closedBy = interaction.user;
  ticketData.closeReason = closeType === 'resolved' ? 'Resolved successfully' : 'Declined/not resolved';
  ticketData.closedAt = Date.now();

  // Handle role assignment for resolved tickets
  if (closeType === 'resolved') {
    try {
      const resolvedRole = interaction.guild.roles.cache.get(RESOLVED_ROLE_ID);
      if (resolvedRole) {
        const openerMember = await interaction.guild.members.fetch(ticketData.opener.id);
        await openerMember.roles.add(resolvedRole);
        console.log(`Assigned resolved role to ${ticketData.opener.tag}`);
      }
    } catch (error) {
      console.error('Failed to assign resolved role:', error);
    }
  }

  // Create transcript
  const transcript = await createTranscript(interaction.channel, ticketData);

  // Try to archive first, fallback to deletion
  const archived = await archiveTicket(interaction.channel, ticketData);

  if (archived) {
    await interaction.reply({ content: `Ticket ${closeType === 'resolved' ? 'resolved and archived' : 'declined and archived'} successfully!`, ephemeral: true });
  } else {
    // Delete the channel if archiving failed
    await interaction.reply({ content: `Closing ticket as ${closeType === 'resolved' ? 'resolved' : 'declined'} in 3 seconds…`, ephemeral: true });
    setTimeout(async () => {
      try {
        await interaction.channel.delete(`Ticket ${closeType === 'resolved' ? 'resolved' : 'declined'}`);
      } catch (e) {
        console.error('Failed to delete ticket channel:', e);
      }
    }, 3000);
  }

  // Remove from active tickets
  activeTickets.delete(ticketData.opener.id);

  // Log ticket closure
  const logEmbed = createLogEmbed(
    closeType === 'resolved' ? '✅ Ticket Resolved' : '❌ Ticket Declined',
    `Ticket #${ticketData.number} was ${closeType === 'resolved' ? 'resolved' : 'declined'}`,
    closeType === 'resolved' ? 0x00ff00 : 0xff8800,
    [
      { name: 'Ticket', value: `#${ticketData.number}`, inline: true },
      { name: 'Closed By', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
      { name: 'Opener', value: `${ticketData.opener.tag} (${ticketData.opener.id})`, inline: true },
      { name: 'Channel', value: `${interaction.channel.name} (${interaction.channel.id})`, inline: true },
      { name: 'Status', value: archived ? 'Archived' : 'Deleted', inline: true },
      { name: 'Transcript', value: transcript ? 'Created' : 'Failed', inline: true },
      { name: 'Role Assignment', value: closeType === 'resolved' ? '✅ Resolved role added' : '❌ No role added', inline: true }
    ]
  );

  await sendLog(logEmbed);
}

client.login(process.env.DISCORD_TOKEN);


