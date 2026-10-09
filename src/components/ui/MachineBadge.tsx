/**
 * The name of the machine an agent runs on, after the agent's name or a
 * project's: a small mono orange word in a 1px orange box on the orange wash,
 * so another machine's work stands out (Nicolas, 2026-10-09). In light the
 * word keeps the text colour: light orange never carries text this small
 * (DESIGN.md, machine-ink). Not a control, so it sits below the 26px scale.
 * Frames: `Dashboard · two machines`, `Agents · two machines`.
 */
export function MachineBadge({ name, className = '' }: { name: string; className?: string }) {
  return (
    <span
      data-machine-badge={name}
      title={`Runs on ${name}`}
      className={`inline-flex items-center h-[18px] px-1.5 shrink-0 border border-primary bg-accent-dim font-mono text-[10px] leading-none text-machine-ink ${className}`}
    >
      {name}
    </span>
  );
}
