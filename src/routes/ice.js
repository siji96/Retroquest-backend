// src/routes/ice.js
import { Router } from 'express';
import { supabase } from '../../config/supabase.js';

const router = Router();

// ── GET /api/ice/questions/:room_id ──────────────────────────
// Returns custom questions for the room, or the 5 built-in defaults
router.get('/questions/:room_id', async (req, res) => {
  try {
    const room_id = req.params.room_id;

    // Try custom questions for this room first
    const { data: custom } = await supabase
      .from('ice_questions')
      .select('*')
      .eq('room_id', room_id)
      .order('created_at');

    if (custom && custom.length > 0) {
      return res.json({ questions: custom, source: 'custom' });
    }

    // Fall back to built-in defaults (room_id IS NULL)
    const { data: defaults, error } = await supabase
      .from('ice_questions')
      .select('*')
      .is('room_id', null)
      .limit(5);

    if (error) throw error;
    res.json({ questions: defaults, source: 'default' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/ice/questions  — save custom questions ─────────
router.post('/questions', async (req, res) => {
  try {
    const { room_id, questions } = req.body; // questions: array of {q, opts:[a,b,c,d], correct, xp}

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'questions array is required' });
    }
    if (questions.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 custom questions per room' });
    }

    const rows = questions.map(q => ({
      room_id,
      question_text: q.q,
      option_a:      q.opts[0] ?? '',
      option_b:      q.opts[1] ?? '',
      option_c:      q.opts[2] ?? '',
      option_d:      q.opts[3] ?? '',
      correct_idx:   q.correct,
      xp_value:      q.xp ?? 100,
    }));

    // Delete existing custom questions for this room first
    await supabase.from('ice_questions').delete().eq('room_id', room_id);

    const { data, error } = await supabase.from('ice_questions').insert(rows).select();
    if (error) throw error;
    res.json({ questions: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/ice/answer  — record a player's answer ─────────
router.post('/answer', async (req, res) => {
  try {
    const { room_id, player_id, question_id, chosen_idx, time_left_sec = 0 } = req.body;

    const { data: q, error: qErr } = await supabase
      .from('ice_questions').select('correct_idx, xp_value').eq('id', question_id).single();
    if (qErr || !q) return res.status(404).json({ error: 'Question not found' });

    const is_correct = chosen_idx === q.correct_idx;
    const base_xp    = q.xp_value ?? 100;
    const xp_earned  = is_correct ? (base_xp + time_left_sec * 10) : 0;

    // Upsert — ignore duplicate if player already answered
    const { data: ans } = await supabase
      .from('ice_answers')
      .upsert({ room_id, player_id, question_id, chosen_idx, is_correct, time_left_sec, xp_earned },
               { onConflict: 'player_id,question_id', ignoreDuplicates: true })
      .select().single();

    // Log XP
    if (xp_earned > 0 && ans) {
      await supabase.from('xp_transactions').insert({
        room_id, player_id, amount: xp_earned,
        source: 'ice_correct', ref_id: ans.id,
      });
    }

    // Broadcast answer event (includes player pick for Kahoot display)
    req.app.locals.io?.to(room_id).emit('ice_answered', {
      player_id, question_id, chosen_idx, is_correct, xp_earned,
    });

    res.json({ is_correct, xp_earned });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
