/// <reference types="node" />
// Usage: node scripts/bot-trace.ts [mode=TDM] [map] [seconds=120] [seed=1] [out=bot-trace.html]
// Open `out#t=<seconds>` to land on a moment, add `&f=<bot id>` to follow one bot; arrow keys step, space plays.
import { writeFileSync } from 'node:fs';
import { MODE_IDS, WORLD } from '../src/shared/defs.ts';
import { MAP_IDS, ROTATION, type MapId } from '../src/shared/maps.ts';
import { addPlayer, step } from '../src/shared/sim.ts';
import { createWorld, crateRect, rand } from '../src/shared/sim/world.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../src/server/bots.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import type { Intent } from '../src/server/bot/intent.ts';

const mode = MODE_IDS.find((m) => m === (process.argv[2] ?? 'TDM'));
if (!mode || mode === 'ZOM') throw new Error('mode must be FFA, TDM or DOM');
const map = (MAP_IDS.find((m) => m === process.argv[3]) ?? ROTATION[mode][0]) as MapId;
const seconds = Number(process.argv[4] ?? 120);
const seed = Number(process.argv[5] ?? 1);
const out = process.argv[6] ?? 'bot-trace.html';
const TICK_MS = 1000 / WORLD.tickHz;
const EVERY = 1;

const w = createWorld(mode, seed, map);
const r = () => rand(w);
const mems = new Map<number, BotMemory>();
for (let i = 0; i < WORLD.minPlayers; i++) mems.set(addPlayer(w, `bot${i}`, randomLoadout(r)).id, newBotMemory(r));

function marks(i: Intent): { to: [number, number] | null; lookAt: [number, number] | null } {
  const p = (q: { x: number; y: number }): [number, number] => [Math.round(q.x), Math.round(q.y)];
  switch (i.k) {
    case 'patrol': return { to: p(i.goal), lookAt: null };
    case 'takePosition': return { to: p(i.spot), lookAt: p(i.facing) };
    case 'engage': return { to: null, lookAt: null };
    case 'peekAndHide': return { to: p(i.phase === 'hide' ? i.spot : i.peek), lookAt: p(i.phase === 'hide' ? i.peek : i.spot) };
    case 'reloadInCover': return { to: p(i.spot), lookAt: p(i.threat) };
    case 'retreatAndHeal': return { to: i.spot && p(i.spot), lookAt: p(i.threat) };
    case 'flank': return { to: p(i.via), lookAt: p(i.lastKnown) };
    case 'search': return { to: p(i.at), lookAt: null };
    case 'blinded': return { to: null, lookAt: p(i.at) };
    case 'resupply': return { to: p(i.at), lookAt: null };
    case 'hold': return { to: p(i.spot), lookAt: p(i.watch) };
  }
}

type Frame = { t: number; bots: (string | number | null | [number, number])[][]; shots: [number, number, number][] };
const frames: Frame[] = [];
for (let tick = 0; tick < (seconds * 1000) / TICK_MS; tick++) {
  const fired: [number, number, number][] = [];
  thinkBots(w, mems, r);
  step(w, TICK_MS);
  for (const e of w.events) if (e.e === 'shot') fired.push([Math.round(e.x), Math.round(e.y), Math.round(e.angle * 100) / 100]);
  if (tick % EVERY) continue;
  const bots = [...mems].map(([id, mem]) => {
    const p = w.players.get(id)!;
    const alive = p.life.k === 'alive';
    const i = mem.intent;
    const m = i && alive ? marks(i) : { to: null, lookAt: null };
    const phase = i?.k === 'peekAndHide' ? i.phase : '';
    return [id, Math.round(p.x), Math.round(p.y), p.team ?? '', alive ? Math.round((p.life.k === 'alive' ? p.life.hp : 0)) : 0, alive && i ? i.k : 'dead', phase, mem.persona, p.loadout.weapon, m.to, m.lookAt, Math.round(p.angle * 100) / 100];
  });
  frames.push({ t: Math.round(w.now) / 1000, bots, shots: fired });
}

