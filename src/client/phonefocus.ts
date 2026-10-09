import type { ModeId } from '../shared/defs.ts';
import type { GameEvent } from '../shared/protocol.ts';

/**
 * What the phone-on-its-side HUD shows right now (phonelayout.ts says where). On a phone the screen is precious, so a few things
 * are always on, and everything else waits until it matters or a thumb asks for it. As plain data so hud.ts, phonehud.ts and
 * the test read one answer.
 *
 * Always on (while you are alive and playing): your health (the cross and its armor), the rounds left (on the reload button),
 * the ability (on its button), the two sticks, the pause cog, the minimap folded small, and one slim status line where the
 * mode needs one: Domination's zones and score, the zombies run's day or night with the core and survivors, and Last Squad's
 * ring and squads.
 *
 * On demand: the level and score chips beside the cross for a moment after they change (or a tap on the cross); the minimap
 * grows for a few seconds on a tap; the chat folds to a small pip while there is something to read, and a tap shows the lines;
 * the kill feed keeps only your own kills and deaths and the big events, briefly; the clock comes up for an FFA or TDM round's
 * final minute, and TDM's team score for a moment after it moves; the emote (GG) button only as a round nears its end; the
 * stick labels only in your first match; the objective line once per mode; medals as a small chip for a moment.
 */
export const FOCUS = {
  /** How long a kept feed line stays (the desktop's is 6 s). */
  feedMs: 3500,
  /** The level and score chips, and TDM's team score, after a change. */
  chipMs: 2500,
  /** A tapped minimap, and a tapped-open chat. */
  mapOpenMs: 4000,
  chatOpenMs: 6000,
  /** The FFA and TDM clock comes up for the round's last minute; the GG button for its last half minute. */
  clockMs: 60_000,
  ggMs: 30_000,
  /** The stick labels in your first match, from the first frame they are drawn. */
  labelMs: 5000,
  /** A compact medal chip (the desktop's toast stands 2.6 s). */
  medalMs: 1800,
} as const;

/** Health, ammo and ability are in every mode; the status line only where the mode needs it. */
export const ALWAYS_ON = ['health', 'ammo', 'ability', 'sticks', 'cog', 'minimap'] as const;
export type PhoneElement =
  | (typeof ALWAYS_ON)[number]
  | 'status' | 'clock' | 'teamScore' | 'level' | 'score' | 'minimapOpen' | 'chatPip' | 'chatOpen' | 'board' | 'gg' | 'stickLabels'
  | 'intro' | 'rangeFull';

/** Where the mode's one status line is always on (DOM zones, zombies night, Last Squad ring); FFA, TDM and the range have none. */
export const statusAlways = (mode: ModeId): boolean => mode === 'DOM' || mode === 'ZOM' || mode === 'BR';

export type FocusState = {
  mode: ModeId;
  now: number;
  /** Ms left in the round, or null when it has no clock (zombies, Last Squad, the range). */
  timeLeft: number | null;
  /** The round (or run) is over and its result is up. */
  over: boolean;
  /** Last Squad: squads still standing. */
  squadsLeft?: number;
  /** When each changed or was tapped (-Infinity for never). */
  levelAt: number;
  scoreAt: number;
  vitalsTapAt: number;
  teamScoreAt: number;
  mapTapAt: number;
  chatTapAt: number;
  rangeTapAt: number;
  /** Chat lines still on the log (said by a player, not the room's notices). */
  chatLines: number;
  /** No match finished on this device yet: the stick labels still help. */
  firstMatch: boolean;
  /** When the stick guides were first drawn this match. */
  guidesSince: number;
  /** The objective line was already shown for this mode on this device. */
  introSeen: boolean;
};

const within = (now: number, at: number, ms: number): boolean => now - at >= 0 && now - at < ms;

/** The stick labels: only in your first match, for their first few seconds. */
export const labelsOn = (firstMatch: boolean, now: number, since: number): boolean => firstMatch && within(now, since, FOCUS.labelMs);

export function phoneFocus(f: FocusState): Record<PhoneElement, boolean> {
  const { now, mode } = f;
  const final = (ms: number) => f.timeLeft !== null && f.timeLeft > 0 && f.timeLeft <= ms;
  const chatOpen = f.chatLines > 0 && within(now, f.chatTapAt, FOCUS.chatOpenMs);
  const nearEnd = f.over || final(FOCUS.ggMs) || (mode === 'BR' && f.squadsLeft !== undefined && f.squadsLeft <= 2);
  return {
    health: true, ammo: true, ability: true, sticks: true, cog: true, minimap: true,
    status: statusAlways(mode),
    clock: (mode === 'FFA' || mode === 'TDM') && final(FOCUS.clockMs),
    teamScore: mode === 'TDM' && (final(FOCUS.clockMs) || within(now, f.teamScoreAt, FOCUS.chipMs)),
    level: within(now, f.levelAt, FOCUS.chipMs) || within(now, f.vitalsTapAt, FOCUS.chipMs),
    score: within(now, f.scoreAt, FOCUS.chipMs) || within(now, f.vitalsTapAt, FOCUS.chipMs),
    minimapOpen: within(now, f.mapTapAt, FOCUS.mapOpenMs),
    chatPip: f.chatLines > 0 && !chatOpen,
    chatOpen,
    // Your place on the board means nothing in co-op or alone on the range.
    board: mode !== 'ZOM' && mode !== 'RNG',
    gg: mode !== 'RNG' && nearEnd,
    stickLabels: labelsOn(f.firstMatch, now, f.guidesSince),
    intro: !f.introSeen,
    rangeFull: mode === 'RNG' && within(now, f.rangeTapAt, FOCUS.mapOpenMs),
  };
}

type FeedLine = Extract<GameEvent, { e: 'kill' | 'hunted' | 'life' | 'wiped' | 'airdrop' }>;

/**
 * The phone's kill feed keeps your own kills and deaths (and assists), and the big events: a bounty paid, a long streak ended,
 * someone hunted, a squad wiped out, an airdrop, and a squadmate (or you) going down or coming back.
 */
export function feedKeeps(f: FeedLine, myId: number, myTeam: string | null, teamOf: (id: number) => string | null): boolean {
  if (f.e === 'kill') return f.killerId === myId || f.victimId === myId || f.assisters.includes(myId) || f.bounty || f.ended >= 5;
  if (f.e === 'life') return f.id === myId || (myTeam !== null && teamOf(f.id) === myTeam);
  return true;
}
