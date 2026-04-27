// src/socket/handlers.js — All Socket.IO real-time events for RetroQuest
import { supabase } from '../../config/supabase.js';
import { assertTeamLead } from '../util/auth.js';
import { startRoomTimer, stopRoomTimerEarly, addTime, getRoomTimer } from '../util/timers.js';
import { recordAudit } from '../util/audit.js';

// Soft-delete grace (seconds) before firing player_left for a disconnected socket.
const DISCONNECT_GRACE_SECONDS = 40;
// Hosts get a much longer grace because they often idle (watching the team
// write cards, reviewing) and a backgrounded mobile tab disconnects within
// seconds — promoting a new lead under those conditions surprises everyone.
// At 5 minutes a host is almost certainly genuinely gone.
const LEAD_DISCONNECT_GRACE_SECONDS = 300;

// Lobby emoji reactions — small curated set so clients can't smuggle anything
// unicode-weird (combining marks, huge SVG-renderable emoji, etc.).
const REACT_EMOJIS = new Set(['👍', '❤️', '🔥', '🎉', '😂', '💪', '🚀', '👏']);
// Per-socket in-memory cooldown for reactions (belt-and-suspenders to the
// client-side 1s debounce).
const REACT_COOLDOWN_MS = 900;
const lastReactAt = new Map();  // player_id → epoch ms of last broadcast

// Whitelists for room state strings — never trust client phase strings.
const VALID_PHASES       = new Set(['lobby', 'ice', 'retro', 'review', 'results']);
const VALID_RETRO_PHASES = new Set(['submit', 'vote']);
const VALID_TIMER_PHASES = new Set(['ice', 'retro_submit', 'retro_vote']);

async function leadCheck(socket) {
  const { room_id, player_id } = socket.data || {};
  if (!room_id || !player_id) return false;
  const r = await assertTeamLead(player_id, room_id);
  return r.ok;
}

// Authoritative room id for any socket op: trust only what was set during
// `join_room` after we verified the player belongs to that room. Inbound
// payloads are ignored — otherwise an attacker could broadcast/mutate any
// room they know the UUID of.
function bound(socket) {
  return socket.data?.room_id || null;
}

// Anything with last_seen_at earlier than this cutoff is treated as "gone".
// Voluntary leaves + disconnect-grace-expired rows both set last_seen_at to
// the 1970 epoch; legitimate rows always have a recent timestamp.
// Keep in sync with routes/rooms.js GET /players filter.
const ZOMBIE_CUTOFF = '1970-06-01T00:00:00.000Z';

// Server-side host transfer: promote next available player if the leaver was the lead.
export async function promoteNextLeadIfNeeded(io, room_id, leaving_player_id) {
  const { data: room } = await supabase
    .from('rooms').select('team_lead_player_id').eq('id', room_id).single();
  if (!room || room.team_lead_player_id !== leaving_player_id) return;

  // Exclude zombies. Otherwise, if the leaver had previously left + rejoined
  // with a fresh session_token (two rows for the same human — old zombie +
  // new live row), joined_at ASC orders the zombie first and we'd "promote"
  // an inactive row. The frontend's roster contains only the live row, so the
  // promotion would be invisible and the room would appear hostless.
  const { data: next } = await supabase
    .from('players').select('id, anon_handle, avatar')
    .eq('room_id', room_id)
    .neq('id', leaving_player_id)
    .eq('is_bot', false)
    .gt('last_seen_at', ZOMBIE_CUTOFF)
    .order('joined_at').limit(1).maybeSingle();

  if (!next) return;

  await supabase.from('players').update({ is_team_lead: false }).eq('room_id', room_id);
  await supabase.from('players').update({ is_team_lead: true }).eq('id', next.id);
  await supabase.from('rooms').update({ team_lead_player_id: next.id }).eq('id', room_id);

  io.to(room_id).emit('lead_set', {
    player_id: next.id, anon_handle: next.anon_handle, avatar: next.avatar,
  });
  recordAudit('host_promoted', {
    actor_kind: 'system', room_id,
    meta: { from: leaving_player_id, to: next.id, reason: 'leaver_was_lead' },
  });
}

