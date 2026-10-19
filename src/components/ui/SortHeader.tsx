'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';

export type SortDirection = 'descending' | 'ascending';

/**
 * The name of a table's column that sorts by it (`Usage · cost per agent`, its
 * col header states): the header's 10px capitals on a 26px button. Sorted, it
 * is a box, the selected cell's `surface-raised` and `border-strong`, with an
 * arrow down when the highest come first and up when the lowest do: before
 * the name over a column of figures, after it over a column of words, so the
 * name stays where it was. Not sorted, no box, and the name lifts on hover.
 * The button overhangs its column by its own padding, so the name lines up
 * with the values under it. Enter and Space press it as they press any
 * button; the `th` around it carries aria-sort.
 */
export function SortHeader({ label, direction, align = 'left', onClick, title }: {
  label: string;
  /** The way the column is sorted, or null when it is not. */
  direction: SortDirection | null;
  /** The side of the column its values keep to. */
  align?: 'left' | 'right';
  onClick: () => void;
  /** What a click does next. */
  title?: string;
}) {
  const Arrow = direction === 'ascending' ? ArrowUp : ArrowDown;
  const arrow = direction ? <Arrow aria-hidden className="w-3 h-3 shrink-0" /> : null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-sort={direction ?? undefined}
      className={`inline-flex h-[26px] items-center gap-1 -mx-1.5 px-1.5 border font-normal text-[10px] uppercase tracking-[0.08em] whitespace-nowrap transition-colors cursor-pointer ${
        direction
          ? 'border-border-accent bg-secondary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary'
      }`}
    >
      {align === 'right' && arrow}
      {label}
      {align === 'left' && arrow}
    </button>
  );
}
