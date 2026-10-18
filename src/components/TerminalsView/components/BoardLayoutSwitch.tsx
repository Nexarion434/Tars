'use client';

import { LayoutGrid, LayoutPanelLeft } from 'lucide-react';
import { SegmentedControl } from '@/components/ui';
import type { BoardLayout } from '@/lib/orchestrator-board';

/**
 * The Dashboard header's switch between the orchestrator layout and the equal grid (`Dashboard · orchestrator layout`
 * frames): the app's segmented control, the layout shown a box. Only on a board the orchestrator layout is for.
 */
export default function BoardLayoutSwitch({ value, onChange }: { value: BoardLayout; onChange: (layout: BoardLayout) => void }) {
  return (
    <SegmentedControl
      ariaLabel="Board layout"
      value={value}
      onChange={onChange}
      options={[
        {
          value: 'orchestrator',
          label: <span className="inline-flex items-center gap-1.5"><LayoutPanelLeft className="w-3 h-3" aria-hidden />Orchestrator</span>,
          title: 'The orchestrator on two thirds of the board, every other agent in a column beside it',
        },
        {
          value: 'grid',
          label: <span className="inline-flex items-center gap-1.5"><LayoutGrid className="w-3 h-3" aria-hidden />Equal grid</span>,
          title: 'Every agent in a card of the same size',
        },
      ]}
    />
  );
}
