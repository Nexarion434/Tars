'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Each project's folder in the Vault (2.0.4, #471's channels; frames `Vault · project folders`): the folders, the
 * subfolder open, its files, and what the agents write meanwhile (vault.onProjectFilesChanged), so the list and an
 * open file follow them. A file is named by its folder's key, a subfolder and a name, never a path.
 */

export type VaultSub = 'reports' | 'tools';
export type ProjectFolder = Awaited<ReturnType<NonNullable<NonNullable<Window['electronAPI']>['vault']>['projectFolders']>>['folders'][number];
export type ProjectFileList = Awaited<ReturnType<NonNullable<NonNullable<Window['electronAPI']>['vault']>['projectFiles']>>;
export interface ProjectPlace { key: string; sub: VaultSub }

/** A folder's notes moved into reports in 2.0.4 are said only by the listing that moved them: kept here per key. */
const NOTES_KEY = 'vault-notes-moved';

function readNotes(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTES_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function keepNotes(notes: Record<string, string>) {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  } catch { /* the notice is a convenience: without storage it shows once */ }
}

export function useProjectFolders(enabled: boolean) {
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [place, setPlace] = useState<ProjectPlace | null>(null);
  const [list, setList] = useState<ProjectFileList | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** Bumped each time an agent writes in the open subfolder: the open file reads itself again. */
  const [changes, setChanges] = useState(0);
  const placeRef = useRef<ProjectPlace | null>(null);
  // Before the effects that read it: a list that answers late for a place left is dropped.
  useEffect(() => { placeRef.current = place; }, [place]);

  const loadFolders = useCallback(async () => {
    const vault = window.electronAPI?.vault;
    if (!vault?.projectFolders) return;
    const { folders: found } = await vault.projectFolders();
    setFolders(found);
    const moved = found.filter((f) => f.notesMoved);
    if (moved.length > 0) {
      const next = { ...readNotes() };
      for (const f of moved) next[f.key] = f.notesMoved as string;
      keepNotes(next);
      setNotes(next);
    }
  }, []);

  const loadList = useCallback(async (at: ProjectPlace) => {
    const vault = window.electronAPI?.vault;
    if (!vault?.projectFiles) return;
    const listed = await vault.projectFiles(at);
    if (placeRef.current?.key === at.key && placeRef.current.sub === at.sub) setList(listed);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setNotes(readNotes());
    void loadFolders();
  }, [enabled, loadFolders]);

  useEffect(() => {
    if (!place) return;
    setList(null);
    void loadList(place);
  }, [place, loadList]);

  useEffect(() => {
    const vault = window.electronAPI?.vault;
    if (!enabled || !vault?.onProjectFilesChanged) return;
    return vault.onProjectFilesChanged(({ key, sub }) => {
      void loadFolders();
      const at = placeRef.current;
      if (at && at.key === key && at.sub === sub) {
        void loadList(at);
        setChanges((n) => n + 1);
      }
    });
  }, [enabled, loadFolders, loadList]);

  const refresh = useCallback(async () => {
    await loadFolders();
    if (placeRef.current) await loadList(placeRef.current);
    setChanges((n) => n + 1);
  }, [loadFolders, loadList]);

  return { folders, place, setPlace, list, notes, changes, refresh };
}
