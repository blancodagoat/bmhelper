## Modding Bot

Discord moderation bot with:
- **Enhanced Ticket System** with professional features
- `/purge` command to bulk delete messages
- Panel system with `/panel create` to post embeds (rules/info/custom) and ticket panels
- **Comprehensive Logging** for all server events

### Prerequisites
- Node.js 18.17+ installed
- A Discord Application and Bot created and added to your server with the following OAuth scopes and permissions:
  - Scopes: `bot`, `applications.commands`
  - Bot Permissions: `Manage Channels`, `Manage Roles`, `Manage Messages`, `Read Message History`, `Send Messages`, `Embed Links`, `Attach Files`
- **File System Access**: The bot needs write permissions to create a `media_cache/` directory for temporary media storage

### Setup
1. Copy `.env.example` to `.env` and fill values:
   - `DISCORD_TOKEN` – your bot token
   - `CLIENT_ID` – your application (bot) client ID
   - `GUILD_ID` – your development guild/server ID
   - `STAFF_ROLE_ID` – role ID that should see tickets
   - `TICKET_CATEGORY_ID` – optional category ID where tickets will be created
   - `TICKET_ARCHIVE_CATEGORY_ID` – optional category ID where closed tickets will be archived
   - `OWNER_ID` – optional owner ID for elevated actions

2. Install dependencies:
   ```bash
   npm install
   ```

3. Deploy slash commands to your guild:
   ```bash
   npm run deploy
   ```

4. Start the bot:
   ```bash
   npm run start
   ```

### Commands
- `/purge amount:<1-100>` – deletes the last N messages from the current channel.
- `/panel create` – posts an embed panel to a target channel. Options include:
  - `type` – `rules`, `info`, `ticket`, `custom`
  - `title` – title text (not used for `ticket`)
  - `description` – description text (not used for `ticket`)
  - `color` – hex color like `#2b2d31`
  - `channel` – target channel; defaults to current

For `type=ticket`, the bot posts a ticket panel with a button to open a ticket.

### Enhanced Ticket System Features

#### **Core Features**
- **Auto-numbering**: Tickets are automatically numbered (#1, #2, #3, etc.)
- **One-ticket-per-user**: Users can only have one active ticket at a time
- **Cooldown system**: 5-minute cooldown between ticket creations
- **Reason capture**: Modal popup to capture ticket reason when opening

#### **Staff Management**
- **Claim/Unclaim**: Staff can claim tickets to show they're working on them
- **Status indicators**: Visual status (🟢 Open, 🟡 Claimed, 🔒 Closed)
- **Member management**: Add/remove members to/from tickets
- **Ticket renaming**: Staff can rename ticket channels

#### **Ticket Lifecycle**
- **Archive instead of delete**: Tickets are moved to archive category when possible
- **Transcript generation**: Full conversation log sent to log channel
- **Comprehensive logging**: All ticket actions logged with details
- **Enhanced close options**: Two close types - "Resolved" and "Declined"
- **Automatic role assignment**: Users get a specific role when tickets are resolved

#### **Ticket Controls**
- **Claim Ticket**: Staff can claim unclaimed tickets
- **Unclaim Ticket**: Staff can unclaim their claimed tickets
- **Rename**: Change ticket channel name
- **Add Member**: Add users to ticket (with dropdown selection)
- **Remove Member**: Remove users from ticket
- **Close Ticket**: Choose between Resolved (gives user role) or Declined (no role)

#### **Permissions**
- **Staff role**: Can claim, unclaim, rename, add/remove members, and close tickets
- **Ticket opener**: Can close their own ticket
- **Owner**: Full access to all ticket functions

#### **Automatic Role Management**
- **Welcome Role**: Automatically assigned to new members when they join
- **Resolved Role**: Automatically assigned when tickets are closed as "Resolved"
- **No Role**: When tickets are closed as "Declined", no additional role is given

### Logging System
The bot logs **ALL** Discord events to the specified log channel:

#### **Message Events**
- Message creation, deletion, and editing
- Bulk message purges
- **Media caching and recovery**: Automatically caches images, videos, and audio files when messages are created, and reposts them in logs when messages are deleted

#### **Member Events**
- Joins, leaves, nickname changes
- Role additions/removals
- Bans and unbans

### Media Caching System
The bot includes an advanced media caching system that automatically:

#### **What Gets Cached**
- **Images**: All image formats (PNG, JPG, GIF, WebP, etc.)
- **Videos**: Video files and GIFs
- **Audio**: Audio files and voice messages
- **Documents**: Any file attachments

#### **How It Works**
1. **Automatic Caching**: When a message with media is sent, the bot immediately downloads and caches the file locally
2. **Smart Storage**: Files are stored with unique names to prevent conflicts
3. **Recovery**: If a message with media is deleted, the bot automatically reposts the cached media in the log channel
4. **Cleanup**: Cached files are automatically deleted after being posted in logs or after 30 minutes

#### **Benefits**
- **Evidence Preservation**: Never lose deleted media content
- **Moderation Support**: See exactly what was deleted for better moderation decisions
- **Audit Trail**: Complete record of all media that passed through your server
- **Automatic Cleanup**: No storage bloat - files are cleaned up automatically

#### **Technical Details**
- **Cache Directory**: `./media_cache/` (automatically created)
- **File Naming**: `{messageId}_{timestamp}_{originalName}`
- **Cleanup Schedule**: Every 30 minutes + on bot startup/shutdown
- **Supported Protocols**: HTTP and HTTPS downloads
- **Error Handling**: Graceful fallback if media can't be cached

#### **Server Events**
- Channel creation, updates, deletion
- Role creation, updates, deletion
- Server setting changes
- Emoji additions/removals

#### **Voice Events**
- Voice channel joins, leaves, moves

#### **Ticket Events**
- Ticket creation with reason and details
- Ticket claims and unclaims
- Ticket closure with transcript
- Archive status

### Environment Variables
- `DISCORD_TOKEN` – Bot authentication token
- `CLIENT_ID` – Bot application client ID
- `GUILD_ID` – Target Discord server ID
- `STAFF_ROLE_ID` – Role ID for staff permissions
- `TICKET_CATEGORY_ID` – Category for new tickets (optional)
- `TICKET_ARCHIVE_CATEGORY_ID` – Category for archived tickets (optional)
- `OWNER_ID` – User ID with owner permissions (optional)

### Notes
- The `/panel create` command does not support a `body` option; use `title` and `description`.
- Purge respects Discord limits (max 100 per call, cannot delete messages older than 14 days).
- If `TICKET_ARCHIVE_CATEGORY_ID` is set, tickets are archived instead of deleted.
- Ticket transcripts are automatically generated and sent to the log channel.
- Staff members can manage multiple tickets simultaneously.
- The bot automatically enforces one-ticket-per-user and cooldown restrictions.


