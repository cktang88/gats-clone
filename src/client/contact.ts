/**
 * The "Give feedback" links (main menu footer, death card, pause menu): a mailto to the game's owner with a short subject and a
 * body that carries what helps read a report (where it was sent from, the mode and map, the browser and the screen). The address
 * also shows as text beside or in the link, for anyone without a mail client.
 */
export const FEEDBACK_EMAIL = 'halberd8@gmail.com';
export const FEEDBACK_SUBJECT = 'Tinwar feedback';

export type FeedbackFrom = 'menu' | 'death' | 'pause';
/** What the game knows when a link is pressed: the mode and map of the match (or the room picked on the menu). */
export type FeedbackGame = { mode?: string | null; map?: string | null; room?: string | null };
/** The device, read from the page when not given (tests pass their own). */
export type FeedbackEnv = { ua: string; screen: string; viewport: string };

const FROM_LABEL: Record<FeedbackFrom, string> = { menu: 'main menu', death: 'death card', pause: 'pause menu' };

let gameNow: () => FeedbackGame = () => ({});
/** main.ts tells the links where the player is, read fresh at each press. */
export function setFeedbackGame(get: () => FeedbackGame) { gameNow = get; }

export function pageEnv(): FeedbackEnv {
  const dpr = Math.round((globalThis.devicePixelRatio || 1) * 100) / 100;
  return {
    ua: globalThis.navigator?.userAgent ?? 'unknown',
    screen: globalThis.screen ? `${screen.width}x${screen.height} @${dpr}x` : 'unknown',
    viewport: `${globalThis.innerWidth ?? 0}x${globalThis.innerHeight ?? 0}`,
  };
}

/** The pre-filled mail body: room to write at the top, then a few lines of context (lines joined with CRLF, as mailto asks). */
export function feedbackBody(from: FeedbackFrom, game: FeedbackGame, env: FeedbackEnv): string {
  const where = [game.mode && `Mode: ${game.mode}`, game.map && `Map: ${game.map}`, game.room && `Room: ${game.room}`].filter(Boolean).join(' · ');
  return [
    '', '', '',
    '-- (context, keep or delete) --',
    `Sent from: ${FROM_LABEL[from]}`,
    ...(where ? [where] : []),
    `Screen: ${env.screen}, window ${env.viewport}`,
    `Browser: ${env.ua.slice(0, 200)}`,
  ].join('\r\n');
}

export function feedbackHref(from: FeedbackFrom, game: FeedbackGame = {}, env: FeedbackEnv = pageEnv()): string {
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(FEEDBACK_SUBJECT)}&body=${encodeURIComponent(feedbackBody(from, game, env))}`;
}

/** Points `a` at the feedback mail, refreshing the context on every hover, focus and press (the click uses the href as set here). */
export function wireFeedback(a: HTMLAnchorElement, from: FeedbackFrom): HTMLAnchorElement {
  const refresh = () => { a.href = feedbackHref(from, gameNow()); };
  a.title = `Contact: ${FEEDBACK_EMAIL}`;
  for (const ev of ['pointerenter', 'pointerdown', 'focus', 'click']) a.addEventListener(ev, refresh);
  // A focused link would take the Space that respawns or fires the ability.
  a.addEventListener('mousedown', (e) => e.preventDefault());
  refresh();
  return a;
}

/** A new feedback link, for menus built in code. */
export function feedbackLink(from: FeedbackFrom, text = 'Give feedback'): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'feedback-link';
  a.textContent = text;
  return wireFeedback(a, from);
}
