'use client';

import { useCallback, useEffect, useState } from 'react';

/** Where Tars found each CLI, by its CLI Paths key (`codex`, `qwencode`): a path, or '' where it found none. */
export type DetectedCliPaths = Record<string, string>;

/**
 * The one detection of the CLIs (2.0.4, the Audit's Info on #460): main's cliPaths:detect, which takes the path set
 * in CLI Paths when it exists and else looks where Tars looks (the PATH, the usual install folders). CLI Paths,
 * Providers and New agent all read it, so none says a CLI is ready where another finds none: CLI Paths used to show
 * nothing until detect now, while Providers asked the PATH for a version on its own. Asked once as a page opens
 * (main keeps the answer for the app run); `detectAgain` looks again, for a CLI installed since.
 */
export function useCliDetection() {
  const [paths, setPaths] = useState<DetectedCliPaths | null>(null);
  const [detecting, setDetecting] = useState(false);

  const read = useCallback(async (refresh: boolean): Promise<DetectedCliPaths> => {
    setDetecting(true);
    try {
      const found: DetectedCliPaths = (await window.electronAPI?.cliPaths?.detect(refresh ? { refresh: true } : undefined)) ?? {};
      setPaths(found);
      return found;
    } catch {
      setPaths({});
      return {};
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => { void read(false); }, [read]);

  return { paths, detecting, detectAgain: () => read(true) };
}
