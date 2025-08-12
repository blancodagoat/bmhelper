const { SlashCommandBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Create and post a panel embed')
    .addSubcommand(sc => sc
      .setName('create')
      .setDescription('Post a panel embed in a channel')
      .addStringOption(opt => opt
        .setName('type')
        .setDescription('Type of panel to post')
        .setRequired(true)
        .addChoices(
          { name: 'rules', value: 'rules' },
          { name: 'info', value: 'info' },
          { name: 'ticket', value: 'ticket' },
          { name: 'custom', value: 'custom' }
        )
      )
      .addStringOption(opt => opt
        .setName('title')
        .setDescription('Title for the embed (not used for ticket)')
        .setRequired(false)
      )
      .addStringOption(opt => opt
        .setName('description')
        .setDescription('Description for the embed (not used for ticket)')
        .setRequired(false)
      )
      .addStringOption(opt => opt
        .setName('color')
        .setDescription('Hex color like #2b2d31')
        .setRequired(false)
      )
      .addChannelOption(opt => opt
        .setName('channel')
        .setDescription('Target channel to post in')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
      )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    }

    if (interaction.options.getSubcommand() !== 'create') {
      return interaction.reply({ content: 'Unsupported subcommand.', ephemeral: true });
    }

    const type = interaction.options.getString('type', true);
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');
    const colorHex = interaction.options.getString('color') || '#2b2d31';
    const target = interaction.options.getChannel('channel') || interaction.channel;

    await interaction.deferReply({ ephemeral: true });

    if (type === 'ticket') {
      const embed = new EmbedBuilder()
        .setTitle('Create a Ticket')
        .setDescription('Need help? Click the button below to open a private ticket with the staff team.')
        .setColor(parseInt(colorHex.replace('#', ''), 16) || 0x2b2d31)
        .setTimestamp();

      const button = new ButtonBuilder()
        .setCustomId('ticket_open')
        .setLabel('Open Ticket')
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(button);
      await target.send({ embeds: [embed], components: [row] });
      return interaction.editReply(`Ticket panel posted in ${target}`);
    }

    const embed = new EmbedBuilder()
      .setColor(parseInt(colorHex.replace('#', ''), 16) || 0x2b2d31)
      .setTimestamp();

    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);

    if (type === 'rules') {
      embed.setTitle(title || 'Server Rules');
      if (!description) {
        embed.setDescription('1) Be respectful\n2) No spam or advertising\n3) Follow Discord ToS');
      }
    }

    if (type === 'info') {
      embed.setTitle(title || 'Information');
      if (!description) {
        embed.setDescription('Welcome to the server! Use the channels on the left to navigate.');
      }
    }

    await target.send({ embeds: [embed] });
    return interaction.editReply(`Panel posted in ${target}`);
  }
};


