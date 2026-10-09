import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { test } from 'node:test';

/**
 * The game is Tinwar (tinwar.io). The old name, Skirmish, lives on only in names a player never reads as the brand: saved
 * browser keys (`skirmish.*`, the `skirmish-vehicles` sprite cache) kept so nobody loses their settings, dev globals
 * (`skirmishDev` and friends), dev env switches (`SKIRMISH_*`) and the Skirmisher SMG.
 */
const ALLOWED = [/skirmisher/gi, /\bskirmish\.[a-z]/gi, /\bskirmish[A-Z]\w*/g, /\bSKIRMISH_[A-Z_]+/g, /\bskirmish-vehicles\b/g];
const TEXT = new Set(['.html', '.css', '.webmanifest', '.md', '.txt', '.json', '.ts']);
const BUNDLES = new Set(['game.js', 'profile.js', 'vehicles.js']);

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (TEXT.has(extname(e.name)) && !BUNDLES.has(e.name)) yield p;
  }
}

function strays(path: string): string[] {
  const out: string[] = [];
  readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
    let rest = line.replace(/<[^>]*>/g, ''); // a wordmark split by markup, <em>S</em>KIRMISH, still reads as the name
    for (const re of ALLOWED) rest = rest.replace(re, '');
    if (/skirmish/i.test(rest)) out.push(`${path}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return out;
}

test('no page, style, manifest or client/server string calls the game Skirmish', () => {
  const found = ['public', 'src'].flatMap((d) => [...files(d)].flatMap(strays));
  assert.deepEqual(found, []);
});

test('the pages wear the Tinwar wordmark and the tinwar.io card', () => {
  for (const page of ['public/index.html', 'public/profile.html', 'public/privacy.html']) {
    const html = readFileSync(page, 'utf8');
    assert.match(html, /<h1 class="logo"><em>T<\/em>INWAR<\/h1>/, page);
    assert.match(html, /<title>[^<]*Tinwar<\/title>/, page);
  }
  const index = readFileSync('public/index.html', 'utf8');
  assert.match(index, /<meta property="og:site_name" content="Tinwar">/);
  assert.match(index, /<meta property="og:url" content="https:\/\/tinwar\.io">/);
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.equal(manifest.name, 'Tinwar');
  assert.equal(manifest.short_name, 'Tinwar');
});
