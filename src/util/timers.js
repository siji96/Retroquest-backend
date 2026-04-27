// Server-side phase timers.
// Single source of truth for "how much time is left in phase X for room Y".
// Also persists deadlines so they survive a backend restart (T-3).
import { supabase } from '../../config/supabase.js';

// room_id → { iv, deadlineMs, phase, maxSecs }
const roomTimers = new Map();

function clearRoomTimer(room_id) {
  const t = roomTimers.get(room_id);
  if (t) { clearInterval(t.iv); roomTimers.delete(room_id); }
}

function tickOnce(io, room_id) {
  const t = roomTimers.get(room_id);
  if (!t) return;
  const remaining = Math.max(0, Math.round((t.deadlineMs - Date.now()) / 1000));
  io.to(room_id).emit('timer_tick', { timer: remaining, phase: t.phase, max: t.maxSecs });
  if (remaining <= 0) {
    clearRoomTimer(room_id);
    supabase.from('rooms').update({ timer_phase: null, timer_deadline_at: null })
      .eq('id', room_id).then(() => {}, () => {});
    io.to(room_id).emit('timer_end', { phase: t.phase });
  }
}

export function startRoomTimer(io, room_id, phase, duration_secs) {
  // No-op if a timer for this exact phase is already running. Prevents host
  // refresh / double-emit from resetting a mid-phase clock back to full duration
  // (participants would see the timer jump backwards).
  const existing = roomTimers.get(room_id);
  if (existing && existing.phase === phase) return;
  clearRoomTimer(room_id);
  const deadlineMs = Date.now() + duration_secs * 1000;
  const iv = setInterval(() => tickOnce(io, room_id), 1000);
  roomTimers.set(room_id, { iv, deadlineMs, phase, maxSecs: duration_secs });

  // Emit the initial tick BEFORE the DB round-trip so clients get instant feedback.
  io.to(room_id).emit('timer_tick', { timer: duration_secs, phase, max: duration_secs });

  // Persist in background; failure just means we can't resume across restart.
  supabase.from('rooms').update({
    timer_phase: phase,
    timer_deadline_at: new Date(deadlineMs).toISOString(),
  }).eq('id', room_id).then(() => {}, (err) => console.warn('[timer] persist failed:', err?.message));
}

export function stopRoomTimerEarly(io, room_id, phase, reason = 'early') {
  const t = roomTimers.get(room_id);
  if (!t || t.phase !== phase) return false;
  clearRoomTimer(room_id);
  supabase.from('rooms').update({ timer_phase: null, timer_deadline_at: null })
    .eq('id', room_id).then(() => {}, () => {});
  io.to(room_id).emit('timer_end', { phase, reason });
  return true;
}

export function addTime(io, room_id, delta_seconds) {
  const t = roomTimers.get(room_id);
  if (!t) return false;
  t.deadlineMs = Math.max(Date.now(), t.deadlineMs + delta_seconds * 1000);
  const remaining = Math.max(0, Math.round((t.deadlineMs - Date.now()) / 1000));
  // Keep maxSecs >= remaining so the progress ring never reports timer > max
  // (which produces a negative SVG stroke offset and a broken arc on the client).
  if (remaining > t.maxSecs) t.maxSecs = remaining;

  supabase.from('rooms').update({
    timer_deadline_at: new Date(t.deadlineMs).toISOString(),
  }).eq('id', room_id).then(() => {}, () => {});

  io.to(room_id).emit('timer_tick', { timer: remaining, phase: t.phase, max: t.maxSecs });
  if (remaining <= 0) {
    clearRoomTimer(room_id);
    supabase.from('rooms').update({ timer_phase: null, timer_deadline_at: null })
      .eq('id', room_id).then(() => {}, () => {});
    io.to(room_id).emit('timer_end', { phase: t.phase, reason: 'add_time' });
  }
  return true;
}

export function getRoomTimer(room_id) {
  const t = roomTimers.get(room_id);
  if (!t) return null;
  return {
    phase: t.phase,
    maxSecs: t.maxSecs,
    timer: Math.max(0, Math.round((t.deadlineMs - Date.now()) / 1000)),
  };
}

// Called once at boot: resume any active timers that were persisted.
export async function resumePersistedTimers(io) {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from('rooms')
    .select('id, timer_phase, timer_deadline_at, cfg_ice_timer_secs, cfg_retro_submit_secs, cfg_retro_vote_secs')
    .not('timer_phase', 'is', null).gt('timer_deadline_at', nowIso);

  for (const r of (data ?? [])) {
    const remaining = Math.round((new Date(r.timer_deadline_at).getTime() - Date.now()) / 1000);
    if (remaining <= 0) continue;
    const maxMap = {
      ice: r.cfg_ice_timer_secs,
      retro_submit: r.cfg_retro_submit_secs,
      retro_vote: r.cfg_retro_vote_secs,
    };
    const maxSecs = maxMap[r.timer_phase] ?? remaining;
    clearRoomTimer(r.id);
    roomTimers.set(r.id, {
      iv: setInterval(() => tickOnce(io, r.id), 1000),
      deadlineMs: new Date(r.timer_deadline_at).getTime(),
      phase: r.timer_phase,
      maxSecs,
    });
    console.log(`[timer] resumed ${r.timer_phase} ${remaining}s for room ${r.id}`);
  }
}
