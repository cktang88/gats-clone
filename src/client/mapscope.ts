/**
 * Caches of one map's art (sprites of its buildings, ships, roofs, trees and water) let go when the room moves to another map.
 * Each is keyed by that map's geometry, so none of it is drawn again until the map comes round again (a dozen maps later), yet
 * kept, the canvases of every map played piled up: ~10 MPx a map, over 130 MPx (half a gigabyte of pixels) by the twelfth.
 */
const releases: (() => void)[] = [];
let current: string | undefined;

/** `release` runs whenever the map changes (not on the first map). */
export function onMapChange(release: () => void): void {
  releases.push(release);
}

/** The map now drawn: a different one from last time lets every registered cache go. */
export function enterMap(map: string | undefined): void {
  if (map === current) return;
  const had = current !== undefined;
  current = map;
  if (had) for (const release of releases) release();
}