export function registerSocketHandlers(io) {
  io.on('connection', socket => {
    console.log(`[socket] connected: ${socket.id}`);

    // ── join_room ──────────────────────────────────────────
    socket.on('join_room', async ({ room_id, player_id }) => {
      if (!room_id) return;

      // Verify player belongs to the room (or allow spectator with no player_id)
      if (player_id) {
        const { data: p } = await supabase
          .from('players').select('id, room_id').eq('id', player_id).single();
        if (!p || p.room_id !== room_id) {
          socket.emit('join_error', { error: 'Invalid player for this room' });
          return;
        }
      }

      socket.join(room_id);
      socket.data.room_id   = room_id;
      socket.data.player_id = player_id || null;

      if (player_id) {
        await supabase.from('players')
          .update({ last_seen_at: new Date().toISOString() }).eq('id', player_id);
      }

      // Send current timer state to rejoining player
      const t = getRoomTimer(room_id);
      if (t) socket.emit('timer_tick', { timer: t.timer, phase: t.phase, max: t.maxSecs });

      // State replay — only for verified room members. A socket that joined
      // without a player_id (spectator branch) should not be able to read
      // phase / retro_phase / lead identity by guessing room UUIDs.
      if (!player_id) return;

      // Re-sync room state to this socket only (covers backgrounded-tab
      // rejoins where the client missed phase/retro_phase/lead_set broadcasts
      // while disconnected). Frontend's existing handlers know how to apply
      // these — we just replay them as a private emit.
      const { data: roomState } = await supabase
        .from('rooms')
        .select('phase, retro_phase, team_lead_player_id')
        .eq('id', room_id).single();
      if (roomState) {
        if (roomState.phase)       socket.emit('phase_changed', { phase: roomState.phase });
        if (roomState.retro_phase) socket.emit('retro_phase_changed', { retro_phase: roomState.retro_phase });
        if (roomState.team_lead_player_id) {
          const { data: lead } = await supabase
            .from('players').select('id, anon_handle, avatar')
            .eq('id', roomState.team_lead_player_id).maybeSingle();
          if (lead) socket.emit('lead_set', {
            player_id: lead.id, anon_handle: lead.anon_handle, avatar: lead.avatar,
          });
        }
      }

      console.log(`[socket] ${player_id ?? 'anon'} joined room ${room_id}`);
    });

    // ── start_timer (lead) ────────────────────────────────
    socket.on('start_timer', async ({ phase }) => {
      const room_id = bound(socket);
      if (!room_id || !phase) return;
      if (!VALID_TIMER_PHASES.has(phase)) return;
      if (!(await leadCheck(socket))) return;

      const { data: room } = await supabase
        .from('rooms')
        .select('cfg_ice_timer_secs, cfg_retro_submit_secs, cfg_retro_vote_secs')
        .eq('id', room_id).single();
      if (!room) return;

      const durationMap = {
        ice:          room.cfg_ice_timer_secs    ?? 30,
        retro_submit: room.cfg_retro_submit_secs ?? 90,
        retro_vote:   room.cfg_retro_vote_secs   ?? 60,
      };
      const duration_secs = durationMap[phase];
      if (!duration_secs) return;

      startRoomTimer(io, room_id, phase, duration_secs);
    });

    // ── stop_timer_early (lead) ───────────────────────────
    socket.on('stop_timer_early', async ({ phase, reason }) => {
      const room_id = bound(socket);
      if (!room_id) return;
      if (phase && !VALID_TIMER_PHASES.has(phase)) return;
      if (!(await leadCheck(socket))) return;
      stopRoomTimerEarly(io, room_id, phase, typeof reason === 'string' ? reason.slice(0, 32) : 'early');
    });

    // ── add_time (lead) ───────────────────────────────────
    socket.on('add_time', async ({ delta_seconds }) => {
      const room_id = bound(socket);
      if (!room_id) return;
      if (typeof delta_seconds !== 'number' || !Number.isFinite(delta_seconds)) return;
      // Clamp to a sane window so a malicious lead can't push the timer to 2099.
      const clamped = Math.max(-3600, Math.min(3600, Math.round(delta_seconds)));
      if (!(await leadCheck(socket))) return;
      addTime(io, room_id, clamped);
    });

    // ── phase_change (lead) ───────────────────────────────
    socket.on('phase_change', async ({ phase }) => {
      const room_id = bound(socket);
      if (!room_id || !phase) return;
      if (!VALID_PHASES.has(phase)) return;
      if (!(await leadCheck(socket))) return;
      await supabase.from('rooms').update({ phase }).eq('id', room_id);
      stopRoomTimerEarly(io, room_id, getRoomTimer(room_id)?.phase, 'phase_advance');
      io.to(room_id).emit('phase_changed', { phase });
    });

    // ── retro_phase_change (lead) ─────────────────────────
    socket.on('retro_phase_change', async ({ retro_phase }) => {
      const room_id = bound(socket);
      if (!room_id || !retro_phase) return;
      if (!VALID_RETRO_PHASES.has(retro_phase)) return;
      if (!(await leadCheck(socket))) return;

      await supabase.from('rooms').update({ retro_phase }).eq('id', room_id);
      io.to(room_id).emit('retro_phase_changed', { retro_phase });

      if (retro_phase === 'vote') {
        const { data: cards, error: e } = await supabase
          .from('retro_cards')
          .select('id, col, content, vote_count, is_anonymous, is_discussed, is_duplicate, player_id, players(anon_handle, avatar)')
          .eq('room_id', room_id);
        if (e) console.error('[retro_phase_change] cards select failed:', e.message);

        // For anonymous cards: also strip player_id so peers can't correlate
        // the card to a roster slot via DevTools.
        const safe = (cards ?? []).map(c => c.is_anonymous
          ? { ...c, player_id: null, players: { anon_handle: 'Anonymous', avatar: '🕵️' } }
          : c);
        io.to(room_id).emit('cards_revealed', { cards: safe });
      }
    });

    // ── ice_reveal (lead) ─────────────────────────────────
    socket.on('ice_reveal', async ({ q_idx, answer_counts, player_picks }) => {
      const room_id = bound(socket);
      if (!room_id) return;
      if (!(await leadCheck(socket))) return;
      io.to(room_id).emit('ice_reveal', { q_idx, answer_counts, player_picks });
    });

    // ── ice_next_q (lead) ─────────────────────────────────
    socket.on('ice_next_q', async ({ q_idx }) => {
      const room_id = bound(socket);
      if (!room_id) return;
      if (!(await leadCheck(socket))) return;
      io.to(room_id).emit('ice_next_q', { q_idx });
    });

    // ── react  (any player reacts to another player with an emoji) ──
    socket.on('react', ({ to_player_id, emoji }) => {
      const room_id = bound(socket);
      const from_player_id = socket.data?.player_id;
      if (!room_id || !from_player_id || !to_player_id) return;
      if (typeof to_player_id !== 'string' || to_player_id.length > 64) return;
      if (to_player_id === from_player_id) return;           // can't react to self
      if (!REACT_EMOJIS.has(emoji)) return;                  // whitelist enforced here

      const now = Date.now();
      const last = lastReactAt.get(from_player_id) || 0;
      if (now - last < REACT_COOLDOWN_MS) return;
      lastReactAt.set(from_player_id, now);

      io.to(room_id).emit('reacted', {
        from_player_id, to_player_id, emoji, at: now,
      });
    });

    // ── review_navigate (lead) ────────────────────────────
    socket.on('review_navigate', async ({ card_index }) => {
      const room_id = bound(socket);
      if (!room_id) return;
      if (!(await leadCheck(socket))) return;
      io.to(room_id).emit('review_navigate', { card_index });
    });

    // ── player_left_voluntary ──────────────────────────────
    // Soft-leave: must be the player's own socket. Otherwise any client could
    // mark another player as gone and trigger lead promotion.
    socket.on('player_left_voluntary', async () => {
      const room_id = bound(socket);
      const player_id = socket.data?.player_id;
      if (!room_id || !player_id) return;
      await supabase.from('players')
        .update({ last_seen_at: new Date(0).toISOString() })
        .eq('id', player_id);
      await promoteNextLeadIfNeeded(io, room_id, player_id);
      io.to(room_id).emit('player_left', { player_id });
    });

    // ── disconnect ─────────────────────────────────────────
    socket.on('disconnect', async () => {
      const { room_id, player_id } = socket.data || {};
      console.log(`[socket] disconnected: ${socket.id}`);
      if (!room_id || !player_id) return;

      const disconnectedAt = new Date().toISOString();
      await supabase.from('players').update({ last_seen_at: disconnectedAt }).eq('id', player_id);

      // Use a longer grace for the team lead — see LEAD_DISCONNECT_GRACE_SECONDS.
      const { data: roomRow } = await supabase
        .from('rooms').select('team_lead_player_id').eq('id', room_id).maybeSingle();
      const isLead = roomRow?.team_lead_player_id === player_id;
      const grace  = isLead ? LEAD_DISCONNECT_GRACE_SECONDS : DISCONNECT_GRACE_SECONDS;

      setTimeout(async () => {
        const { data: p } = await supabase
          .from('players').select('id, last_seen_at').eq('id', player_id).maybeSingle();
        if (!p) return;

        // If last_seen_at has changed (the player reconnected), skip firing player_left.
        if (p.last_seen_at !== disconnectedAt) {
          console.log(`[socket] ${player_id} reconnected — skip player_left`);
          return;
        }
        // Mark this row as a zombie (last_seen_at = epoch) so GET /players
        // filters it out. The row itself stays so a session_token rejoin still
        // hits dedup.
        await supabase.from('players')
          .update({ last_seen_at: new Date(0).toISOString() }).eq('id', player_id);
        await promoteNextLeadIfNeeded(io, room_id, player_id);
        io.to(room_id).emit('player_left', { player_id });
        console.log(`[socket] confirmed left: ${player_id}${isLead ? ' (was lead)' : ''}`);
      }, grace * 1000);
    });
  });
}
