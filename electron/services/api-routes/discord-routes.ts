import { RouteApp, RouteContext } from './types';
import { sendDiscordMessage } from '../discord-bot';
import { chatHeadOf } from '../chat-senders';

export function registerDiscordRoutes(app: RouteApp, ctx: RouteContext): void {
  // POST /api/discord/send: send_discord, an agent answering in Discord.
  app.post('/api/discord/send', async (req, sendJson) => {
    const { message, channel_id } = req.body as { message?: string; channel_id?: string };
    if (!message) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }
    // The settings as they are now, not the server's startup snapshot.
    // Headed by the chat it comes from: Discord's way to name it (PR F).
    const sent = await sendDiscordMessage(`${chatHeadOf(req.callerAgentId)}👑 ${message}`, ctx.getAppSettings(), channel_id);
    if (sent.ok) sendJson({ success: true });
    else sendJson({ error: sent.error }, sent.status);
  });
}
