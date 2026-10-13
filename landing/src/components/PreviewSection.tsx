/**
 * The new interface as the preview of 2.0.0: `Landing · desktop`, its Preview
 * section (design/landing.pen). Projects and chats, off until Settings,
 * Preferences, New interface turns it on, as the app has it. No `@/` import
 * and no package of the landing's own: __tests__/landing/preview.test.tsx
 * renders it with the root's, and reads its words against the frame's.
 */
const POINTS = [
  {
    title: 'Every chat, in one list',
    body: 'The sidebar lists your projects’ chats, pinned, active, working, snoozed or settled, each with its state, filters them by project, and says how many work of the most your Mac runs at once. Main is the conversation your orchestrator already had.',
  },
  {
    title: 'A chat’s conversation, live',
    body: 'Write to its orchestrator there, and read the conversation from its own transcripts as it happens: what it says, the tools it calls, the work it hands to its team, and what it asks you. A new chat’s first message starts its own orchestrator.',
  },
  {
    title: 'A page for each project',
    body: 'Its chats, its team and what each agent is on, its terminals and its room, on one page. Agents, Usage, Settings and the other pages open from More, as cards above the app.',
  },
  {
    title: 'Off until you turn it on',
    body: 'Settings, Preferences, New interface. Today’s interface stays exactly as it is until then, and comes back the moment you turn it off.',
  },
];

export function PreviewSection() {
  return (
    <section id="preview" className="max-w-[1040px] mx-auto px-6 py-16 border-b border-line">
      <p className="font-mono text-xs text-accent mb-3.5">Preview in 2.0.0</p>
      <h2 className="font-display text-3xl mb-3.5">Projects and chats</h2>
      <p className="text-ink-soft text-[15px] leading-relaxed max-w-[600px] mb-10">
        A project keeps its team, and you open several chats in it, each its own conversation with the
        project{'’'}s orchestrator on one topic. It comes in 2.0.0 as a preview, off until you turn it on.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-9">
        {POINTS.map(p => (
          <div key={p.title}>
            <h3 className="text-base font-medium mb-2">{p.title}</h3>
            <p className="text-ink-soft text-[14px] leading-relaxed">{p.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
