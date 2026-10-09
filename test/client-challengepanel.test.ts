import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChallengesView, ChallengeView } from '../src/shared/challenges.ts';

/** Just enough of the DOM for the panel: elements with a class, text, style, dataset and children. */
type Node = { tag: string; className: string; textContent: string; style: Record<string, string>; dataset: Record<string, string>; children: Node[]; append: (...n: Node[]) => void; replaceChildren: (...n: Node[]) => void };
const make = (tag: string): Node => {
  const n: Node = { tag, className: '', textContent: '', style: {}, dataset: {}, children: [], append: (...c) => { n.children.push(...c); }, replaceChildren: (...c) => { n.children = [...c]; } };
  return n;
};
(globalThis as { document?: unknown }).document = { createElement: make };
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
const { createChallengePanel } = await import('../src/client/challengepanel.ts');

const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
const byClass = (n: Node, cls: string) => all(n).filter((c) => c.className.split(' ').includes(cls));
const chal = (id: string, over: Partial<ChallengeView> = {}): ChallengeView => ({ id, target: 40, xp: 300, progress: 0, done: false, text: id, ...over });
const view = (weekly: ChallengeView[]): ChallengesView => ({ day: 'd1', dailyResetsAt: 1, daily: [chal('d')], week: 'w1', weeklyResetsAt: 2, weekly });

test('the weekly reward card tracks its challenge with the same bar and count as every challenge row', () => {
  const root = make('div');
  const panel = createChallengePanel(root as unknown as HTMLElement);
  panel.render(view([chal('w1'), chal('w2'), chal('w3', { grant: 'h_party', progress: 12, text: 'Win 3 rounds' })]));
  const card = byClass(root, 'chal-reward')[0]!;
  const progress = byClass(card, 'chal-reward-progress')[0]!;
  assert.ok(progress, 'the reward card has a progress block');
  assert.equal(byClass(progress, 'chal-bar')[0]!.children[0]!.style.width, '30%');
  assert.equal(byClass(progress, 'chal-count')[0]!.textContent, '12 / 40');
  const row = byClass(root, 'chal').find((r) => byClass(r, 'chal-text')[0]?.textContent === 'Win 3 rounds')!;
  assert.equal(byClass(row, 'chal-count')[0]!.textContent, byClass(progress, 'chal-count')[0]!.textContent, 'the card and the row agree');
  panel.render(view([chal('w3', { grant: 'h_party', progress: 40, done: true })]));
  const done = byClass(byClass(root, 'chal-reward')[0]!, 'chal-reward-progress')[0]!;
  assert.ok(done.className.includes('done'));
  assert.equal(byClass(done, 'chal-count')[0]!.textContent, 'Complete');
});
