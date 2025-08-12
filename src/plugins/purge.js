const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete a number of recent messages in this channel')
    .addIntegerOption(opt =>
      opt.setName('amount')
        .setDescription('Number of messages to delete (1-100)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    }

    const amount = interaction.options.getInteger('amount', true);
    const channel = interaction.channel;

    await interaction.deferReply({ ephemeral: true });

    try {
      const deleted = await channel.bulkDelete(amount, true);
      await interaction.editReply(`Deleted ${deleted.size} messages.`);
    } catch (error) {
      console.error('Purge error:', error);
      await interaction.editReply('Failed to delete messages. Note: I cannot delete messages older than 14 days, and I need Manage Messages permission.');
    }
  }
};