const data = {
  mode, map, size: arenaFor(w).size, walls: w.walls.map((x) => [x.x, x.y, x.w, x.h]), crates: w.crates.map(crateRect).map((c) => [c.x, c.y, c.w, c.h]),
  zones: w.zones.map((z) => [z.x, z.y, z.r]), frames,
};
const html = `<!doctype html><meta charset="utf-8"><title>Bot trace</title>
<style>body{margin:0;background:#16181c;color:#ddd;font:13px system-ui}#wrap{display:flex;gap:12px;padding:10px}canvas{background:#23262c}
#side{width:260px}.k{display:flex;align-items:center;gap:6px;margin:2px 0}.sw{width:12px;height:12px;border-radius:50%}input{width:100%}</style>
<div id="wrap"><canvas id="c" width="900" height="900"></canvas><div id="side"><div id="head"></div><input id="s" type="range" min="0" step="1"><div id="legend"></div><div id="list"></div></div></div>
<script>
const D=${JSON.stringify(data)};
const C={patrol:'#9aa3ad',takePosition:'#5bc0eb',engage:'#f25f5c',peekAndHide:'#ffe066',reloadInCover:'#c77dff',retreatAndHeal:'#70e000',flank:'#ff9f1c',hold:'#2ec4b6',search:'#f15bb5',dead:'#444'};
const c=document.getElementById('c'),g=c.getContext('2d'),s=document.getElementById('s'),k=900/D.size;
s.max=D.frames.length-1;
document.getElementById('legend').innerHTML=Object.entries(C).map(([n,v])=>'<div class="k"><span class="sw" style="background:'+v+'"></span>'+n+'</div>').join('');
const follow=+((location.hash.match(/f=([0-9]+)/)||[])[1]||0);
function draw(i){const f=D.frames[i];g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,900,900);
const me=follow&&f.bots.find(b=>b[0]===follow);if(me){const z=3;g.setTransform(z,0,0,z,450-me[1]*k*z,450-me[2]*k*z);}
g.fillStyle='#3a3f48';for(const z of D.zones){g.beginPath();g.arc(z[0]*k,z[1]*k,z[2]*k,0,7);g.fill();}
g.fillStyle='#6b7280';for(const r of D.walls)g.fillRect(r[0]*k,r[1]*k,r[2]*k,r[3]*k);
g.fillStyle='#8a6d3b';for(const r of D.crates)g.fillRect(r[0]*k,r[1]*k,r[2]*k,r[3]*k);
g.strokeStyle='rgba(255,230,120,.5)';for(const sh of f.shots){g.beginPath();g.moveTo(sh[0]*k,sh[1]*k);g.lineTo((sh[0]+Math.cos(sh[2])*120)*k,(sh[1]+Math.sin(sh[2])*120)*k);g.stroke();}
for(const b of f.bots){const[id,x,y,team,hp,kind,phase,persona,weapon,to,lookAt,angle]=b;if(kind==='dead')continue;const col=C[kind];
if(to){g.setLineDash([4,4]);g.strokeStyle=col;g.beginPath();g.moveTo(x*k,y*k);g.lineTo(to[0]*k,to[1]*k);g.stroke();g.setLineDash([]);g.strokeRect(to[0]*k-3,to[1]*k-3,6,6);}
if(lookAt){g.strokeStyle=col+'88';g.beginPath();g.arc(lookAt[0]*k,lookAt[1]*k,5,0,7);g.stroke();}
g.fillStyle=col;g.beginPath();g.arc(x*k,y*k,24*k+2,0,7);g.fill();
g.lineWidth=3;g.strokeStyle=team==='red'?'#e63946':team==='blue'?'#4361ee':'#fff';g.beginPath();g.arc(x*k,y*k,24*k+4,0,7);g.stroke();g.lineWidth=1;
g.strokeStyle='#fff';g.lineWidth=2;g.beginPath();g.moveTo(x*k,y*k);g.lineTo((x+Math.cos(angle)*70)*k,(y+Math.sin(angle)*70)*k);g.stroke();g.lineWidth=1;
g.fillStyle='#fff';g.fillText(id+' '+Math.round(hp),x*k+10,y*k-8);}
document.getElementById('head').innerHTML='<b>'+D.mode+' '+D.map+'</b> t='+f.t.toFixed(1)+'s';
document.getElementById('list').innerHTML=f.bots.map(b=>'<div class="k"><span class="sw" style="background:'+C[b[5]]+'"></span>'+b[0]+' '+b[7]+' '+b[8]+' '+b[5]+(b[6]?'/'+b[6]:'')+' hp '+b[4]+'</div>').join('');
s.value=i;history.replaceState(null,'','#t='+f.t.toFixed(1)+(follow?'&f='+follow:''));}
const at=parseFloat((location.hash.match(/t=([0-9.]+)/)||[])[1]||'0');let i=Math.max(0,D.frames.findIndex(f=>f.t>=at));draw(i);let play=null;
s.oninput=()=>{i=+s.value;draw(i)};
addEventListener('keydown',e=>{if(e.key==='ArrowRight')draw(i=Math.min(s.max,i+1));if(e.key==='ArrowLeft')draw(i=Math.max(0,i-1));if(e.key===' '){if(play){clearInterval(play);play=null}else play=setInterval(()=>{if(i<s.max)draw(++i)},${TICK_MS * EVERY})}});
</script>`;
writeFileSync(out, html);
const share = new Map<string, number>();
for (const f of frames) for (const b of f.bots) share.set(b[5] as string, (share.get(b[5] as string) ?? 0) + 1);
console.log(`wrote ${out}: ${mode} ${map} ${seconds}s seed ${seed}, ${frames.length} frames; intent share ${[...share].map(([k, n]) => `${k} ${((100 * n) / (frames.length * mems.size)).toFixed(0)}%`).join(' ')}`);
