import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ABILITY_COOLDOWN_MS } from '../src/shared/defs.ts';
import { buttonFaces } from '../src/client/touchbuttons.ts';
import { hudScaleFor } from '../src/client/hud.ts';
import { domScaleFor } from '../src/client/uiscale.ts';
import type { Snapshot } from '../src/shared/protocol.ts';

const self = (over: Partial<Snapshot['self']>) => ({ ammo: 12, mag: 12, reloading: false, reloadFrac: 0, ability: null, abilityReadyIn: 0, pending: null, ...over }) as Snapshot['self'];

test('the ability button is hidden until an ability is picked, then shows it with its cooldown and seconds left', () => {
  assert.equal(buttonFaces(self({}), 40).ability, null, 'a locked ability takes no room');
  assert.equal(buttonFaces(self({ pending: { level: 4, k: 'perk', tier: 3 } }), undefined).ability, null, 'nor while its pick waits in the dock');
  const full = ABILITY_COOLDOWN_MS.grenade;
  const cooling = buttonFaces(self({ ability: 'grenade', abilityReadyIn: full * 0.75 }), 40).ability!;
  assert.equal(cooling.icon, 'grenade');
  assert.ok(Math.abs(cooling.sweep - 0.25) < 1e-9, 'a quarter of the cooldown has run');
  assert.equal(cooling.label, String(Math.ceil((full * 0.75) / 1000)));
  assert.equal(cooling.ready, false);
  assert.deepEqual(buttonFaces(self({ ability: 'grenade', abilityReadyIn: 0 }), 40).ability, { icon: 'grenade', sweep: 0, label: '', ready: true });
});

test('the reload button fills as the reload runs and flags an empty mag', () => {
  assert.deepEqual(buttonFaces(self({ reloading: true, reloadFrac: 0.4, ammo: 0 }), 40).reload, { sweep: 0.4, empty: false, ammo: '', low: false });
  assert.deepEqual(buttonFaces(self({ ammo: 0 }), 40).reload, { sweep: 0, empty: true, ammo: '0', low: true });
  assert.deepEqual(buttonFaces(self({ ammo: 9 }), 40).reload, { sweep: 0, empty: false, ammo: '9', low: false }, 'a phone reads the mag on the reload button');
  assert.equal(buttonFaces(self({ ammo: 3 }), 40).reload.low, true, 'a quarter of the mag or less is low');
});

test('a touch screen HUD never shrinks below 90%, so its text stays readable on a phone', () => {
  assert.equal(hudScaleFor(844, 390, true), 0.9);
  assert.ok(hudScaleFor(844, 390, false) < 0.75);
});

test('a big screen HUD grows with the short side, so it fills the same share of a 1440p or 4K screen as of a 900px one', () => {
  assert.equal(hudScaleFor(1280, 800, false), 1);
  assert.equal(hudScaleFor(1920, 1080, false), 1.2);
  assert.ok(Math.abs(hudScaleFor(2560, 1440, false) - 1.6) < 1e-9);
  assert.equal(hudScaleFor(3840, 2160, false), 2.4);
  assert.equal(hudScaleFor(7680, 4320, false), 2.4);
  assert.equal(domScaleFor(844, 390), 1);
  assert.equal(domScaleFor(2560, 1440), 1.6);
});
