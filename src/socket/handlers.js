// src/socket/handlers.js
// All Socket.IO real-time events for RetroQuest
import { supabase } from '../../config/supabase.js';

export function registerSocketHandlers(io) {
  io.on('connection', socket => {
    console.log(`[socket] connected: ${socket.id}`);

    // ── join_room ──────────────────────────────────────────
    // Client sends on page load or reconnect
    socket.on('join_room', async ({ room_id, player_id }) => {
      if (!room_id) return;
      socket.join(room_id);
      socket.data.room_id   = room_id;
      socket.data.player_id = player_id;

      // Update last_seen
      if (player_id) {
        await supabase.from('players')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', player_id);
      }

      console.log(`[socket] ${player_id ?? 'anon'} joined room ${room_id}`);
    });

    // ── phase_change  (Team Lead advances game phase) ──────
    socket.on('phase_change', async ({ room_id, phase }) => {
      if (!room_id || !phase) return;
      await supabase.from('rooms').update({ phase }).eq('id', room_id);
      io.to(room_id).emit('phase_changed', { phase });
    });

    // ── retro_phase_change  (submit → vote → review → done) ─
    socket.on('retro_phase_change', async ({ room_id, retro_phase }) => {
      if (!room_id || !retro_phase) return;
      await supabase.from('rooms').update({ retro_phase }).eq('id', room_id);
      io.to(room_id).emit('retro_phase_changed', { retro_phase });

      // When vote phase starts → reveal all cards
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

    // ── timer_override  (Team Lead: +30s or skip) ──────────
    socket.on('timer_override', ({ room_id, delta_seconds }) => {
      if (!room_id) return;
      io.to(room_id).emit('timer_updated', { delta_seconds });
    });

    // ── chat_message  (lobby only, relayed in real-time) ───
    // Note: persistence happens via POST /api/chat
    // This socket event is a low-latency relay fallback
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

    // ── review_navigate  (Team Lead moves to a card) ───────
    socket.on('review_navigate', ({ room_id, card_index }) => {
      if (!room_id) return;
      // Broadcast to all OTHER sockets in the room
      socket.to(room_id).emit('review_navigate', { card_index });
    });

    // ── disconnect ─────────────────────────────────────────
    socket.on('disconnect', async () => {
      const { room_id, player_id } = socket.data;
      console.log(`[socket] disconnected: ${socket.id}`);

      if (room_id && player_id) {
        await supabase.from('players')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', player_id);

        // Notify room — client decides whether to show "left" indicator
        io.to(room_id).emit('player_left', { player_id });
      }
    });
  });
}
