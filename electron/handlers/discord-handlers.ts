import { ipcMain } from 'electron';
import type { AppSettings } from '../types';
import { inviteUrlFromToken, sendDiscordMessage, testDiscordToken } from '../services/discord-bot';
import { SECRET_MASK } from '../services/settings-secrets';

/**
 * The channels behind Settings > Discord: "test token" asks Discord who the
 * token is (and hands back the invite link), "send test" posts to the channel
 * the bot detected, and the invite link shown as the token is typed is main's,
 * made from that token without asking Discord.
 */
export function registerDiscordHandlers(deps: { getAppSettings: () => AppSettings }): void {
  ipcMain.handle('discord:test', async () => testDiscordToken(deps.getAppSettings().discordBotToken));

  // The page holds the saved token as a mask only (settings-secrets.ts): for
  // that one, the link is made from the token Tars keeps.
  ipcMain.handle('discord:inviteUrl', async (_event, token: unknown) =>
    inviteUrlFromToken(token === SECRET_MASK ? deps.getAppSettings().discordBotToken : token));

  ipcMain.handle('discord:sendTest', async () => {
    const settings = deps.getAppSettings();
    if (!settings.discordChannelId) {
      return { success: false, error: 'No channel yet: mention the bot or send it a direct message first.' };
    }
    const sent = await sendDiscordMessage('✅ Test message from Tars!', settings, settings.discordChannelId);
    return sent.ok ? { success: true } : { success: false, error: sent.error };
  });
}
