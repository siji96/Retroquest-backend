// src/routes/cards.js
import { Router } from 'express';
import { supabase } from '../../config/supabase.js';

const router = Router();

// ── POST /api/cards  — submit a retro card ───────────────────
router.post('/', async (req, res) => {
  try {
    const { room_id, player_id, col, content, is_anonymous = false } = req.body;

    if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });
    if (content.length > 140) return res.status(400).json({ error: 'Max 140 characters' });

    const validCols = ['went_well', 'improve', 'not_sure'];
    if (!validCols.includes(col)) return res.status(400).json({ error: 'Invalid column' });

    const { data: card, error } = await supabase
      .from('retro_cards')
      .insert({ room_id, player_id, col, content: content.trim(), is_anonymous })
      .select()
      .single();

    if (error) throw error;

    // Log XP
    await supabase.from('xp_transactions').insert({
      room_id, player_id, amount: 20,
      source: 'retro_card', ref_id: card.id,
    });

    // Broadcast — mask content for other players during submit phase
    req.app.locals.io?.to(room_id).emit('card_added', {
      ...card,
      content: null,   // masked until vote phase
      _player_id: player_id,  // so submitter can see their own
    });

    res.json({ card });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/rooms/:id/cards  — get all cards for a room ─────
router.get('/rooms/:id/cards', async (req, res) => {
  try {
    const { phase } = req.query; // 'submit' | 'vote' | 'review'
    const { data: cards, error } = await supabase
      .from('retro_cards')
      .select('*, players(anon_handle, avatar, is_team_lead)')
      .eq('room_id', req.params.id)
      .order('created_at');

    if (error) throw error;

    // Mask content during submit phase (each player sees their own)
    const requestingPlayerId = req.query.player_id;
    const masked = (phase === 'submit')
      ? cards.map(c => c.player_id === requestingPlayerId
          ? c
          : { ...c, content: null })
      : cards;

    // Anonymise author info for anonymous cards
    const safe = masked.map(c => c.is_anonymous
      ? { ...c, players: { anon_handle: 'Anonymous', avatar: '🕵️', is_team_lead: false } }
      : c);

    res.json({ cards: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/cards/:id/vote  — upvote a card ────────────────
router.post('/:id/vote', async (req, res) => {
  try {
    const { room_id, voter_id } = req.body;
    const card_id = req.params.id;

    const { error } = await supabase
      .from('card_votes')
      .insert({ room_id, card_id, voter_id });

    // ignore duplicate vote (unique constraint)
    if (error?.code !== '23505' && error) throw error;

    // Log XP for first-time vote
    if (!error) {
      await supabase.from('xp_transactions').insert({
        room_id, player_id: voter_id, amount: 5,
        source: 'retro_vote', ref_id: card_id,
      });
    }

    // Get updated vote count (trigger already updated it)
    const { data: card } = await supabase
      .from('retro_cards').select('vote_count').eq('id', card_id).single();

    req.app.locals.io?.to(room_id).emit('card_voted', {
      card_id, voter_id, vote_count: card?.vote_count ?? 0,
    });

    res.json({ vote_count: card?.vote_count ?? 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/cards/:id/comment  — add a comment ─────────────
router.post('/:id/comment', async (req, res) => {
  try {
    const { room_id, player_id, content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });
    if (content.length > 300) return res.status(400).json({ error: 'Max 300 characters' });

    // Verify commenter is team lead
    const { data: player } = await supabase
      .from('players').select('is_team_lead, anon_handle, avatar').eq('id', player_id).single();
    if (!player?.is_team_lead) {
      return res.status(403).json({ error: 'Only the Team Lead can add comments' });
    }

    const { data: comment, error } = await supabase
      .from('card_comments')
      .insert({ room_id, card_id: req.params.id, author_player_id: player_id, content: content.trim() })
      .select()
      .single();

    if (error) throw error;

    req.app.locals.io?.to(room_id).emit('card_commented', {
      card_id: req.params.id,
      comment_text: content.trim(),
      author_handle: player.anon_handle,
      avatar: player.avatar,
      created_at: comment.created_at,
    });

    res.json({ comment });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cards/:id/comments ──────────────────────────────
router.get('/:id/comments', async (req, res) => {
  try {
    const { data: comments, error } = await supabase
      .from('card_comments')
      .select('*, players:author_player_id(anon_handle, avatar)')
      .eq('card_id', req.params.id)
      .order('created_at');
    if (error) throw error;
    res.json({ comments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/cards/:id/discussed ────────────────────────────
router.post('/:id/discussed', async (req, res) => {
  try {
    const { room_id, is_discussed } = req.body;
    await supabase.from('retro_cards')
      .update({ is_discussed: is_discussed ?? true }).eq('id', req.params.id);
    req.app.locals.io?.to(room_id).emit('card_discussed', {
      card_id: req.params.id, is_discussed: is_discussed ?? true,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/cards/:id/duplicate  — mark/unmark duplicate ───
router.post('/:id/duplicate', async (req, res) => {
  try {
    const { room_id, is_duplicate } = req.body;
    await supabase.from('retro_cards')
      .update({ is_duplicate: is_duplicate ?? true }).eq('id', req.params.id);
    req.app.locals.io?.to(room_id).emit('card_duplicate', {
      card_id: req.params.id, is_duplicate: is_duplicate ?? true,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/cards/:id/move  — move to a different lane ─────
router.post('/:id/move', async (req, res) => {
  try {
    const { room_id, col } = req.body;
    const validCols = ['went_well', 'improve', 'not_sure'];
    if (!validCols.includes(col)) return res.status(400).json({ error: 'Invalid column' });

    await supabase.from('retro_cards').update({ col }).eq('id', req.params.id);

    req.app.locals.io?.to(room_id).emit('card_moved', { card_id: req.params.id, col });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
