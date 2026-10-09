/// <reference types="node" />
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * An iPhone has no page fullscreen, so the home-screen app is the only way to play without Safari's bars: these are the tags
 * and the manifest that make Add to Home Screen open Tinwar full screen, on its side, under its own icon.
 */
const index = readFileSync('public/index.html', 'utf8');
const meta = (name: string) => index.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1];
const pngSize = (path: string) => { const b = readFileSync(path); assert.equal(b.toString('latin1', 1, 4), 'PNG', path); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('the page fills the screen under the notch and keeps its size', () => {
  const vp = meta('viewport') ?? '';
  for (const part of ['width=device-width', 'initial-scale=1', 'viewport-fit=cover', 'user-scalable=no']) assert.ok(vp.includes(part), `viewport has ${part}`);
});

test('iOS opens the home-screen app without browser chrome, under a translucent status bar, with its own name and icon', () => {
  assert.equal(meta('apple-mobile-web-app-capable'), 'yes');
  assert.equal(meta('mobile-web-app-capable'), 'yes');
  assert.equal(meta('apple-mobile-web-app-status-bar-style'), 'black-translucent');
  assert.equal(meta('apple-mobile-web-app-title'), 'Tinwar');
  const touchIcon = index.match(/<link rel="apple-touch-icon" href="([^"]+)">/)?.[1];
  assert.ok(touchIcon, 'an apple-touch-icon');
  assert.deepEqual(pngSize(`public/${touchIcon}`), [180, 180]);
});

test('the manifest asks for fullscreen on its side, with installable icons', () => {
  assert.match(index, /<link rel="manifest" href="manifest\.webmanifest">/);
  const m = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.equal(m.display, 'fullscreen');
  assert.deepEqual(m.display_override, ['fullscreen', 'standalone'], 'falls back to standalone (what iOS gives), never to a browser tab');
  assert.equal(m.orientation, 'landscape');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.background_color, '#121419');
  const icons = m.icons as { src: string; sizes: string; type: string; purpose: string }[];
  for (const [size, purpose] of [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]) {
    const icon = icons.find((i) => i.sizes === size && i.purpose === purpose && i.type === 'image/png');
    assert.ok(icon, `a ${purpose} ${size} PNG icon`);
    assert.deepEqual(pngSize(`public/${icon.src}`), size.split('x').map(Number));
  }
  for (const i of icons) assert.ok(existsSync(`public/${i.src}`), i.src);
});

test('the server hands out the manifest and the icons with their types', () => {
  const server = readFileSync('src/server/main.ts', 'utf8');
  assert.match(server, /'\.webmanifest': 'application\/manifest\+json'/);
  assert.match(server, /'\.png': 'image\/png'/);
  assert.match(server, /'\.svg': 'image\/svg\+xml'/);
});

test('the menu opens with the full-screen tip, above the modes, until it is dismissed', () => {
  const tip = index.indexOf('id="a2hs"'), deploy = index.indexOf('id="deploy-panel"');
  assert.ok(tip > 0 && tip < deploy, 'the tip sits at the top of the menu card, before the deploy steps');
  const block = index.slice(tip, index.indexOf('</aside>', tip));
  assert.match(block, /hidden/, 'hidden until the page decides it is an iPhone in Safari');
  assert.match(block, /Share/);
  assert.match(block, /Add to Home Screen/);
  assert.match(block, /id="a2hs-close"/);
});
