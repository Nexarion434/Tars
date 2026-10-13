import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewSection } from '../../landing/src/components/PreviewSection';
import { DEFAULT_APP_SETTINGS, SECTIONS } from '../../src/components/Settings/constants';

/**
 * The landing's section on the preview of 2.0.0 (landing/src/components/
 * PreviewSection.tsx), as `Landing · desktop` draws it in design/landing.pen,
 * its Preview section: projects and chats, off until Settings turns it on.
 * Written before the code, as the ways it can fail:
 * 1. a word of the frame's section is dropped, changed or moved on its way to
 *    the page;
 * 2. it says the new interface is on, or not that it is off until turned on,
 *    while the app's default is off (src/components/Settings/constants.ts);
 * 3. it names a switch the app does not have, or puts it somewhere else: the
 *    row's label in GeneralSection.tsx, in the section Settings lists as
 *    Preferences;
 * 4. the home page does not show it, shows it twice, or elsewhere than
 *    between What it does and How it works, where the frame has it.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
/** What a reader sees: tags part words, entities read as their characters. */
const textOf = (markup: string) => markup
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

type Node = { type?: string; name?: string; content?: string; children?: Node[] };
/** The texts of the frame's Preview section, in the order the page reads them. */
function frameTexts(): string[] {
  const doc = JSON.parse(read('design/landing.pen')) as { children: Node[] };
  const page = doc.children.find(c => c.name === 'Landing · desktop');
  const section = page?.children?.find(c => c.name === 'Preview');
  if (!section) throw new Error('Landing · desktop has no Preview section');
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.type === 'text' && n.content) out.push(n.content);
    (n.children ?? []).forEach(walk);
  };
  walk(section);
  return out;
}

const shown = textOf(renderToStaticMarkup(<PreviewSection />));

describe('the landing\'s preview of 2.0.0', () => {
  it('shows every word of the frame\'s section, in order (1)', () => {
    const words = frameTexts();
    expect(words.length).toBeGreaterThan(10);
    expect(shown).toBe(words.join(' ').replace(/\s+/g, ' ').trim());
  });

  it('says it is off until turned on, as the app\'s default is (2)', () => {
    expect(DEFAULT_APP_SETTINGS.newInterface).toBe(false);
    expect(shown).toContain('off until you turn it on');
    expect(shown).not.toMatch(/\bon by default\b/i);
  });

  it('names the switch the app has, where the app has it (3)', () => {
    const general = read('src/components/Settings/GeneralSection.tsx');
    const at = general.indexOf('newInterface: ');
    const labels = [...general.slice(0, at).matchAll(/label="([^"]+)"/g)];
    const label = labels[labels.length - 1]?.[1];
    expect(label).toBe('New interface');
    // The page GeneralSection draws, as Settings lists it: Preferences, under General.
    const page = SECTIONS.find(s => s.id === 'general')?.label;
    expect(page).toBe('Preferences');
    expect(shown).toContain(`Settings, ${page}, ${label}.`);
  });

  it('sits once on the home page, between What it does and How it works (4)', () => {
    const home = read('landing/src/app/page.tsx');
    const features = home.indexOf('id="features"');
    const preview = home.indexOf('<PreviewSection');
    const how = home.indexOf('id="how"');
    expect(home.split('<PreviewSection').length - 1).toBe(1);
    expect(features).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(features);
    expect(how).toBeGreaterThan(preview);
  });
});
