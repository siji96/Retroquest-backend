// src/socket/handlers.js
// All Socket.IO real-time events for RetroQuest
import { supabase } from '../../config/supabase.js';

// ── Server-side timer store ──────────────────────────────────
// room_id → { iv, timer, phase, maxSecs }
const roomTimers = new Map();

function clearRoomTimer(room_id) {
  const t = roomTimers.get(room_id);
  if (t) { clearInterval(t.iv); roomTimers.delete(room_id); }
}

function startRoomTimer(io, room_id, phase, duration_secs) {
  clearRoomTimer(room_id); // clear any existing timer for this room

  let timer = duration_secs;
  const maxSecs = duration_secs;

  // Immediately broadcast initial value
  io.to(room_id).emit('timer_tick', { timer, phase, max: maxSecs });

  const iv = setInterval(() => {
    timer--;
    io.to(room_id).emit('timer_tick', { timer, phase, max: maxSecs });

    if (timer <= 0) {
      clearRoomTimer(room_id);
      io.to(room_id).emit('timer_end', { phase });
    }
  }, 1000);

  roomTimers.set(room_id, { iv, timer, phase, maxSecs });
}

export function registerSocketHandlers(io) {
  io.on('connection', socket => {
    console.log(`[socket] connected: ${socket.id}`);

    // ── join_room ──────────────────────────────────────────
    socket.on('join_room', async ({ room_id, player_id }) => {
      if (!room_id) return;
      socket.join(room_id);
      socket.data.room_id   = room_id;
      socket.data.player_id = player_id;

      if (player_id) {
        await supabase.from('players')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', player_id);
      }

      // Send current timer state to rejoining player
      const t = roomTimers.get(room_id);
      if (t) {
        socket.emit('timer_tick', { timer: t.timer, phase: t.phase, max: t.maxSecs });
      }

      console.log(`[socket] ${player_id ?? 'anon'} joined room ${room_id}`);
    });

    // ── start_timer  (host starts a phase timer) ──────────
    // Backend fetches duration from DB — not trusting client value
    socket.on('start_timer', async ({ room_id, phase }) => {
      if (!room_id || !phase) return;

      // Fetch config from DB
      const { data: room } = await supabase
        .from('rooms')
        .select('cfg_ice_timer_secs, cfg_retro_submit_secs, cfg_retro_vote_secs')
        .eq('id', room_id)
        .single();

      if (!room) return;

      const durationMap = {
        'ice':          room.cfg_ice_timer_secs    ?? 30,
        'retro_submit': room.cfg_retro_submit_secs ?? 90,
        'retro_vote':   room.cfg_retro_vote_secs   ?? 60,
      };

      const duration_secs = durationMap[phase];
      if (!duration_secs) return;

      console.log(`[timer] start ${phase} ${duration_secs}s (from DB) for room ${room_id}`);
      startRoomTimer(io, room_id, phase, duration_secs);
    });

    // ── stop_timer_early  (all answered, or host skip) ────
    socket.on('stop_timer_early', ({ room_id, phase, reason }) => {
      if (!room_id) return;
      const t = roomTimers.get(room_id);
      if (t && t.phase === phase) {
        clearRoomTimer(room_id);
        io.to(room_id).emit('timer_end', { phase, reason: reason || 'early' });
        console.log(`[timer] early end ${phase} room ${room_id} — ${reason}`);
      }
    });

    // ── add_time  (host +30s) ──────────────────────────────
    socket.on('add_time', ({ room_id, delta_seconds }) => {
      if (!room_id) return;
      const t = roomTimers.get(room_id);
      if (t) {
        t.timer = Math.max(0, t.timer + delta_seconds);
        io.to(room_id).emit('timer_tick', { timer: t.timer, phase: t.phase, max: t.maxSecs });
      }
    });

    // ── phase_change  (Team Lead advances game phase) ──────
    socket.on('phase_change', async ({ room_id, phase }) => {
      if (!room_id || !phase) return;
      await supabase.from('rooms').update({ phase }).eq('id', room_id);
      io.to(room_id).emit('phase_changed', { phase });
    });

    // ── retro_phase_change  (submit → vote) ─────────────────
    socket.on('retro_phase_change', async ({ room_id, retro_phase }) => {
      if (!room_id || !retro_phase) return;
      await supabase.from('rooms').update({ retro_phase }).eq('id', room_id);
      io.to(room_id).emit('retro_phase_changed', { retro_phase });

      if (retro_phase === 'vote') {
        const { data: cards } = await supabase
          .from('retro_cards')
          .select('id, col, content, vote_count, is_anonymous, players:player_id(anon_handle, avatar)')
          .eq('room_id', room_id);

        const safe = (cards ?? []).map(c => c.is_anonymous
          ? { ...c, players: { anon_handle: 'Anonymous', avatar: '🕵️' } }
          : c);

        io.to(room_id).emit('cards_revealed', { cards: safe });
      }
    });

    // ── chat_message ───────────────────────────────────────
    socket.on('chat_message', async ({ room_id, player_id, content }) => {
      if (!room_id || !content?.trim()) return;
      const { data: player } = await supabase
        .from('players').select('anon_handle, avatar, is_team_lead').eq('id', player_id).single();

      io.to(room_id).emit('chat_message', {
        content: content.trim().slice(0, 200),
        avatar:       player?.avatar       ?? '🦄',
        handle:       player?.anon_handle  ?? 'Unknown',
        is_team_lead: player?.is_team_lead ?? false,
        created_at: new Date().toISOString(),
      });
    });

    // ── review_navigate ────────────────────────────────────
    socket.on('review_navigate', ({ room_id, card_index }) => {
      if (!room_id) return;
      socket.to(room_id).emit('review_navigate', { card_index });
    });

    // ── ice_reveal  (all answered or timer_end triggers this via client) ──
    socket.on('ice_reveal', ({ room_id, q_idx, answer_counts, player_picks }) => {
      if (!room_id) return;
      io.to(room_id).emit('ice_reveal', { q_idx, answer_counts, player_picks });
    });

    // ── ice_next_q ─────────────────────────────────────────
    socket.on('ice_next_q', ({ room_id, q_idx }) => {
      if (!room_id) return;
      io.to(room_id).emit('ice_next_q', { q_idx });
    });

    // ── player_left_voluntary ──────────────────────────────
    socket.on('player_left_voluntary', async ({ room_id, player_id }) => {
      if (!room_id || !player_id) return;
      await supabase.from('players').delete().eq('id', player_id);
      io.to(room_id).emit('player_left', { player_id });
      console.log(`[socket] voluntary leave: ${player_id}`);
    });

    // ── host_transferred ───────────────────────────────────
    socket.on('host_transferred', ({ room_id, new_lead_id, new_lead_name, new_lead_avatar }) => {
      if (!room_id) return;
      socket.to(room_id).emit('host_transferred', { new_lead_id, new_lead_name, new_lead_avatar });
    });

    // ── disconnect ─────────────────────────────────────────
    socket.on('disconnect', async () => {
      const { room_id, player_id } = socket.data;
      console.log(`[socket] disconnected: ${socket.id}`);

      if (room_id && player_id) {
        await supabase.from('players')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', player_id);

        setTimeout(async () => {
          const { data: p } = await supabase
            .from('players').select('last_seen_at, id').eq('id', player_id).single();

          if (!p) return;
          const secondsSince = (Date.now() - new Date(p.last_seen_at).getTime()) / 1000;
          if (secondsSince < 18) {
            console.log(`[socket] ${player_id} reconnected — skip player_left`);
            return;
          }
          io.to(room_id).emit('player_left', { player_id });
          console.log(`[socket] confirmed left: ${player_id}`);
        }, 20000);
      }
    });
  });
}
