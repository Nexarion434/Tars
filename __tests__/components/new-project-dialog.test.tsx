import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewProjectView, type NewProjectViewProps } from '../../src/components/NewProjectDialog';

/**
 * New project, asked where it lives (M3 Task 8): frames `Overlay · New
 * project · where`, `· from Git`, `· name taken`.
 *
 * How it fails:
 * 1. a server chosen without its name and start fields, or This computer
 *    chosen with them (it goes on to the folder picker)
 * 2. the hint under Name kept while the server's refusal is shown, or the
 *    refusal not shown (`· name taken`); what was typed lost with it
 * 3. Clone from Git without its address field and its line about the
 *    server's own Git access; Empty with them
 * 4. the footer not saying where the project is made
 */

const places = [
  { id: 'local', label: 'This computer', line: 'a folder you pick' },
  { id: 's_1a2b3c4d', label: 'my-server', line: 'connected · user@server' },
];
const props = (over: Partial<NewProjectViewProps> = {}): NewProjectViewProps => ({
  places, place: 's_1a2b3c4d', form: { name: 'my-app', start: 'empty', url: '' }, error: null, busy: false,
  onPlace: () => {}, onForm: () => {}, onCancel: () => {}, onCreate: () => {}, ...over,
});
const html = (over: Partial<NewProjectViewProps> = {}) => renderToStaticMarkup(<NewProjectView {...props(over)} />);

describe('New project, where it lives', () => {
  it('1, 4. a server chosen: its name, how it starts, and where it is made', () => {
    const out = html();
    expect(out).toContain('aria-checked="true" data-new-project-place="s_1a2b3c4d"');
    expect(out).toContain('aria-label="Name"');
    expect(out).toContain('An empty folder on my-server, ready for its first agent.');
    expect(out).toContain('It is created on my-server.');
  });

  it('1, 4. This computer chosen: no name or start, the folder picker next', () => {
    const out = html({ place: 'local' });
    expect(out).not.toContain('aria-label="Name"');
    expect(out).not.toContain('Start with');
    expect(out).toContain('You pick the folder next.');
  });

  it('2. a refusal takes the hint\'s place, and the name stays', () => {
    const out = html({ error: 'my-server already has a project called my-app. Pick another name.' });
    expect(out).toContain('my-server already has a project called my-app. Pick another name.');
    expect(out).not.toContain('A plain folder name, like my-app');
    expect(out).toContain('value="my-app"');
  });

  it('3. Clone from Git: the address and the line about the server\'s own Git access', () => {
    const out = html({ form: { name: 'my-app', start: 'git', url: 'git@github.com:you/my-app.git' } });
    expect(out).toContain('aria-label="Git address"');
    expect(out).toContain('my-server clones it with its own Git access, so a private repository needs that access on the server.');
    expect(html()).not.toContain('aria-label="Git address"');
  });
});
