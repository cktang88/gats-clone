/**
 * The menu's attract mode, run in a worker (public/attract.js) so the bot match behind the menu never takes a frame from it: building
 * a map's nav grid and the bots' thinking happen here, and the page only draws. The page asks for ticks up to the time it will draw
 * (`run`), so a slow-motion moment slows the match itself, a hidden tab asks for nothing, and the page's `terminate` frees it all.
 */
import { createAttractSim, peekWorld, type AttractFrame, type AttractOpts, type AttractSim, type AttractWorld } from './attractsim.ts';

/** `peek` asks for the walls of a map about to be booted (the page bakes its ground ahead), without touching the match playing. */
export type ToWorker = { t: 'boot'; opts: AttractOpts } | { t: 'run'; upTo: number } | { t: 'aspect'; aspect: number } | { t: 'peek'; opts: AttractOpts };
export type FromWorker = { t: 'world'; world: AttractWorld; tick: number } | { t: 'peeked'; world: AttractWorld } | { t: 'frames'; frames: AttractFrame[] } | { t: 'error'; message: string };

const scope = self as unknown as { onmessage: ((e: MessageEvent<ToWorker>) => void) | null; postMessage: (m: FromWorker) => void };
let sim: AttractSim | null = null;

scope.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.t === 'boot') {
      sim = null;
      sim = createAttractSim(m.opts);
      scope.postMessage({ t: 'world', world: sim.world(), tick: sim.tick });
    } else if (m.t === 'run' && sim) {
      const frames: AttractFrame[] = [];
      // A frame at most a second ahead per ask, whatever is asked: a tab that was away does not come back to a burst of work.
      for (let n = 0; sim.tick < m.upTo && n < 30; n++) frames.push(sim.step());
      if (frames.length) scope.postMessage({ t: 'frames', frames });
    } else if (m.t === 'aspect') sim?.setAspect(m.aspect);
    else if (m.t === 'peek') scope.postMessage({ t: 'peeked', world: peekWorld(m.opts) });
  } catch (err) {
    scope.postMessage({ t: 'error', message: String((err as Error)?.message ?? err).slice(0, 200) });
  }
};
