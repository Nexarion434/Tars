/**
 * The name of the machine an agent runs on, after the agent's name or a
 * project's: a small mono word in a 1px box. Not a control, so it sits below
 * the 26px scale. Frames: `Dashboard · two machines`, `Agents · two machines`.
 */
export function MachineBadge({ name, className = '' }: { name: string; className?: string }) {
  return (
    <span
      data-machine-badge={name}
      title={`Runs on ${name}`}
      className={`inline-flex items-center h-[18px] px-1.5 shrink-0 border border-border font-mono text-[10px] leading-none text-text-secondary ${className}`}
    >
      {name}
    </span>
  );
}
