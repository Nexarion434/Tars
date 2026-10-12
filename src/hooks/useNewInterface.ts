'use client';

import { useEffect, useState } from 'react';

/** Sent by the settings hook once a save of the switch has gone through (main does not push it back). */
export const NEW_INTERFACE_EVENT = 'tars:new-interface';

/**
 * Whether Settings, Preferences, "New interface" is on (`newInterface` in
 * app-settings.json, off when absent). Read once at launch, then followed: a
 * save from Settings announces itself on the window, and a push from main
 * carries it when one does. Until the read answers it is off, so the shell
 * before is what draws first, as it always did.
 */
export function useNewInterface(): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    const api = window.electronAPI?.appSettings;
    let alive = true;
    api?.get()
      .then(settings => {
        if (alive) setOn((settings as { newInterface?: unknown } | null)?.newInterface === true);
      })
      .catch(() => { /* no settings: the shell before */ });

    const fromSave = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail;
      if (typeof value === 'boolean') setOn(value);
    };
    window.addEventListener(NEW_INTERFACE_EVENT, fromSave);
    const offPush = api?.onUpdated?.(pushed => {
      const value = (pushed as { newInterface?: unknown } | null)?.newInterface;
      if (typeof value === 'boolean') setOn(value);
    });
    return () => {
      alive = false;
      window.removeEventListener(NEW_INTERFACE_EVENT, fromSave);
      offPush?.();
    };
  }, []);

  return on;
}
