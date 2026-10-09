'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import type { Terminal } from 'xterm';
import type { FitAddon } from 'xterm-addon-fit';
import { fleetMatchesSent, isRemoteId, remoteSize, scaleToFit, sharesSize, shouldSendSize, type PaneAgent } from '@/lib/machines';
import { reportDriveAnswer } from '@/hooks/useRemoteDrive';
import { isElectron } from '@/hooks/useElectron';
import { onAgentMoveLine } from '@/hooks/useClaudeAccounts';
import { TERMINAL_CONFIG } from '../constants';
import { getTerminalTheme } from '@/components/AgentWorld/constants';
import { attachShiftEnterHandler, disposeTerminalSafely, keySender, passWheelToProgram, stripTerminalReplies, suppressMouseTracking } from '@/lib/terminal';

interface TerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  resizeObserver: ResizeObserver;
  disposed: boolean;
  lastCols: number;
  lastRows: number;
  /** Sends typed keys to the agent's terminal, and says so in the panel when there is none. */
  typeKeys: (input: string) => void;
  /** Gives back the watch on a remote agent's live output (machines.unwatch), once. */
  release?: () => void;
  /** A remote pane that takes the size of this pane, where its machine lets this one drive. */
  shared?: boolean;
  /** One of this machine's agents whose terminal a paired machine resized: the pane takes the size back at its next focus or key. */
  taken?: boolean;
  /** A shared remote pane whose terminal the other machine resized since: the same. */
  stale?: boolean;
}

interface UseMultiTerminalOptions {
  agents: PaneAgent[];
  initialFontSize?: number;
  onFontSizeChange?: (size: number) => void;
  theme?: 'dark' | 'light';
  onTerminalReady?: (agentId: string) => void;
  broadcastMode?: boolean;
}

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 11;

// A remote pane that does not share its size is drawn at the size of the
// terminal it shows, which a full-screen CLI places every line by, and scaled
// down to fit its body. It is not fitted, and does not size the terminal.
function scaleRemote(entry: TerminalEntry) {
  if (entry.disposed) return;
  const el = entry.terminal.element;
  const screen = el?.querySelector<HTMLElement>('.xterm-screen');
  if (!el || !screen) return;
  const scale = scaleToFit(
    { width: entry.container.clientWidth, height: entry.container.clientHeight },
    { width: screen.offsetWidth, height: screen.offsetHeight },
  );
  el.style.transformOrigin = 'top left';
  el.style.transform = scale < 1 ? `scale(${scale})` : '';
}

function sizeRemote(entry: TerminalEntry, size: { cols: number; rows: number }) {
  if (entry.disposed) return;
  if (entry.terminal.cols !== size.cols || entry.terminal.rows !== size.rows) entry.terminal.resize(size.cols, size.rows);
  entry.lastCols = size.cols;
  entry.lastRows = size.rows;
  scaleRemote(entry);
  // Once the renderer has measured the new cells.
  setTimeout(() => scaleRemote(entry), 50);
}

// A remote pane that shares its size is fitted like a local one, at its own
// font and unscaled, and sends the size it gets to the machine it shows.
function fitShared(agentId: string, entry: TerminalEntry) {
  try {
    const el = entry.terminal.element;
    if (el) el.style.transform = '';
    entry.fitAddon.fit();
    const { cols, rows } = entry.terminal;
    if (shouldSendSize({ cols: entry.lastCols, rows: entry.lastRows }, { cols, rows })) {
      entry.lastCols = cols;
      entry.lastRows = rows;
      window.electronAPI?.machines?.resizeAgent(agentId, cols, rows).catch(() => {});
    }
  } catch {}
}

// A pane takes its size back: what the other machine left it at is not what
// the pane last sent, so the next fit sends it whatever it was.
function reclaimSize(agentId: string, entry: TerminalEntry) {
  entry.taken = false;
  entry.stale = false;
  entry.lastCols = 0;
  entry.lastRows = 0;
  safeFit(agentId, entry);
}

