import type { ILinkHandler } from 'xterm';

/**
 * Click handler for OSC 8 hyperlinks (what Claude Code prints around a URL).
 *
 * xterm's own default asks "this link could be dangerous", then calls
 * `window.open('')` and sets its location afterwards. The main process denies
 * every `window.open`, so the user got the warning and then nothing. A click
 * now goes straight to the default browser through the main process, which
 * allows http and https only and drops any other scheme.
 */
export const terminalLinkHandler: ILinkHandler = {
  allowNonHttpProtocols: false,
  activate(_event, text) {
    void window.electronAPI?.updates?.openExternal(text);
  },
};
