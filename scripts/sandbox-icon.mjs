#!/usr/bin/env node
/**
 * Draws build/sandbox-icon.icns, the icon of the test build (`npm run
 * electron:pack`, which scripts/sandbox.sh starts): the plan's point 13 of
 * 19/10, a test copy that never passes for the maintainer's Tars in the Dock,
 * the app switcher or a crash box.
 *
 * Derived from the mark itself, public/icon.svg, so it follows the mark: the
 * grid in grey instead of orange, and a band across its foot that says SANDBOX.
 * Run again whenever the mark changes, and commit what it writes:
 *
 *   node scripts/sandbox-icon.mjs
 *
 * macOS only, like electron:pack: the .icns is put together by iconutil.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARK_ORANGE = 'fill="#FF9E42"';

/** The mark's SVG as the sandbox's: the grid grey, and the band. */
export function sandboxSvg(markSvg) {
  if (!markSvg.includes(MARK_ORANGE)) throw new Error(`public/icon.svg has no ${MARK_ORANGE}: the mark changed, and this script with it`);
  const band = [
    '<defs><clipPath id="sandbox-tile"><rect width="1024" height="1024" rx="230"/></clipPath></defs>',
    '<g clip-path="url(#sandbox-tile)">',
    '<rect x="0" y="716" width="1024" height="176" fill="#FFD23F"/>',
    '<text x="512" y="836" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="120" letter-spacing="8" fill="#121212">SANDBOX</text>',
    '</g>',
  ].join('');
  return markSvg.replace(MARK_ORANGE, 'fill="#6E6E6E"').replace('</svg>', `${band}</svg>`);
}

async function main() {
  if (process.platform !== 'darwin') {
    console.error('sandbox-icon: iconutil is macOS only, as electron:pack is. Nothing was written.');
    process.exit(1);
  }
  const svg = Buffer.from(sandboxSvg(fs.readFileSync(path.join(root, 'public', 'icon.svg'), 'utf8')));
  const iconset = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sandbox-icon-')), 'sandbox.iconset');
  fs.mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const px = size * scale;
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        await sharp(svg, { density: 72 * (px / 1024) * 4 }).resize(px, px).png().toFile(path.join(iconset, name));
      }
    }
    const out = path.join(root, 'build', 'sandbox-icon.icns');
    execFileSync('iconutil', ['-c', 'icns', '-o', out, iconset]);
    console.log(`sandbox-icon: wrote ${path.relative(root, out)}`);
  } finally {
    fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
