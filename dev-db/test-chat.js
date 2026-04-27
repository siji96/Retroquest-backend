// Isolate the socket chat_message roundtrip to check if the first test was a timing fluke.
import { io } from 'socket.io-client';

const BASE = 'http://localhost:3001';
const api = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json() };
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const mk = await api('POST', '/api/rooms', {});
const room = mk.body.room;
const j1 = await api('POST', `/api/rooms/${room.id}/join`, { avatar: '🐱', session_token: 'a' });
const j2 = await api('POST', `/api/rooms/${room.id}/join`, { avatar: '🐶', session_token: 'b' });

const sA = io(BASE, { transports: ['websocket'] });
const sB = io(BASE, { transports: ['websocket'] });

const received = { A: [], B: [] };
sA.on('chat_message', (m) => received.A.push(m));
sB.on('chat_message', (m) => received.B.push(m));

await Promise.all([new Promise(r => sA.once('connect', r)), new Promise(r => sB.once('connect', r))]);
sA.emit('join_room', { room_id: room.id, player_id: j1.body.player.id });
sB.emit('join_room', { room_id: room.id, player_id: j2.body.player.id });
await sleep(250);

// Emit 3 messages from B
for (const text of ['hello', 'test', 'one more']) {
  sB.emit('chat_message', { room_id: room.id, player_id: j2.body.player.id, content: text });
}
await sleep(1500);  // generous wait

console.log('A received:', received.A.map(m => m.content));
console.log('B received:', received.B.map(m => m.content));

sA.close(); sB.close();
process.exit(0);
