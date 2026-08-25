'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import type { Terminal } from 'xterm';
import type { FitAddon } from 'xterm-addon-fit';
import type { AgentStatus } from '@/types/electron';
import { isElectron } from '@/hooks/useElectron';
import { TERMINAL_CONFIG } from '../constants';
import { getTerminalTheme } from '@/components/AgentWorld/constants';
import { attachShiftEnterHandler, suppressMouseTracking } from '@/lib/terminal';

interface TerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  resizeObserver: ResizeObserver;
  disposed: boolean;
  lastCols: number;
  lastRows: number;
  /**
   * Live output that arrived before the stored transcript had finished being
   * replayed, held back so it cannot overtake it. Null once the panel is
   * caught up and taking writes directly.
   */
  replayPending: string[] | null;
  /** Woken when something lands in `replayPending`. */
  onReplayChunk: (() => void) | null;
  /**
   * True from the moment the panel is registered until its stored transcript
   * has been replayed and the geometry handed over. Every other fit in the
   * hook is suppressed for that window: a fit landing in the middle of it
   * reflows the screen out from under a repaint that was measured against it.
   */
  settling: boolean;
}

interface UseMultiTerminalOptions {
  agents: AgentStatus[];
  initialFontSize?: number;
  onFontSizeChange?: (size: number) => void;
  theme?: 'dark' | 'light';
  onTerminalReady?: (agentId: string) => void;
  broadcastMode?: boolean;
}

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 11;

// Safely fit a terminal and sync PTY dimensions
function safeFit(agentId: string, entry: TerminalEntry) {
  if (entry.disposed) return;
  // A panel still replaying its transcript owns its own geometry until it says
  // otherwise. The window resize, the font change and the ResizeObserver all
  // land here, and any of them firing mid-replay is the defect this guards.
  if (entry.settling) return;
  try {
    entry.fitAddon.fit();
    const { cols, rows } = entry.terminal;
    // Only resize PTY if dimensions actually changed
    if (cols !== entry.lastCols || rows !== entry.lastRows) {
      entry.lastCols = cols;
      entry.lastRows = rows;
      if (isElectron()) {
        window.electronAPI!.agent.resize({ id: agentId, cols, rows }).catch(() => {});
      }
    }
  } catch {}
}

/**
 * Write into a terminal and wait for it to have been parsed.
 *
 * `Terminal.write` is asynchronous: it queues the bytes and parses them in
 * chunks off a later task. Resizing before that queue has drained reinterprets
 * the part still unparsed at the new width, which is the whole defect this
 * replay path exists to avoid, so the transcript has to be flushed before the
 * panel is fitted. The timeout is a deadlock guard: a terminal disposed while
 * its queue is draining never calls back, and everything that sets a panel up
 * (its input handlers included) is waiting behind this.
 */
function writeAndFlush(term: Terminal, data: string): Promise<void> {
  return new Promise<void>(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    setTimeout(done, 3000);
    try {
      term.write(data, done);
    } catch {
      done();
    }
  });
}

/**
 * Give the PTY the panel's geometry, and let the CLI's answer to it land while
 * xterm is still the size the frame on screen was written at.
 *
 * The order matters and it is not the obvious one. A CLI erases its previous
 * frame by moving up as many rows as that frame took and clearing
 * (`ESC[<n>A ESC[0J`), and it counted those rows against the width it had when
 * it drew them. Resize xterm first and the frame on screen reflows to more
 * rows than the CLI is about to erase, so the top of it survives every repaint
 * from then on: one stale fragment welded above the live screen.
 *
 * Resizing the PTY first inverts that. The repaint arrives as one chunk, its
 * erase is measured against the frame that is still on screen at the width it
 * was drawn at, so it clears exactly, and the frame it paints is already
 * composed for the narrower panel. Fitting xterm afterwards only has to reflow
 * lines that already fit, which is a no-op.
 *
 * Nothing is waited on forever: an agent whose CLI is sitting idle repaints
 * when it feels like it, and the fit that follows is correct either way.
 */
