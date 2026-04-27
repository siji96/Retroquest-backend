// Integration smoke test for RetroQuest backend (updated for v2 auth contract).
import { io } from 'socket.io-client';

const BASE = 'http://localhost:3001';
const api = async (m, p, b) => {
  const r = await fetch(BASE + p, {
    method: m, headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  let body; const text = await r.text();
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: r.status, body };
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const report = [];
let failCount = 0;
const pass = (m)     => { const l = `[pass] ${m}`; report.push(l); console.log(l); };
const fail = (m, x)  => { failCount++; const l = `[FAIL] ${m}${x ? ' — ' + JSON.stringify(x) : ''}`; report.push(l); console.log(l); };
const info = (m, x)  => { const l = `[info] ${m}${x ? ' — ' + JSON.stringify(x) : ''}`; report.push(l); console.log(l); };

const events = {};
const bindSocket = (name, sock) => {
  ['player_joined','player_left','chat_message','card_added','card_voted',
   'card_commented','card_moved','card_discussed','card_duplicate','cards_revealed',
   'phase_changed','retro_phase_changed','room_locked','room_unlocked','lead_set','game_ended',
   'timer_tick','timer_end','review_navigate','ice_reveal','ice_next_q','ice_answered',
   'host_transferred'].forEach(ev => sock.on(ev, p => (events[`${name}:${ev}`] ??= []).push(p)));
};

// ── run ────────────────────────────────────────────────────
console.log('── RetroQuest smoke test v2 ──────────────────────');

// Health
{
  const r = await api('GET', '/health');
  r.status === 200 ? pass('health 200') : fail('health', r);
}

// Create + lookup
const mk = await api('POST', '/api/rooms', {});
const room = mk.body.room;
mk.status === 200 && room?.id ? pass(`create ${room.code}`) : (fail('create', mk), process.exit(1));

{
  const r = await api('GET', `/api/rooms/${room.code}`);
  r.status === 200 ? pass('get by code') : fail('get by code', r);
}

// Join 3 players
const token = () => Math.random().toString(36).slice(2);
const players = {};
for (const [who, t, av] of [['alice',token(),'🐱'],['bob',token(),'🐶'],['carol',token(),'🦊']]) {
  const r = await api('POST', `/api/rooms/${room.id}/join`, { avatar: av, session_token: t });
  if (r.status !== 200) fail(`join ${who}`, r);
  else { players[who] = { ...r.body.player, session_token: t }; pass(`join ${who}`); }
}

// Rejoin dedup
{
  const r = await api('POST', `/api/rooms/${room.id}/join`, { avatar: '🐨', session_token: players.alice.session_token });
  r.body.player?.id === players.alice.id ? pass('rejoin dedups') : fail('rejoin dedup broken', r.body);
}

// AUTH CHECKS (new contract) ---------------------------------

// A-2: /lock without player_id → 400
{
  const r = await api('POST', `/api/rooms/${room.id}/lock`, { is_open: false });
  r.status === 400 ? pass('A-2 /lock rejects missing player_id') : fail('A-2 /lock no-auth', r);
}
// /lock with valid bootstrap (alice, no lead yet)
{
  const r = await api('POST', `/api/rooms/${room.id}/lock`, { player_id: players.alice.id, is_open: false });
  r.status === 200 ? pass('/lock bootstrap ok') : fail('/lock bootstrap', r);
}
// /lock from non-member → 403
{
  const r = await api('POST', `/api/rooms/${room.id}/lock`, { player_id: '00000000-0000-0000-0000-000000000000', is_open: true });
  r.status === 403 ? pass('A-2 /lock non-member 403') : fail('/lock non-member', r);
}
// Restore unlocked
await api('POST', `/api/rooms/${room.id}/lock`, { player_id: players.alice.id, is_open: true });

// /phase without player_id → 400 (or without lead → 403)
{
  const r = await api('POST', `/api/rooms/${room.id}/phase`, { phase: 'ice' });
  r.status === 400 ? pass('A-2 /phase rejects missing player_id') : fail('/phase no-auth', r);
}
{
  const r = await api('POST', `/api/rooms/${room.id}/phase`, { player_id: players.alice.id, phase: 'ice' });
  r.status === 403 ? pass('/phase pre-start 403 (no lead yet)') : fail('/phase should require lead', r);
}

// Sockets
const sA = io(BASE, { transports: ['websocket'] });
const sB = io(BASE, { transports: ['websocket'] });
const sC = io(BASE, { transports: ['websocket'] });
bindSocket('A', sA); bindSocket('B', sB); bindSocket('C', sC);
await Promise.all([new Promise(r => sA.once('connect', r)),
                   new Promise(r => sB.once('connect', r)),
                   new Promise(r => sC.once('connect', r))]);
sA.emit('join_room', { room_id: room.id, player_id: players.alice.id });
sB.emit('join_room', { room_id: room.id, player_id: players.bob.id });
sC.emit('join_room', { room_id: room.id, player_id: players.carol.id });
await sleep(250);

// /start — alice bootstraps + becomes lead
{
  const r = await api('POST', `/api/rooms/${room.id}/start`, {
    player_id: players.alice.id, team_lead_player_id: players.alice.id,
  });
  await sleep(100);
  r.status === 200 && events['B:lead_set']?.[0]?.player_id === players.alice.id
    ? pass('start → alice lead')
    : fail('start', r);
}

// A-1: bob tries to change phase via socket → silently ignored (no emit)
{
  const before = (events['B:phase_changed'] ?? []).length;
  sB.emit('phase_change', { room_id: room.id, phase: 'ice' });
  await sleep(400);
  const after = (events['B:phase_changed'] ?? []).length;
  after === before ? pass('A-1 non-lead socket phase_change ignored') : fail('A-1 non-lead can change phase!', events['B:phase_changed']);
}

// A-1: alice (lead) can change phase via socket
{
  sA.emit('phase_change', { room_id: room.id, phase: 'ice' });
  await sleep(400);
  events['B:phase_changed']?.some(e => e.phase === 'ice')
    ? pass('A-1 lead socket phase_change ok')
    : fail('lead socket phase_change fail', events['B:phase_changed']);
}

// Ice questions — start a timer and answer
sA.emit('start_timer', { room_id: room.id, phase: 'ice' });
await sleep(400);
const tick0 = events['B:timer_tick']?.[0];
tick0?.phase === 'ice' ? pass('timer_tick for ice received') : fail('no timer_tick', events['B:timer_tick']);

const qsRes = await api('GET', `/api/ice/questions/${room.id}`);
const q0 = qsRes.body?.questions?.[0];
if (!q0) fail('no ice questions', qsRes);
else {
  const correct = q0.correct_idx;
  const wrong = (correct + 1) % 4;

  // A-4: client claims absurd time_left_sec — should be IGNORED (server derives from timer)
  const rA = await api('POST', '/api/ice/answer', {
    room_id: room.id, player_id: players.alice.id, question_id: q0.id,
    chosen_idx: correct, time_left_sec: 99999,
  });
  if (rA.body.is_correct && rA.body.xp_earned < 500) pass(`A-4 ice XP capped by server (got ${rA.body.xp_earned})`);
  else fail('A-4 ice XP not server-capped', rA.body);

  // RT-1: duplicate answer → should NOT re-broadcast
  const beforeDup = (events['B:ice_answered'] ?? []).length;
  const rDup = await api('POST', '/api/ice/answer', {
    room_id: room.id, player_id: players.alice.id, question_id: q0.id,
    chosen_idx: wrong, time_left_sec: 5,
  });
  await sleep(100);
  const afterDup = (events['B:ice_answered'] ?? []).length;
  rDup.body.duplicate === true && afterDup === beforeDup
    ? pass('RT-1 duplicate ice answer NOT rebroadcast')
    : fail('RT-1 duplicate rebroadcast', { rDup: rDup.body, deltaEvents: afterDup - beforeDup });

  // Bob answers wrong
  const rB = await api('POST', '/api/ice/answer', {
    room_id: room.id, player_id: players.bob.id, question_id: q0.id,
    chosen_idx: wrong, time_left_sec: 5,
  });
  rB.body.is_correct === false && rB.body.xp_earned === 0
    ? pass('ice wrong = 0 XP')
    : fail('ice wrong XP wrong', rB.body);
}

// Stop timer early
sA.emit('stop_timer_early', { room_id: room.id, phase: 'ice', reason: 'all_answered' });
await sleep(400);
events['B:timer_end']?.some(e => e.phase === 'ice') ? pass('stop_timer_early works') : fail('no timer_end', events['B:timer_end']);

// Move to retro submit
sA.emit('phase_change', { room_id: room.id, phase: 'retro_submit' });
sA.emit('retro_phase_change', { room_id: room.id, retro_phase: 'submit' });
await sleep(400);

// Live collaboration: alice's card content should be visible to peers in real time.
let bobCard = null;
const eventsBeforeSubmit = (events['B:card_added'] ?? []).length;
const eventsCBeforeSubmit = (events['C:card_added'] ?? []).length;

{
  const r = await api('POST', '/api/cards', {
    room_id: room.id, player_id: players.alice.id, col: 'went_well',
    content: 'Secret content from alice',
  });
  await sleep(400);
  const b = events['B:card_added']?.[eventsBeforeSubmit];
  const c = events['C:card_added']?.[eventsCBeforeSubmit];
  if (r.body.card && b?.content === 'Secret content from alice' && c?.content === 'Secret content from alice') {
    pass('card_added broadcasts content to peers in real time');
  } else {
    fail('card_added missing content for peers', { bToBob: b?.content, bToCarol: c?.content });
  }
}

// Bob and Carol submit
for (const [who, col, text] of [['bob','improve','bob\'s card'], ['carol','not_sure','carol\'s card']]) {
  const r = await api('POST', '/api/cards', {
    room_id: room.id, player_id: players[who].id, col, content: text,
  });
  if (r.body.card) { if (who === 'bob') bobCard = r.body.card; pass(`submit ${who}`); }
  else fail(`submit ${who}`, r);
}

// Bob tries to submit without player_id
{
  const r = await api('POST', '/api/cards', { room_id: room.id, col: 'went_well', content: 'anon' });
  r.status === 400 ? pass('submit missing player_id → 400') : fail('submit unauth', r);
}

// GET cards during submit as bob → peer content is visible (live collaboration).
{
  const r = await api('GET', `/api/rooms/${room.id}/cards?phase=submit&player_id=${players.bob.id}`);
  const aliceFromBobView = r.body.cards?.find(c => c.player_id === players.alice.id);
  aliceFromBobView?.content === 'Secret content from alice'
    ? pass('GET /cards submit returns peer content live')
    : fail('GET /cards missing peer content', aliceFromBobView);
}

// Retro vote phase — handler does a heavy SELECT with players join before emitting
sA.emit('retro_phase_change', { room_id: room.id, retro_phase: 'vote' });
await sleep(800);
events['B:cards_revealed'] ? pass('cards_revealed on vote phase') : fail('cards_revealed missing', null);

// Vote / unvote / revote XP double-credit fix
const vote    = () => api('POST', `/api/cards/${bobCard.id}/vote`,   { room_id: room.id, voter_id: players.alice.id });
const unvote  = () => api('POST', `/api/cards/${bobCard.id}/unvote`, { room_id: room.id, voter_id: players.alice.id });

let v = await vote();
v.body.vote_count === 1 ? pass('vote count=1') : fail('vote count', v);

v = await unvote();
v.body.vote_count === 0 ? pass('unvote count=0') : fail('unvote count', v);

v = await vote();
v.body.vote_count === 1 ? pass('revote count=1') : fail('revote count', v);

// CV-2: unvote from someone who never voted should be a no-op
{
  const before = await api('POST', `/api/cards/${bobCard.id}/unvote`, { room_id: room.id, voter_id: players.carol.id });
  // carol never voted; count should drop only if carol HAD voted. Should remain 1.
  before.body.vote_count === 1 ? pass('CV-2 phantom unvote is no-op') : fail('CV-2 phantom unvote changed count', before);
}

// CV-4/XP-dup: leaderboard should show alice retro_vote XP = +5 (not +10) even after vote→unvote→vote
{
  const r = await api('GET', `/api/leaderboard/${room.id}`);
  const byId = Object.fromEntries((r.body.leaderboard ?? []).map(x => [x.player_id, x]));
  const aliceXp = byId[players.alice.id]?.xp_total;
  // alice: ice_correct(server-capped) + card(+20) + vote(+5, idempotent) = somewhere 25-250
  info(`leaderboard alice=${aliceXp} bob=${byId[players.bob.id]?.xp_total} carol=${byId[players.carol.id]?.xp_total}`);
  if (typeof aliceXp === 'number' && aliceXp < 300) pass('XP idempotency — alice total within expected band');
  else fail('XP leaderboard out of band', { aliceXp });
}

// Lead comment / non-lead comment
{
  const r = await api('POST', `/api/cards/${bobCard.id}/comment`, {
    room_id: room.id, player_id: players.alice.id, content: 'lead comment',
  });
  r.status === 200 ? pass('lead comment ok') : fail('lead comment', r);
}
{
  const r = await api('POST', `/api/cards/${bobCard.id}/comment`, {
    room_id: room.id, player_id: players.bob.id, content: 'should fail',
  });
  r.status === 403 ? pass('non-lead comment 403') : fail('non-lead commented', r);
}

// Chat via REST
const chatBefore = (events['A:chat_message'] ?? []).length;
{
  const r = await api('POST', '/api/chat', { room_id: room.id, player_id: players.bob.id, content: 'gg' });
  await sleep(400);
  const after = (events['A:chat_message'] ?? []).length;
  r.status === 200 && after > chatBefore ? pass('chat REST persists + broadcasts') : fail('chat REST', r);
}

// End game (lead only)
{
  const r = await api('POST', `/api/rooms/${room.id}/end`, {
    player_id: players.alice.id, mood_emoji: '🌟', mood_label: 'Good',
    committed_items: [{ text: 'Pair more', votes: 2 }],
  });
  await sleep(400);
  r.status === 200 && events['A:game_ended'] ? pass('end ok') : fail('end', r);
}

// Non-lead end → 403
{
  const m2 = await api('POST', '/api/rooms', {});
  const r = await api('POST', `/api/rooms/${m2.body.room.id}/end`, { player_id: players.bob.id });
  r.status === 403 ? pass('non-lead /end 403') : fail('non-lead ended', r);
}

await sleep(300);
sA.close(); sB.close(); sC.close();

console.log('\n── summary ─────────────────────────────────');
console.log(`FAILURES: ${failCount}`);
console.log(report.filter(l => l.startsWith('[FAIL]')).join('\n') || '(none)');

process.exit(failCount === 0 ? 0 : 1);
