import { BrowserWindow, clipboard, dialog, type MessageBoxOptions } from 'electron';

/**
 * How a secret the user must carry somewhere else reaches them without the
 * page holding it (the Audit's L2 on #466): the Telegram auth token Settings
 * mints, and the webhook secret Hermes is given. A page with an XSS that read
 * either kept a way in after the page was fixed: an attacker's own Telegram
 * authorized to drive agents, posts to Tars as Hermes. The main process shows
 * the secret in a dialog of its own, which the page cannot read, or puts it on
 * the clipboard, and the page is told only that it is set.
 */

/** Shown once in a dialog of the main process, with a button that copies it. */
export async function showSecretOnce(title: string, secret: string, howToUse: string): Promise<void> {
  const options: MessageBoxOptions = {
    type: 'info', message: title, detail: `${secret}\n\n${howToUse}`,
    buttons: ['Copy', 'Close'], defaultId: 0, cancelId: 1, noLink: true,
  };
  const window = BrowserWindow.getFocusedWindow();
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (response === 0) clipboard.writeText(secret);
}

/** Put on the clipboard for the user to paste where it goes. Whether there was one to copy. */
export function copySecret(secret: string | undefined): boolean {
  if (!secret) return false;
  clipboard.writeText(secret);
  return true;
}