// Safely fit a terminal and sync PTY dimensions
function safeFit(agentId: string, entry: TerminalEntry) {
  if (entry.disposed) return;
  if (isRemoteId(agentId)) return entry.shared ? fitShared(agentId, entry) : scaleRemote(entry);
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
  // The agents whose claude left fullscreen (agent.leftFullscreen, from the
  // main process's screen mirror). Their panel still holds the alternate
  // screen, so the wheel keeps being turned into reports, and the claude that
  // reads them is gone: 48 of them for six notches reached nothing. None is
  // sent; the panel's notice offers the history view and a restart instead.
  const leftFullscreenRef = useRef<Set<string>>(new Set());
  // The PTY each panel last saw under its agent. A new PTY is born at the last
  // size anybody asked for, which the Agents window or the tray may have asked
  // after this panel did, so a panel that meets a new PTY resends its own size
  // rather than waiting for its next resize.
  const ptyOfRef = useRef<Map<string, string>>(new Map());
  // The size each remote agent's terminal is drawn for, as the fleet last said.
  const remoteSizeRef = useRef<Map<string, { cols?: number; rows?: number }>>(new Map());
  // Whether each remote agent's machine is connected and lets this one type
  // into it. Read when a key is typed, so a machine changing its mind, or going
  // away, takes effect on the next key.
  const remoteTypeRef = useRef<Map<string, boolean>>(new Map());
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
      // The panel under the pointer only, even in broadcast mode.
      passWheelToProgram(term, input => {
        if (leftFullscreenRef.current.has(agentId) || isRemoteId(agentId)) return;
        if (isElectron()) window.electronAPI!.agent.sendInput({ id: agentId, input }).catch(() => {});
      });

      // Another machine's agent takes keys only where its machine lets this
      // one drive; otherwise nothing typed in its pane is sent.
      const remote = isRemoteId(agentId);
      if (remote) term.options.disableStdin = !remoteTypeRef.current.get(agentId);
      const shared = remote && !!remoteTypeRef.current.get(agentId);

      const entry: TerminalEntry = {
        terminal: term,
        fitAddon,
        container,
        resizeObserver: null!,
        disposed: false,
        lastCols: 0,
        lastRows: 0,
        shared,
        // An idle agent has no terminal since #164: keys typed into its panel
        // are said to go nowhere instead of being dropped. See keySender.
        // Each chunk goes at once, in order, without waiting for the one
        // before: the main process queues them per agent. The answer is only
        // read for the sentence a refusal says (reportDriveAnswer).
        typeKeys: remote ? input => {
          if (!remoteTypeRef.current.get(agentId)) return;
          window.electronAPI?.machines?.typeKeys(agentId, input).then(
            answer => reportDriveAnswer(agentId, answer),
            err => reportDriveAnswer(agentId, undefined, err),
          );
        } : keySender(term, input => (isElectron()
          ? window.electronAPI!.agent.sendInput({ id: agentId, input })
          : Promise.resolve(undefined))),
      };

      terminalsRef.current.set(agentId, entry);

      // Step 1: Initial fit, determines correct cols/rows for this panel size
      safeFit(agentId, entry);

      // Step 2: Replay historical output from Electron main process.
      // Fetch directly via IPC to avoid depending on React state (agents array).
      if (remote) {
        // A remote agent: its live output arrives on agent:output once watched
        // (given back by release), and its screen as it is now is read once.
        const machines = window.electronAPI?.machines;
        if (!entry.shared) sizeRemote(entry, remoteSize(null, remoteSizeRef.current.get(agentId)));
        machines?.watch(agentId).catch(() => {});
        entry.release = () => {
          entry.release = undefined;
          machines?.unwatch(agentId).catch(() => {});
        };
        try {
          const shot = await machines?.agentScreen(agentId);
          if (shot?.screen && !entry.disposed) {
            // Its size first: the screen is placed cell by cell for it.
            if (!entry.shared) sizeRemote(entry, remoteSize(shot, remoteSizeRef.current.get(agentId)));
            term.write(shot.screen);
            term.scrollToBottom();
          }
        } catch {}
      } else if (isElectron() && window.electronAPI?.agent?.get) {
        try {
          const agent = await window.electronAPI.agent.get(agentId);

          const hasPty = agent?.ptyId;
          const isInactive = agent?.status === 'idle' || agent?.status === 'completed' || agent?.status === 'error' || agent?.status === 'stopped';

          if (isInactive && !hasPty) {
            // Truly stopped agents (no PTY): show status placeholder.
            // Don't replay output only to clear it. Just show the status.
            term.write(`\x1b[90m(Session ${agent.status})\x1b[0m\r\n`);
          } else if (agent?.output?.length) {
            // Active agents or agents with PTY still alive: replay output
            term.write(agent.output.join(''));
            term.scrollToBottom();
          }
        } catch {}
      }

      // Step 4: Fit again after content is written (may affect scrollbar)
      setTimeout(() => safeFit(agentId, entry), 50);
      setTimeout(() => safeFit(agentId, entry), 200);

      // Helper: send input to one agent or broadcast to all
      const sendOrBroadcast = (input: string) => {
        if (!isElectron()) return;
        if (broadcastModeRef.current && !remote) {
          // Broadcast to all of this machine's terminals, each panel saying so
          // if its agent has none. Another machine's agent is never in it, nor
          // does a key typed in its pane reach the others.
          for (const [otherId, other] of terminalsRef.current) {
            if (!other.disposed && !isRemoteId(otherId)) other.typeKeys(input);
          }
        } else {
          entry.typeKeys(input);
        }
      };

      attachShiftEnterHandler(term, (data) => {
        sendOrBroadcast(data);
      });

      // Forward keyboard input from xterm to PTY. The terminal's own replies to
      // queries from the CLI (DA, CPR, DSR, focus, mouse) arrive here too and
      // must never be forwarded as user input. See stripTerminalReplies.
      term.onData((data) => {
        const cleaned = stripTerminalReplies(data);
        if (!cleaned) return;
        // A pane whose terminal another machine resized takes it back first.
        if (entry.taken || entry.stale) reclaimSize(agentId, entry);
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
      entry.release?.();
      if (!entry.disposed) {
        disposeTerminalSafely(entry.terminal);
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
      existing.release?.();
      disposeTerminalSafely(existing.terminal);
      existing.disposed = true;
    }

    initTerminal(agentId, container);
  }, [initTerminal, unregisterContainer]);

  // A panel that meets a new PTY under its agent resends its size. The first
  // PTY a panel sees needs nothing: its own fit already asked for its size.
  const notePty = useCallback((agentId: string, ptyId: string | undefined) => {
    if (!ptyId) return;
    const previous = ptyOfRef.current.get(agentId);
    ptyOfRef.current.set(agentId, ptyId);
    if (previous === undefined || previous === ptyId) return;
    const entry = terminalsRef.current.get(agentId);
    if (!entry || entry.disposed) return;
    entry.lastCols = 0;
    entry.lastRows = 0;
    safeFit(agentId, entry);
  }, []);

  // What the list says: which agents left fullscreen, and each one's PTY. The
  // list learns a new PTY when it is read again (a start or a stop from here
  // reads it); the output events below catch the ones started elsewhere.
  useEffect(() => {
    leftFullscreenRef.current = new Set(agents.filter(a => a.leftFullscreen).map(a => a.id));
    for (const agent of agents) notePty(agent.id, agent.ptyId);
  }, [agents, notePty]);

  // A remote pane whose machine is back, or whose terminal changed size, reads
  // its screen again and starts from it: what the machine did while it was gone
  // never reached this pane, and a screen drawn for another size is wrong at
  // this one. Its live output resumes by itself, the watch kept the whole time.
  const resyncRemote = useCallback(async (agentId: string) => {
    const entry = terminalsRef.current.get(agentId);
    if (!entry || entry.disposed) return;
    try {
      const shot = await window.electronAPI?.machines?.agentScreen(agentId);
      if (!shot?.screen || entry.disposed) return;
      // A pane that shares its size keeps its own, and takes it again below.
      if (!entry.shared || entry.stale) sizeRemote(entry, remoteSize(shot, remoteSizeRef.current.get(agentId)));
      entry.terminal.reset();
      entry.terminal.write(shot.screen);
      entry.terminal.scrollToBottom();
    } catch {}
  }, []);
  const remoteStatusRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const agent of agents) {
      if (!agent.remote) continue;
      const canType = sharesSize(agent.remote);
      remoteTypeRef.current.set(agent.id, canType);
      const entry = terminalsRef.current.get(agent.id);
      if (entry && !entry.disposed) {
        entry.terminal.options.disableStdin = !canType;
        // Drive given or taken away: the pane is fitted and sends its size, or
        // is drawn at the remote size again.
        if (!!entry.shared !== canType) {
          entry.shared = canType;
          if (canType) reclaimSize(agent.id, entry);
          else void resyncRemote(agent.id);
        }
      }
      const was = remoteStatusRef.current.get(agent.id);
      remoteStatusRef.current.set(agent.id, agent.remote.status);
      const size = { cols: agent.remote.cols, rows: agent.remote.rows };
      const before = remoteSizeRef.current.get(agent.id);
      remoteSizeRef.current.set(agent.id, size);
      const resized = !!before && (before.cols !== size.cols || before.rows !== size.rows);
      const back = !!was && was !== 'connected' && agent.remote.status === 'connected';
      // A pane that shares its size meets its own size in the fleet's next
      // report: reading the screen again then would only loop. A different one
      // is the other machine taking the size back, drawn as it is until this
      // pane takes it again (its next focus or key).
      const sent = { cols: entry?.lastCols ?? 0, rows: entry?.lastRows ?? 0 };
      const taken = !!entry?.shared && resized && !fleetMatchesSent(sent, size);
      if (taken && entry) entry.stale = true;
      if (back) {
        void resyncRemote(agent.id).then(() => { if (entry?.shared) reclaimSize(agent.id, entry); });
      } else if (resized && (!entry?.shared || taken)) {
        void resyncRemote(agent.id);
      }
    }
  }, [agents, resyncRemote]);

  // The panel's own text, as it shows it: the active screen, and the history
  // above it on the normal one. Null when this agent has no panel.
  const terminalText = useCallback((agentId: string): string | null => {
    const entry = terminalsRef.current.get(agentId);
    if (!entry || entry.disposed) return null;
    const buffer = entry.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }, []);

  // Write to a specific terminal
  const writeToTerminal = useCallback((agentId: string, data: string) => {
    const entry = terminalsRef.current.get(agentId);
    if (entry && !entry.disposed) {
      entry.terminal.write(data);
    }
  }, []);

  // Send input to agent PTY
  const sendInput = useCallback(async (agentId: string, input: string) => {
    if (!isElectron() || isRemoteId(agentId)) return;
    await window.electronAPI!.agent.sendInput({ id: agentId, input });
  }, []);

  // Broadcast input to all terminals
  const broadcastInput = useCallback(async (input: string) => {
    if (!isElectron()) return;
    const promises = Array.from(terminalsRef.current.keys()).filter(agentId => !isRemoteId(agentId)).map(agentId =>
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
      // A shared remote pane sends its size again on focus, and a local one
      // whose terminal another machine resized takes it back.
      if (entry.shared || entry.taken) reclaimSize(agentId, entry);
    }
  }, []);

  // One of this machine's own agents was resized by a paired machine: its pane
  // takes the size back at its next focus, click or key.
  useEffect(() => {
    return window.electronAPI?.machines?.onSizeTaken?.(agentId => {
      const entry = terminalsRef.current.get(agentId);
      if (entry && !entry.disposed && !isRemoteId(agentId)) entry.taken = true;
    });
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
      notePty(event.agentId, event.ptyId);
      writeToTerminal(event.agentId, event.data);
    });

    const unsubError = window.electronAPI!.agent.onError((event) => {
      writeToTerminal(event.agentId, `\x1b[31m${event.data}\x1b[0m`);
    });

    // A move by Tars to another Claude account, said in the agent's panel.
    const unsubMove = onAgentMoveLine(writeToTerminal);

    return () => {
      unsubOutput();
      unsubError();
      unsubMove();
    };
  }, [writeToTerminal, notePty]);

  // Cleanup all terminals on unmount
  useEffect(() => {
    return () => {
      terminalsRef.current.forEach((entry) => {
        entry.resizeObserver?.disconnect();
        entry.release?.();
        if (!entry.disposed) {
          disposeTerminalSafely(entry.terminal);
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
    terminalText,
    zoomIn,
    zoomOut,
    zoomReset,
    fontSize,
  };
}
