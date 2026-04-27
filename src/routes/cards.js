// src/routes/cards.js
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { supabase } from '../../config/supabase.js';
import { assertRoomMember, assertTeamLead } from '../util/auth.js';

const router = Router();
const VALID_COLS = ['went_well', 'improve', 'not_sure'];

// Per-room and per-player caps to bound DB growth and broadcast payloads,
// especially under the "unlimited submit" phase mode where the timer doesn't
// gate the firehose.
const MAX_CARDS_PER_ROOM   = 500;
const MAX_CARDS_PER_PLAYER = 50;

// Per-player rate limit on the cards router. The default key is IP, which
// would lump all NAT'd users into one bucket. Keying by player_id keeps the
// limit fair while still capping the abuse vector (rapid create/delete loops
// flood the DB and the socket broadcast channel).
const cardsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => `cards:${req.body?.player_id || req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Slow down — too many card actions' },
});
router.use(cardsLimiter);

// ── POST /api/cards  — submit a retro card ───────────────────
router.post('/', async (req, res) => {
  try {
    const { room_id, player_id, col, content, is_anonymous = false } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const auth = await assertRoomMember(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    if (!content?.trim())          return res.status(400).json({ error: 'Content is required' });
    if (content.length > 140)      return res.status(400).json({ error: 'Max 140 characters' });
    if (!VALID_COLS.includes(col)) return res.status(400).json({ error: 'Invalid column' });

    // Guard: only accept cards during the submit retro phase
    const { data: room } = await supabase
      .from('rooms').select('retro_phase').eq('id', room_id).single();
    if (room?.retro_phase && room.retro_phase !== 'submit') {
      return res.status(403).json({ error: 'Submit phase has ended' });
    }

    // DoS / runaway-growth caps. `count: 'exact'` is one DB round trip each;
    // we accept that overhead because the alternative (post-hoc cleanup) is
    // worse if a client scripts thousands of submissions.
    const { count: roomCardCount } = await supabase
      .from('retro_cards').select('id', { count: 'exact', head: true }).eq('room_id', room_id);
    if ((roomCardCount ?? 0) >= MAX_CARDS_PER_ROOM) {
      return res.status(429).json({ error: 'This room has reached its card limit' });
    }
    const { count: playerCardCount } = await supabase
      .from('retro_cards').select('id', { count: 'exact', head: true })
      .eq('room_id', room_id).eq('player_id', player_id);
    if ((playerCardCount ?? 0) >= MAX_CARDS_PER_PLAYER) {
      return res.status(429).json({ error: 'You have reached your card limit for this room' });
    }

    const { data: card, error } = await supabase
      .from('retro_cards')
      .insert({ room_id, player_id, col, content: content.trim(), is_anonymous })
      .select().single();
    if (error) throw error;

    // XP: idempotent via UNIQUE(player_id, source, ref_id)
    await supabase.from('xp_transactions').upsert(
      { room_id, player_id, amount: 20, source: 'retro_card', ref_id: card.id },
      { onConflict: 'player_id,source,ref_id', ignoreDuplicates: true }
    );

    // Live broadcast. For anonymous cards we strip the author identity so
    // peers can't correlate the card to a roster slot via DevTools.
    const broadcast = is_anonymous
      ? { ...card, player_id: null, _player_id: null }
      : { ...card, _player_id: player_id };
    req.app.locals.io?.to(room_id).emit('card_added', broadcast);

    res.json({ card });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/cards/:id  — author removes their own card ──
// Only allowed during the submit phase. Cascades to votes/comments via FK rules
// in the schema. Reverses the +20 XP that was awarded on submit.
router.delete('/:id', async (req, res) => {
  try {
    const { room_id, player_id } = req.body;
    const card_id = req.params.id;
    if (!room_id || !player_id) return res.status(400).json({ error: 'room_id and player_id are required' });

    const auth = await assertRoomMember(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const { data: card } = await supabase
      .from('retro_cards').select('id, room_id, player_id').eq('id', card_id).maybeSingle();
    if (!card)                       return res.status(404).json({ error: 'Card not found' });
    if (card.room_id !== room_id)    return res.status(403).json({ error: 'Card does not belong to this room' });
    if (card.player_id !== player_id) return res.status(403).json({ error: 'You can only delete your own card' });

    const { data: room } = await supabase
      .from('rooms').select('retro_phase').eq('id', room_id).single();
    if (room?.retro_phase && room.retro_phase !== 'submit') {
      return res.status(403).json({ error: 'Cards can only be deleted during the submit phase' });
    }

    const { error: delErr } = await supabase.from('retro_cards').delete().eq('id', card_id);
    if (delErr) throw delErr;

    // Reverse the submit XP. Idempotent — also covers the case where the row
    // is missing (e.g., this is a retry).
    await supabase.from('xp_transactions').delete()
      .eq('player_id', player_id).eq('source', 'retro_card').eq('ref_id', card_id);

    req.app.locals.io?.to(room_id).emit('card_deleted', { card_id, player_id });
    res.json({ ok: true, card_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/rooms/:id/cards  — get all cards for a room ─────
router.get('/rooms/:id/cards', async (req, res) => {
  try {
    const { data: cards, error } = await supabase
      .from('retro_cards')
      .select('*, players(anon_handle, avatar, is_team_lead)')
      .eq('room_id', req.params.id).order('created_at');
    if (error) throw error;

    // Submit-phase content is visible to everyone now (live collaboration),
    // but anonymous cards must hide author identity (handle, avatar, AND
    // player_id) so a peer can't correlate via the roster.
    const safe = cards.map(c => c.is_anonymous
      ? { ...c, player_id: null, players: { anon_handle: 'Anonymous', avatar: '🕵️', is_team_lead: false } }
      : c);
    res.json({ cards: safe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/cards/:id/vote  — upvote a card ────────────────
router.post('/:id/vote', async (req, res) => {
  try {
    const { room_id, voter_id } = req.body;
    const card_id = req.params.id;
    if (!voter_id) return res.status(400).json({ error: 'voter_id is required' });

    const auth = await assertRoomMember(voter_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const { error } = await supabase
      .from('card_votes').insert({ room_id, card_id, voter_id });

    // 23505 = duplicate (unique violation) — silently ignored
    if (error && error.code !== '23505') throw error;

    // XP: idempotent — same (voter, card) never earns twice, even after unvote→revote
    await supabase.from('xp_transactions').upsert(
      { room_id, player_id: voter_id, amount: 5, source: 'retro_vote', ref_id: card_id },
      { onConflict: 'player_id,source,ref_id', ignoreDuplicates: true }
    );

    const { data: card } = await supabase
      .from('retro_cards').select('vote_count').eq('id', card_id).single();

    req.app.locals.io?.to(room_id).emit('card_voted', {
      card_id, voter_id, vote_count: card?.vote_count ?? 0,
    });
    res.json({ vote_count: card?.vote_count ?? 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/cards/:id/unvote  — remove a vote ──────────────
router.post('/:id/unvote', async (req, res) => {
  try {
    const { room_id, voter_id } = req.body;
    const card_id = req.params.id;
    if (!voter_id) return res.status(400).json({ error: 'voter_id is required' });

    const auth = await assertRoomMember(voter_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    // Only act if the voter actually had a vote. `count: 'exact'` lets us detect no-op deletes.
    const { count } = await supabase
      .from('card_votes').delete({ count: 'exact' })
      .eq('card_id', card_id).eq('voter_id', voter_id);

    // vote_count is maintained by trg_card_votes_sync on DELETE — no manual update.
    // Reverse XP only if we actually removed a row.
    if (count && count > 0) {
      await supabase.from('xp_transactions').delete()
        .eq('player_id', voter_id)
        .eq('source', 'retro_vote')
        .eq('ref_id', card_id);
    }

    const { data: card } = await supabase
      .from('retro_cards').select('vote_count').eq('id', card_id).single();
    const vote_count = card?.vote_count ?? 0;

    req.app.locals.io?.to(room_id).emit('card_voted', {
      card_id, voter_id, vote_count, removed: (count ?? 0) > 0,
    });
    res.json({ vote_count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/cards/:id/comment  — add a comment (lead only) ─
router.post('/:id/comment', async (req, res) => {
  try {
    const { room_id, player_id, content } = req.body;
    if (!content?.trim())     return res.status(400).json({ error: 'Content is required' });
    if (content.length > 300) return res.status(400).json({ error: 'Max 300 characters' });
    if (!player_id)           return res.status(400).json({ error: 'player_id is required' });

    const auth = await assertTeamLead(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const { data: player } = await supabase
      .from('players').select('anon_handle, avatar').eq('id', player_id).single();

    const { data: comment, error } = await supabase
      .from('card_comments')
      .insert({ room_id, card_id: req.params.id, author_player_id: player_id, content: content.trim() })
      .select().single();
    if (error) throw error;

    req.app.locals.io?.to(room_id).emit('card_commented', {
      card_id: req.params.id,
      comment_text: content.trim(),
      author_handle: player?.anon_handle ?? 'Lead',
      avatar: player?.avatar ?? '🦄',
      created_at: comment.created_at,
    });
    res.json({ comment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/cards/:id/comments ──────────────────────────────
router.get('/:id/comments', async (req, res) => {
  try {
    const { data: comments, error } = await supabase
      .from('card_comments')
      .select('*, players:author_player_id(anon_handle, avatar)')
      .eq('card_id', req.params.id).order('created_at');
    if (error) throw error;
    res.json({ comments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/cards/:id/discussed (lead only) ────────────────
router.post('/:id/discussed', async (req, res) => {
  try {
    const { room_id, player_id, is_discussed } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });
    const auth = await assertTeamLead(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    await supabase.from('retro_cards')
      .update({ is_discussed: is_discussed ?? true }).eq('id', req.params.id);
    req.app.locals.io?.to(room_id).emit('card_discussed', {
      card_id: req.params.id, is_discussed: is_discussed ?? true,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/cards/:id/duplicate (lead only) ────────────────
router.post('/:id/duplicate', async (req, res) => {
  try {
    const { room_id, player_id, is_duplicate } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });
    const auth = await assertTeamLead(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    await supabase.from('retro_cards')
      .update({ is_duplicate: is_duplicate ?? true }).eq('id', req.params.id);
    req.app.locals.io?.to(room_id).emit('card_duplicate', {
      card_id: req.params.id, is_duplicate: is_duplicate ?? true,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/cards/:id/move (lead only) ─────────────────────
router.post('/:id/move', async (req, res) => {
  try {
    const { room_id, player_id, col } = req.body;
    if (!player_id)                return res.status(400).json({ error: 'player_id is required' });
    if (!VALID_COLS.includes(col)) return res.status(400).json({ error: 'Invalid column' });

    const auth = await assertTeamLead(player_id, room_id);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    await supabase.from('retro_cards').update({ col }).eq('id', req.params.id);
    req.app.locals.io?.to(room_id).emit('card_moved', { card_id: req.params.id, col });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
