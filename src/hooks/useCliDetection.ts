'use client';

import { useCallback, useEffect, useState } from 'react';
import { createDetectionStore, type DetectedCliPaths } from '@/lib/cli-detection';

export type { DetectedCliPaths } from '@/lib/cli-detection';

/** The window's one copy of the detection, shared by every page that reads it (lib/cli-detection.ts). */
const detection = createDetectionStore(async (refresh) =>
  (await window.electronAPI?.cliPaths?.detect(refresh ? { refresh: true } : undefined)) ?? {});

/**
 * The one detection of the CLIs (2.0.4, the Audit's Info on #460): main's cliPaths:detect, which takes the path set
 * in CLI Paths when it exists and else looks where Tars looks (the PATH, the usual install folders). CLI Paths and
 * Providers both read it, so neither says a CLI is ready where the other finds none: CLI Paths used to show nothing
 * until detect now, while Providers asked the PATH for a version on its own. A page opens on the window's last answer,
 * so a page opened after another shows what that one read at once instead of "looking", and asks main again, which
 * keeps the answer for the app run; `detectAgain` looks again, for a CLI installed since.
 */
export function useCliDetection() {
  const [paths, setPaths] = useState<DetectedCliPaths | null>(() => detection.known());
  const [detecting, setDetecting] = useState(false);

  const read = useCallback(async (refresh: boolean): Promise<DetectedCliPaths> => {
    setDetecting(true);
    try {
      const found = await detection.read(refresh);
      setPaths(found);
      return found;
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => { void read(false); }, [read]);

  return { paths, detecting, detectAgain: () => read(true) };
}