async function handOverGeometry(agentId: string, entry: TerminalEntry, term: Terminal) {
  if (!isElectron()) return;
  const proposed = entry.fitAddon.proposeDimensions();
  if (!proposed || !proposed.cols || !proposed.rows) return;
  if (proposed.cols === term.cols && proposed.rows === term.rows) return;

  entry.replayPending = [];
  entry.lastCols = proposed.cols;
  entry.lastRows = proposed.rows;
  await window.electronAPI!.agent
    .resize({ id: agentId, cols: proposed.cols, rows: proposed.rows })
    .catch(() => {});

  // The repaint, if one is coming. The short settle after the first chunk is
  // for a frame that arrives split across several of them: fitting between two
  // halves of one frame would reinterpret the second half at the new width.
  await new Promise<void>(resolve => {
    const giveUp = setTimeout(resolve, 400);
    entry.onReplayChunk = () => {
      clearTimeout(giveUp);
      entry.onReplayChunk = null;
      setTimeout(resolve, 80);
    };
  });
  entry.onReplayChunk = null;

  const chunks = entry.replayPending ?? [];
  entry.replayPending = null;
  if (chunks.length && !entry.disposed) {
    await writeAndFlush(term, chunks.join(''));
    term.scrollToBottom();
  }
}

export function useMultiTerminal({ agents, initialFontSize, onFontSizeChange, theme = 'dark', onTerminalReady, broadcastMode = false }: UseMultiTerminalOptions) {
  const terminalsRef = useRef<Map<string, TerminalEntry>>(new Map());
  const xtermModuleRef = useRef<{ Terminal: typeof Terminal; FitAddon: typeof FitAddon } | null>(null);
  // Keyed by container, not just agent id: a panel can unmount and remount into
  // a fresh div while a previous init is still awaiting layout, and an agent-id
  // key made the newer registration a no-op (blank panel forever).
  const initializingRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [fontSize, setFontSize] = useState(initialFontSize ?? DEFAULT_FONT_SIZE);
  const fitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const prevInitialFontSizeRef = useRef(initialFontSize);
  const onTerminalReadyRef = useRef(onTerminalReady);
  const broadcastModeRef = useRef(broadcastMode);
  // Written in an effect, not during render: a ref assignment during render
  // is unsafe under concurrent rendering, and every reader of this one runs
  // after commit (a callback, a subscription), so the timing is the same.
  useEffect(() => {
    onTerminalReadyRef.current = onTerminalReady;
    broadcastModeRef.current = broadcastMode;
  }, [onTerminalReady, broadcastMode]);

  // Load xterm modules once
  const loadModules = useCallback(async () => {
    if (xtermModuleRef.current) return xtermModuleRef.current;
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('xterm'),
      import('xterm-addon-fit'),
    ]);
    xtermModuleRef.current = { Terminal, FitAddon };
    return xtermModuleRef.current;
  }, []);

  // Debounced fit: coalesces rapid resize events into one fit+resize
  const debouncedFit = useCallback((agentId: string, delay = 80) => {
    const prev = fitTimersRef.current.get(agentId);
    if (prev) clearTimeout(prev);
    fitTimersRef.current.set(agentId, setTimeout(() => {
      fitTimersRef.current.delete(agentId);
      const entry = terminalsRef.current.get(agentId);
      if (entry && !entry.disposed) {
        safeFit(agentId, entry);
      }
    }, delay));
  }, []);

  // Create and attach a terminal to a container.
  // Uses a ResizeObserver to wait for the container to have real dimensions
  // instead of giving up after a single retry.
  const initTerminal = useCallback(async (agentId: string, container: HTMLDivElement) => {
    if (initializingRef.current.get(agentId) === container) return;
    initializingRef.current.set(agentId, container);

    // True once a newer registration or an unregister superseded this run, or
    // React detached the container. Publishing a terminal into terminalsRef
    // after that is what left detached emulators consuming PTY output.
    const superseded = () =>
      initializingRef.current.get(agentId) !== container || !container.isConnected;

    try {
      const modules = await loadModules();
      if (superseded()) return;

      // Wait for layout to settle so container has real dimensions
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (superseded()) return;

      const rect = container.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) {
        // Container too small: wait for it to get real dimensions via ResizeObserver
        const ready = await new Promise<boolean>(resolve => {
          let resolved = false;
          const observer = new ResizeObserver((entries) => {
            if (resolved) return;
            for (const entry of entries) {
              const { width, height } = entry.contentRect;
              if (width >= 10 && height >= 10) {
                resolved = true;
                observer.disconnect();
                resolve(true);
                return;
              }
            }
          });
          observer.observe(container);
          // Safety timeout: don't wait forever
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              observer.disconnect();
              resolve(false);
            }
          }, 3000);
        });

        if (!ready || superseded()) return;
      }

      // Skip if already initialized (another path may have created it)
      const existing = terminalsRef.current.get(agentId);
      if (existing && !existing.disposed) return;

      const term = new modules.Terminal({
        theme: getTerminalTheme(theme),
        fontSize,
        fontFamily: TERMINAL_CONFIG.fontFamily,
        cursorBlink: TERMINAL_CONFIG.cursorBlink,
        cursorStyle: TERMINAL_CONFIG.cursorStyle,
        scrollback: TERMINAL_CONFIG.scrollback,
        convertEol: TERMINAL_CONFIG.convertEol,
        allowProposedApi: true,
      });

      // Must come before the first write: the replay below carries the mouse
      // tracking sequences Claude Code emits, and honouring them is what left
      // every panel unscrollable and unselectable. See suppressMouseTracking.
      suppressMouseTracking(term);

      const fitAddon = new modules.FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);

      const entry: TerminalEntry = {
        terminal: term,
        fitAddon,
        container,
        resizeObserver: null!,
        disposed: false,
        lastCols: 0,
        lastRows: 0,
        replayPending: [],
        onReplayChunk: null,
        settling: true,
      };

      terminalsRef.current.set(agentId, entry);

      // Step 1: Replay the stored transcript from the Electron main process,
      // at the width it was recorded at. Fetched directly over IPC so this
      // does not depend on React state (the agents array).
      //
      // The panel is NOT fitted first, and the order here is the whole point.
      // What is stored is not a log: Claude Code, like every Ink program,
      // repaints by erasing exactly as many physical rows as its last frame
      // took (`ESC[<n>A ESC[0J`), and it counted those rows against the width
      // the PTY had at the time. Replaying those bytes into a panel narrower
      // than that width makes every line that now wraps take an extra row, so
      // each erase falls one row short and every frame leaves a copy of itself
      // behind. A transcript of a few hundred frames painted the transcript a
      // few hundred times, which is the unreadable panel that was reported.
      //
      // So: size the terminal to the geometry the bytes were written at, write
      // them, and only then fit. The fit reflows what is on screen and the
      // SIGWINCH that goes with it makes the CLI repaint at the new width.
      let hasLivePty = false;
      if (isElectron() && window.electronAPI?.agent?.get) {
        try {
          const agent = await window.electronAPI.agent.get(agentId);

          const hasPty = agent?.ptyId;
          hasLivePty = !!hasPty;
          const isInactive = agent?.status === 'idle' || agent?.status === 'completed' || agent?.status === 'error';

          // The PTY is spawned at 120x30, and says so; the fallback is that
          // same pair for an agent stored before the geometry was recorded.
          term.resize(agent?.ptyCols ?? 120, agent?.ptyRows ?? 30);

          if (isInactive && !hasPty) {
            // Truly stopped agents (no PTY): show status placeholder.
            // Don't replay output only to clear it. Just show the status.
            await writeAndFlush(term, `\x1b[90m(Session ${agent.status})\x1b[0m\r\n`);
          } else if (agent?.output?.length) {
            // Active agents or agents with PTY still alive: replay output
            await writeAndFlush(term, agent.output.join(''));
            term.scrollToBottom();
          }
        } catch {}
      }

      // Step 2: whatever the agent emitted while its transcript was being
      // fetched and replayed, in the order it arrived, and the panel is now
      // taking writes directly.
      const buffered = entry.replayPending ?? [];
      entry.replayPending = null;
      if (buffered.length) {
        await writeAndFlush(term, buffered.join(''));
        term.scrollToBottom();
      }

      // Step 3: hand the panel's geometry to the PTY and let the CLI answer
      // before xterm changes width. See handOverGeometry: doing it the other
      // way round is what leaves a stale fragment above every repaint.
      if (hasLivePty) await handOverGeometry(agentId, entry, term);

      // Step 4: xterm follows, and the panel starts taking fits from everyone
      // else again.
      entry.settling = false;
      safeFit(agentId, entry);

      // Step 5: Fit again after content is written (may affect scrollbar)
      setTimeout(() => safeFit(agentId, entry), 50);
      setTimeout(() => safeFit(agentId, entry), 200);

      // Helper: send input to one agent or broadcast to all
      const sendOrBroadcast = (input: string) => {
        if (!isElectron()) return;
        if (broadcastModeRef.current) {
          // Broadcast to all terminals
          const promises = Array.from(terminalsRef.current.keys()).map(id =>
            window.electronAPI!.agent.sendInput({ id, input })
          );
          Promise.allSettled(promises).catch(() => {});
        } else {
          window.electronAPI!.agent.sendInput({ id: agentId, input }).catch(() => {});
        }
      };

      attachShiftEnterHandler(term, (data) => {
        sendOrBroadcast(data);
      });

      // Forward keyboard input from xterm to PTY
      // Filter out terminal query responses (DA, CPR, focus) that xterm.js emits
      // automatically: these must not be forwarded as user input.
      term.onData((data) => {
        if (/^(\x1b\[\?[\d;]*c|\d+;\d+c)+$/.test(data)) return;
        const cleaned = data
          .replace(/\x1b\[\?[\d;]*c/g, '')     // DA response: \x1b[?1;2c
          .replace(/\x1b\[\d+;\d+R/g, '')       // CPR response: \x1b[row;colR
          .replace(/\x1b\[(?:I|O)/g, '')         // Focus in/out: \x1b[I / \x1b[O
          .replace(/\d+;\d+c/g, '');             // Bare DA fragments: 1;2c
        if (!cleaned) return;
        sendOrBroadcast(cleaned);
      });

      // ResizeObserver: auto-fit when container dimensions change
      const resizeObserver = new ResizeObserver(() => {
        if (!entry.disposed) {
          debouncedFit(agentId);
        }
      });
      resizeObserver.observe(container);
      entry.resizeObserver = resizeObserver;

      // Notify caller that this terminal is ready to receive output
      onTerminalReadyRef.current?.(agentId);

    } finally {
      if (initializingRef.current.get(agentId) === container) {
        initializingRef.current.delete(agentId);
      }
    }
  }, [loadModules, fontSize, debouncedFit, theme]);

  // Unregister and dispose a terminal
  const unregisterContainer = useCallback((agentId: string) => {
    // Also drop any in-flight init so it bails instead of publishing a
    // terminal attached to a container that is already detached.
    initializingRef.current.delete(agentId);
    const entry = terminalsRef.current.get(agentId);
    if (entry) {
      entry.resizeObserver?.disconnect();
      if (!entry.disposed) {
        entry.terminal.dispose();
        entry.disposed = true;
      }
    }
    terminalsRef.current.delete(agentId);
    const timer = fitTimersRef.current.get(agentId);
    if (timer) {
      clearTimeout(timer);
      fitTimersRef.current.delete(agentId);
    }
  }, []);

  // Register a container element for an agent's terminal
  const registerContainer = useCallback((agentId: string, container: HTMLDivElement | null) => {
    // A null container means the panel unmounted (fullscreen toggle, project
    // tab switch, agent removed). Previously this was a silent no-op, so the
    // xterm stayed in terminalsRef with disposed:false: it kept parsing every
    // PTY chunk into a 10k-line scrollback off-screen and kept receiving
    // broadcast-mode keystrokes aimed at the visible set.
    if (!container) {
      unregisterContainer(agentId);
      return;
    }

    const existing = terminalsRef.current.get(agentId);
    if (existing?.container === container && !existing.disposed) {
      return;
    }

    // Dispose old terminal if switching containers
    if (existing && !existing.disposed) {
      existing.resizeObserver?.disconnect();
      existing.terminal.dispose();
      existing.disposed = true;
    }

    initTerminal(agentId, container);
  }, [initTerminal, unregisterContainer]);

  // Write to a specific terminal
  const writeToTerminal = useCallback((agentId: string, data: string) => {
    const entry = terminalsRef.current.get(agentId);
    if (!entry || entry.disposed) return;
    // The panel is registered here before its stored transcript has been
    // fetched and replayed, because the fetch is a round trip and a panel that
    // is not registered drops what arrives during it. Live bytes must not
    // overtake the transcript though: a CLI erases its previous frame by row
    // count, so a frame written before the frame it means to erase is on
    // screen erases the wrong rows. Hold them until the replay is in.
    if (entry.replayPending) {
      entry.replayPending.push(data);
      entry.onReplayChunk?.();
      return;
    }
    entry.terminal.write(data);
  }, []);

  // Send input to agent PTY
  const sendInput = useCallback(async (agentId: string, input: string) => {
    if (!isElectron()) return;
    await window.electronAPI!.agent.sendInput({ id: agentId, input });
  }, []);

  // Broadcast input to all terminals
  const broadcastInput = useCallback(async (input: string) => {
    if (!isElectron()) return;
    const promises = Array.from(terminalsRef.current.keys()).map(agentId =>
      window.electronAPI!.agent.sendInput({ id: agentId, input })
    );
    await Promise.allSettled(promises);
  }, []);

  // Clear a specific terminal
  const clearTerminal = useCallback((agentId: string) => {
    const entry = terminalsRef.current.get(agentId);
    if (entry && !entry.disposed) {
      entry.terminal.clear();
    }
  }, []);

  // Focus a specific terminal
  const focusTerminal = useCallback((agentId: string) => {
    const entry = terminalsRef.current.get(agentId);
    if (entry && !entry.disposed) {
      entry.terminal.focus();
    }
  }, []);

  // Fit a specific terminal
  const fitTerminal = useCallback((agentId: string) => {
    const entry = terminalsRef.current.get(agentId);
    if (entry && !entry.disposed) {
      safeFit(agentId, entry);
    }
  }, []);

  // Fit all terminals
  const fitAll = useCallback(() => {
    terminalsRef.current.forEach((entry, agentId) => {
      if (!entry.disposed) {
        safeFit(agentId, entry);
      }
    });
  }, []);

  // Zoom: update font size on all terminals, refit, sync PTY dimensions
  const applyFontSize = useCallback((newSize: number) => {
    terminalsRef.current.forEach((entry, agentId) => {
      if (!entry.disposed) {
        entry.terminal.options.fontSize = newSize;
        // Delayed fit to let xterm recalculate character metrics
        setTimeout(() => {
          if (!entry.disposed) safeFit(agentId, entry);
        }, 10);
      }
    });
  }, []);

  // Sync fontSize state when the persisted initialFontSize prop changes
  // (e.g. settings loaded async, or changed from Settings page)
  useEffect(() => {
    if (initialFontSize !== undefined && initialFontSize !== prevInitialFontSizeRef.current) {
      prevInitialFontSizeRef.current = initialFontSize;
      setFontSize(initialFontSize);
      applyFontSize(initialFontSize);
    }
  }, [initialFontSize, applyFontSize]);

  const zoomIn = useCallback(() => {
    setFontSize(prev => {
      const next = Math.min(prev + 1, MAX_FONT_SIZE);
      applyFontSize(next);
      onFontSizeChange?.(next);
      return next;
    });
  }, [applyFontSize, onFontSizeChange]);

  const zoomOut = useCallback(() => {
    setFontSize(prev => {
      const next = Math.max(prev - 1, MIN_FONT_SIZE);
      applyFontSize(next);
      onFontSizeChange?.(next);
      return next;
    });
  }, [applyFontSize, onFontSizeChange]);

  const zoomReset = useCallback(() => {
    setFontSize(DEFAULT_FONT_SIZE);
    applyFontSize(DEFAULT_FONT_SIZE);
    onFontSizeChange?.(DEFAULT_FONT_SIZE);
  }, [applyFontSize, onFontSizeChange]);

  // Update theme on all live terminals when it changes
  useEffect(() => {
    const themeObj = getTerminalTheme(theme);
    terminalsRef.current.forEach((entry) => {
      if (!entry.disposed) {
        entry.terminal.options.theme = themeObj;
      }
    });
  }, [theme]);

  // Single global onOutput listener that dispatches to correct terminal
  useEffect(() => {
    if (!isElectron()) return;

    const unsubOutput = window.electronAPI!.agent.onOutput((event) => {
      writeToTerminal(event.agentId, event.data);
    });

    const unsubError = window.electronAPI!.agent.onError((event) => {
      writeToTerminal(event.agentId, `\x1b[31m${event.data}\x1b[0m`);
    });

    return () => {
      unsubOutput();
      unsubError();
    };
  }, [writeToTerminal]);

  // Cleanup all terminals on unmount
  useEffect(() => {
    return () => {
      terminalsRef.current.forEach((entry) => {
        entry.resizeObserver?.disconnect();
        if (!entry.disposed) {
          entry.terminal.dispose();
          entry.disposed = true;
        }
      });
      terminalsRef.current.clear();
      // Any init still awaiting layout must not resurrect an entry after this.
      initializingRef.current.clear();
      fitTimersRef.current.forEach(t => clearTimeout(t));
      fitTimersRef.current.clear();
    };
  }, []);

  return {
    registerContainer,
    unregisterContainer,
    sendInput,
    broadcastInput,
    clearTerminal,
    focusTerminal,
    fitTerminal,
    fitAll,
    writeToTerminal,
    zoomIn,
    zoomOut,
    zoomReset,
    fontSize,
  };
}
