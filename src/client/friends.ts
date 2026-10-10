import { FRIEND_INVITE_SHOWN_MS, type ClientMsg } from '../shared/protocol.ts';

/**
 * Friends in a match, the page's side: the small menu a click on a board name opens beside the leaderboard (Add friend, or
 * Remove friend for one already a friend; a bot's says it cannot be friended), and the invites other players send, each a
 * plate with Accept and Decline under the top of the screen until answered or it runs out. The server owns friendships
 * (room.ts) and says who your friends are; what being friends does (no hurting each other, always on the minimap,
 * coming back beside each other) lives in the sim.
 *
 * Every control here is a DOM button, so a click with the pointer locked is handed to it rather than firing (pointerlock.ts),
 * and each swallows its mousedown so it never takes the keyboard's Space from the ability.
 */

export { FRIEND_INVITE_SHOWN_MS };

export type BoardPick = { id: number; name: string; human: boolean; x: number; y: number; w: number; h: number; right: number };

type Deps = { send(msg: ClientMsg): void; onChange(ids: ReadonlySet<number>): void };

export function createFriendsUi(deps: Deps) {
  let friends: ReadonlySet<number> = new Set();
  const asked = new Set<number>();
  let menu: { el: HTMLElement; id: number } | null = null;
  const invites = new Map<number, { el: HTMLElement; timer: ReturnType<typeof setTimeout> }>();

  const tray = document.createElement('div');
  tray.className = 'friend-invites';
  tray.setAttribute('aria-live', 'polite');
  document.body.append(tray);

  const button = (label: string, cls: string, act: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = (e) => { e.stopPropagation(); act(); };
    return b;
  };

  function closeMenu() {
    menu?.el.remove();
    menu = null;
  }

  /** Opens the menu for `pick` beside the board, level with its row (CSS px); a second click on the same name closes it. */
  function openMenu(pick: BoardPick) {
    if (menu?.id === pick.id) return closeMenu();
    closeMenu();
    const el = document.createElement('div');
    el.className = 'friend-menu';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `${pick.name}`);
    const head = document.createElement('div');
    head.className = 'friend-menu-name';
    head.textContent = pick.name;
    el.append(head, button('×', 'friend-menu-close', closeMenu));
    if (friends.has(pick.id)) {
      const note = document.createElement('div');
      note.className = 'friend-menu-note is-friend';
      note.textContent = '♥ Friend';
      el.append(note, button('Remove friend', 'friend-btn is-quiet', () => { deps.send({ t: 'friend', a: 'remove', id: pick.id }); closeMenu(); }));
    } else if (!pick.human) {
      const note = document.createElement('div');
      note.className = 'friend-menu-note';
      note.textContent = "Bots can't be friends";
      el.append(note);
    } else if (asked.has(pick.id)) {
      el.append(button('Invite sent', 'friend-btn is-sent', () => {}));
    } else {
      el.append(button('Add friend', 'friend-btn', () => {
        asked.add(pick.id);
        setTimeout(() => asked.delete(pick.id), FRIEND_INVITE_SHOWN_MS);
        deps.send({ t: 'friend', a: 'invite', id: pick.id });
        closeMenu();
      }));
    }
    el.style.right = `${Math.max(8, innerWidth - pick.right + 8)}px`;
    el.style.top = `${Math.max(8, pick.y + pick.h / 2)}px`;
    document.body.append(el);
    menu = { el, id: pick.id };
  }

  function dropInvite(from: number) {
    const inv = invites.get(from);
    if (!inv) return;
    clearTimeout(inv.timer);
    inv.el.remove();
    invites.delete(from);
  }

  function answer(from: number, a: 'accept' | 'decline') {
    deps.send({ t: 'friend', a, id: from });
    dropInvite(from);
  }

  return {
    openMenu,
    closeMenu,
    isMenuOpen: () => menu !== null,
    /** Someone asked to be your friend: a plate with Accept and Decline. */
    onInvite(from: number, name: string) {
      dropInvite(from);
      const el = document.createElement('div');
      el.className = 'friend-invite';
      el.setAttribute('role', 'status');
      const line = document.createElement('div');
      line.className = 'friend-invite-line';
      const who = document.createElement('b');
      who.textContent = name;
      line.append('♥ ', who, ' wants to be friends');
      const row = document.createElement('div');
      row.className = 'friend-invite-row';
      row.append(button('Accept', 'friend-btn', () => answer(from, 'accept')), button('Decline', 'friend-btn is-quiet', () => answer(from, 'decline')));
      el.append(line, row);
      tray.append(el);
      invites.set(from, { el, timer: setTimeout(() => dropInvite(from), FRIEND_INVITE_SHOWN_MS) });
    },
    /** Your friends now, by player id. */
    ids: (): ReadonlySet<number> => friends,
    /** The server's list of your friends. */
    setFriends(ids: readonly number[]) {
      friends = new Set(ids);
      for (const id of ids) { asked.delete(id); dropInvite(id); }
      deps.onChange(friends);
    },
    /** A new match (or the menu): friendships end with it, so every trace goes. */
    reset() {
      closeMenu();
      for (const id of [...invites.keys()]) dropInvite(id);
      asked.clear();
      friends = new Set();
      deps.onChange(friends);
    },
  };
}
