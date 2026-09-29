import { BrowserWindow, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron';

/**
 * The right-click menu of text. Electron shows none unless the app builds one
 * on the webContents' `context-menu` event, and Tars built none: a right click
 * in a field offered no Paste, on every platform (1.9.1-win.3, Settings >
 * Hermes). The same on each platform: Electron's roles act on the focused
 * field and carry the system's own labels and accelerators.
 *
 * - An editable field: Cut, Copy, Paste, Select All, each enabled as Chromium
 *   says it can act (editFlags).
 * - Page text with a selection: Copy.
 * - Anything else: no menu, as before. A page that shows its own menu (the
 *   terminal panel headers) prevents the default, and Electron then emits no
 *   event at all.
 */
export function editMenuTemplate(
  params: Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>,
): MenuItemConstructorOptions[] {
  const f = params.editFlags;
  if (params.isEditable) {
    return [
      { role: 'cut', enabled: f.canCut },
      { role: 'copy', enabled: f.canCopy },
      { role: 'paste', enabled: f.canPaste },
      { role: 'selectAll', enabled: f.canSelectAll },
    ];
  }
  if (params.selectionText.trim()) return [{ role: 'copy', enabled: f.canCopy }];
  return [];
}

/** Wires the menu to one window's contents, once, when the window is made. */
export function installEditContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const template = editMenuTemplate(params);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
  });
}
