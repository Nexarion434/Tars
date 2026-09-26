'use client';

import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { rendererPlatform } from '@/lib/terminal-keys';

/**
 * Windows draws no frame (decision D5): its caption buttons sit over the top
 * 32 px of the window, and the window moves by a strip across the top plus the
 * page header, as the macOS traffic lights' column does there. Every control
 * in the header, and every overlay drawn over it, stays clickable: Chromium
 * adds and removes these regions in document order, so a later no-drag wins.
 */
const WINDOWS_DRAG_CSS = `
.app-shell main header { -webkit-app-region: drag; }
.app-shell main header :is(button, a, input, select, textarea, label, [role="button"], [role="combobox"], [tabindex]),
[role="dialog"], [aria-modal="true"], .fixed.inset-0 { -webkit-app-region: no-drag; }
`;

/** Read after hydration: the server render has no bridge, so both sides start at false. */
function useIsWindowsShell() {
  const [isWindows, setIsWindows] = useState(false);
  useEffect(() => setIsWindows(rendererPlatform() === 'win32'), []);
  return isWindows;
}

/**
 * The Windows caption band: the drag strip up to the native buttons, the drag
 * rules for the page header, and the buttons' colours, which follow the theme.
 * Renders nothing on macOS and Linux, whose strip ClientLayout draws.
 */
export function WindowsCaption() {
  const isWindows = useIsWindowsShell();
  const darkMode = useStore((s) => s.darkMode);

  // The shell switches the `dark` class in its own effect, which runs after
  // this one: the tokens are read once that has happened.
  useEffect(() => {
    if (!isWindows) return;
    const timer = setTimeout(() => {
      const tokens = getComputedStyle(document.documentElement);
      void window.electronAPI?.desktopShell?.setTitleBarOverlay({
        color: tokens.getPropertyValue('--bg-primary').trim(),
        symbolColor: tokens.getPropertyValue('--text-primary').trim(),
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [darkMode, isWindows]);

  if (!isWindows) return null;
  return (
    <>
      <style>{WINDOWS_DRAG_CSS}</style>
      <div className="window-drag hidden lg:block fixed top-0 left-0 h-8 z-[60]" style={{ width: 'env(titlebar-area-width, 100%)' }} />
    </>
  );
}
