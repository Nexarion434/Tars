/** Where Tars found each CLI, by its CLI Paths key (`codex`, `qwencode`): a path, or '' where it found none. */
export type DetectedCliPaths = Record<string, string>;

/**
 * The window's copy of main's one detection of the CLIs (cliPaths:detect, cached in main for the app run). Each page
 * that reads it (useCliDetection) used to start empty and say "looking" until its own ask returned, so CLI Paths
 * opened after Providers showed no path where Providers said ready (the QA's train 3 of 2.0.4). The copy is the last
 * answer, which a page opened later starts from; every opening still asks main, which answers from its cache or
 * detects anew when the saved paths changed, and pages opened together share one ask. The answer of the latest ask
 * stands, so a refresh is never undone by an older ask that returns after it; a failed ask keeps the last answer.
 */
export function createDetectionStore(ask: (refresh: boolean) => Promise<DetectedCliPaths>) {
  let known: DetectedCliPaths | null = null;
  let shared: Promise<DetectedCliPaths> | null = null;
  let latest = 0;

  return {
    /** The last answer, or null before the first one. */
    known: () => known,
    /** Asks main, or joins the plain ask in flight; `refresh` always asks anew. */
    read(refresh: boolean): Promise<DetectedCliPaths> {
      if (!refresh && shared) return shared;
      const turn = ++latest;
      const current = ask(refresh).then(
        (found) => {
          if (turn === latest) known = found;
          return turn === latest ? found : known ?? found;
        },
        () => known ?? {},
      ).finally(() => { if (shared === current) shared = null; });
      if (!refresh) shared = current;
      return current;
    },
  };
}
