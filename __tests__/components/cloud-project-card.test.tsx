import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CloudProjectCard } from '../../src/components/CloudProjectCard';
import type { CloudProjectRow } from '../../src/lib/cloud';

/**
 * A server's project on the Projects page (M3, frame `Projects · with cloud`).
 * Written before the component.
 *
 * How it fails:
 * 1. the card without its server's badge, its agents ("1 agent", "2
 *    agents" as the frame writes them) or its path as ~
 * 2. an action this computer cannot take on a server's folder: open (its
 *    sessions are not here), remove (it would read as deleting it there);
 *    hide is the only one, unhide once hidden
 * 3. a hidden card drawn like a shown one
 */

const row = (over: Partial<CloudProjectRow> = {}): CloudProjectRow => ({
  key: 'cloud:d795d0ff4d5d8e50:/home/tars/projects/my-app', name: 'my-app', path: '/home/tars/projects/my-app', shownPath: '~/projects/my-app',
  server: { id: 's_1a2b3c4d', name: 'my-server' }, agents: 2, ...over,
});
const html = (over: Partial<CloudProjectRow> = {}, hidden = false) => renderToStaticMarkup(<CloudProjectCard row={row(over)} hidden={hidden} onToggleHidden={() => {}} />);

describe('a server\'s project card', () => {
  it('1. its name, its server\'s badge, its agents and its path as ~', () => {
    const out = html();
    expect(out).toContain('my-app');
    expect(out).toContain('data-cloud-badge="my-server"');
    expect(out).toContain('2 agents');
    expect(out).toContain('~/projects/my-app');
    expect(out).toContain('title="/home/tars/projects/my-app"');
    expect(html({ agents: 1 })).toContain('1 agent<');
  });

  it('2. hide is its only action, unhide once hidden', () => {
    const out = html();
    expect(out).toContain('>hide<');
    expect(out).not.toContain('>open<');
    expect(out).not.toContain('>remove<');
    expect(html({}, true)).toContain('>unhide<');
  });

  it('3. a hidden card is drawn faded', () => {
    expect(html({}, true)).toContain('opacity-50');
    expect(html()).not.toContain('opacity-50');
  });
});
