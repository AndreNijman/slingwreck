// A dev watching a room they could not sit down in: the lobby was full or a match was on
// (worker.js watch()). The relay keeps them out of the match itself and sends them what a
// player would see of both sides: the roster, the clocks, every result, and in a siege
// both attacks, each fortress's blueprint plus its attacker's preview frames. Each board
// here is the defender's own corner preview, twice and bigger: a shadow round built from
// the blueprint, never stepped past the settle, reposed by a PreviewBuffer. A watcher
// arriving mid-round starts from the relay's sum of the frames so far.

import { makeRound, stepRound } from './sim.js?v=20261027-2';
import { drawPreview } from './render.js?v=20261027-2';
import { decode } from './build.js?v=20261027-2';
import { SETTLE_STEPS } from './relay-audit.js?v=20261027-2';
import { CARDS_BY_ID, TUNE } from './data.js?v=20261027-2';
import { PreviewBuffer } from './preview-buffer.js?v=20261027-2';

export function createWatch({ onLeave }) {
  const panel = document.querySelector('#siege-watch');
  const eyebrow = document.querySelector('#siege-watch-eyebrow');
  const title = document.querySelector('#siege-watch-title');
  const status = document.querySelector('#siege-watch-status');
  const boardsBlock = document.querySelector('#siege-watch-boards');
  const slots = [0, 1].map((index) => ({
    name: document.querySelector(`#siege-watch-name-${index}`),
    canvas: document.querySelector(`#siege-watch-canvas-${index}`),
    foot: document.querySelector(`#siege-watch-foot-${index}`)
  }));
  document.querySelector('#siege-watch-leave').addEventListener('click', () => onLeave());

  let view = null;
  let loop = 0;

  const nameOf = (pid) => view?.players.find((player) => player.pid === pid)?.name ?? 'Someone';
  const clock = (left) => `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  const score = () => view.players.map((player) => `${player.name} ${player.wins}`).join(' — ');

  // One fortress under attack, as its defender's corner preview shows it.
  function board(attack, slot) {
    const round = makeRound({
      mode: 'siege', blueprint: decode(attack.blueprint), bag: [], seed: attack.seed,
      attackerCards: attack.attackerCards, defenderCards: attack.defenderCards
    });
    for (let i = 0; i < SETTLE_STEPS; i++) stepRound(round, TUNE.step);
    const bodies = new Map(round.world.bodies.map((body) => [body.id, body]));
    const pigs = new Map(round.pigs.map((pig) => [pig.id, pig]));
    const frame = attack.frame;
    for (const [id, x, y, c, s, dead] of frame?.d ?? []) {
      const body = bodies.get(id);
      if (!body) continue;
      if (dead) body.dead = true;
      else Object.assign(body, { x, y, c, s });
    }
    for (const [id, dead] of frame?.p ?? []) if (dead && pigs.has(id)) pigs.get(id).dead = true;
    return {
      by: attack.pid, target: attack.target, round, slot,
      king: round.pigs.find((pig) => pig.isKing) ?? null,
      buffer: new PreviewBuffer(bodies, pigs),
      score: frame?.s ?? 0, ammo: frame?.a ?? attack.ammo ?? null
    };
  }

  function drawBoard(entry) {
    const { canvas, foot } = entry.slot;
    drawPreview(canvas.getContext('2d'), entry.round, canvas.width, canvas.height);
    const played = Number.isFinite(entry.buffer.playedT);
    const points = Math.round(played ? entry.buffer.score : entry.score);
    const ammo = entry.buffer.ammo ?? entry.ammo;
    const king = entry.king?.dead ? 'King popped' : 'King standing';
    foot.textContent = `${points} pts · ${ammo ?? '–'} shots left · ${king}`;
  }

  function tick() {
    loop = requestAnimationFrame(tick);
    for (const entry of view?.boards ?? []) {
      if (entry.buffer.render(performance.now())) drawBoard(entry);
    }
  }

  function render() {
    if (!view) return;
    const [a, b] = view.players;
    const versus = b ? `${a.name} vs ${b.name}` : a ? `${a.name}, waiting for an opponent` : 'An empty room';
    title.textContent = versus;
    eyebrow.textContent = `Watching "${view.room}"${view.round ? ` · round ${view.round}` : ''}`;
    boardsBlock.hidden = !view.boards.length;
    const left = view.left ? ` · ${clock(view.left)}` : '';
    switch (view.phase) {
      case 'lobby':
        status.textContent = `In the lobby. The next free seat is yours.`;
        break;
      case 'build':
        status.textContent = `Building${left}. ` + view.players
          .map((player) => `${player.name}: ${player.locked ? 'ready ✓' : 'building'}`).join(', ') + '.';
        break;
      case 'siege':
        status.textContent = `Siege${left}. ${score()}, first to ${TUNE.winsNeeded}.`;
        break;
      case 'draft':
        status.textContent = `${view.note || 'Round over.'} ${nameOf(view.picker)} is drafting a card${left}.`;
        break;
      case 'round-over':
      case 'match-over':
        status.textContent = view.note || 'Round over.';
        break;
      default:
        status.textContent = view.note || '';
    }
  }

  function snapshot(message) {
    const boards = (message.attacks ?? []).slice(0, 2).map((attack, index) => board(attack, slots[index]));
    view = {
      room: message.room ?? view?.room ?? '',
      phase: message.phase,
      round: message.round,
      left: message.left ?? 0,
      players: message.players ?? [],
      picker: -1,
      note: message.phase === 'match-over' && message.result ? `Match over. ${score()}.` : '',
      boards
    };
    for (const entry of boards) {
      entry.slot.name.textContent = `${nameOf(entry.target)}'s fortress · ${nameOf(entry.by)} attacking`;
      drawBoard(entry);
    }
    render();
  }

  function onMessage(message) {
    if (!view && message.t !== 'watch') return;
    switch (message.t) {
      case 'watch': snapshot(message); return;
      case 'lobby':
        view.players = message.players;
        if (message.phase === 'lobby') Object.assign(view, { phase: 'lobby', round: 0, left: 0, boards: [] });
        break;
      case 'build-status':
        for (const player of view.players) player.locked = (message.locked ?? []).includes(player.pid);
        break;
      case 'build-clock': case 'siege-clock': case 'draft-clock':
        view.left = message.left;
        if (message.t === 'draft-clock') view.picker = message.picker;
        break;
      case 'preview': {
        const entry = view.boards.find((candidate) => candidate.by === message.by);
        if (entry && message.frame) entry.buffer.push(message.frame, performance.now());
        return;
      }
      case 'round-over':
        view.phase = 'draft';
        view.players = message.standings ?? view.players;
        view.note = `Round ${message.round} to ${nameOf(message.winner)} (${String(message.reason).replaceAll('-', ' ')}). ${score()}.`;
        view.left = TUNE.draftSeconds;
        view.picker = view.players.find((player) => player.pid !== message.winner)?.pid ?? -1;
        break;
      case 'match-over':
        view.phase = 'match-over';
        view.players = message.standings ?? view.players;
        view.left = 0;
        view.note = `${nameOf(message.winner)} wins the siege. ${score()}. ` +
          'When both players leave, the room is yours.';
        break;
      case 'draft-picked':
        view.note = `${nameOf(message.picker)} drafted ${CARDS_BY_ID[message.card]?.name ?? message.card}.`;
        break;
      case 'sudden-death': case 'opponent-disconnected': case 'opponent-reconnected':
      case 'build-cancelled': case 'err':
        view.note = message.m || view.note;
        if (message.t === 'build-cancelled') Object.assign(view, { phase: 'lobby', boards: [] });
        break;
      default: return;
    }
    render();
  }

  function show() {
    view = null;
    status.textContent = 'Joining as a watcher…';
    boardsBlock.hidden = true;
    panel.hidden = false;
    if (!loop) loop = requestAnimationFrame(tick);
  }

  function hide() {
    panel.hidden = true;
    cancelAnimationFrame(loop);
    loop = 0;
    view = null;
  }

  function state() {
    return view && {
      phase: view.phase, round: view.round, players: view.players.map((player) => player.name),
      boards: view.boards.map((entry) => ({
        by: entry.by, target: entry.target, frames: entry.buffer.frames.length,
        played: Number.isFinite(entry.buffer.playedT),
        blocks: entry.round.blocks.length, deadBlocks: entry.round.blocks.filter((block) => block.dead).length
      })),
      status: status.textContent
    };
  }

  return { show, hide, onMessage, state, panel };
}
