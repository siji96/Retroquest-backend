-- RetroQuest dev Supabase schema — reconstructed from backend code.
-- Idempotent: drops existing objects then recreates.

DROP VIEW  IF EXISTS v_room_leaderboard CASCADE;
DROP TABLE IF EXISTS audit_log         CASCADE;
DROP TABLE IF EXISTS admin_users       CASCADE;
DROP TABLE IF EXISTS session_summaries CASCADE;
DROP TABLE IF EXISTS xp_transactions   CASCADE;
DROP TABLE IF EXISTS chat_messages     CASCADE;
DROP TABLE IF EXISTS ice_answers       CASCADE;
DROP TABLE IF EXISTS ice_questions     CASCADE;
DROP TABLE IF EXISTS card_comments     CASCADE;
DROP TABLE IF EXISTS card_votes        CASCADE;
DROP TABLE IF EXISTS retro_cards       CASCADE;
DROP TABLE IF EXISTS players           CASCADE;
DROP TABLE IF EXISTS rooms             CASCADE;

-- ── rooms ────────────────────────────────────────────────────
CREATE TABLE rooms (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     TEXT NOT NULL UNIQUE,
  cfg_bots_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  cfg_room_open            BOOLEAN NOT NULL DEFAULT TRUE,
  cfg_ice_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  cfg_ice_timer_secs       INTEGER NOT NULL DEFAULT 10,
  cfg_retro_submit_secs    INTEGER NOT NULL DEFAULT 90,
  cfg_retro_submit_unlimited BOOLEAN NOT NULL DEFAULT FALSE,
  cfg_retro_vote_secs      INTEGER NOT NULL DEFAULT 60,
  phase                    TEXT,
  retro_phase              TEXT,
  team_lead_player_id      UUID,
  timer_phase              TEXT,
  timer_deadline_at        TIMESTAMPTZ,
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  ended_at                 TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── players ──────────────────────────────────────────────────
CREATE TABLE players (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  anon_handle    TEXT NOT NULL,
  avatar         TEXT NOT NULL,
  is_bot         BOOLEAN NOT NULL DEFAULT FALSE,
  is_team_lead   BOOLEAN NOT NULL DEFAULT FALSE,
  session_token  TEXT,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FK: rooms.team_lead_player_id → players.id (added after players table)
ALTER TABLE rooms
  ADD CONSTRAINT rooms_team_lead_fk
  FOREIGN KEY (team_lead_player_id) REFERENCES players(id) ON DELETE SET NULL;

-- ── retro_cards ──────────────────────────────────────────────
CREATE TABLE retro_cards (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       UUID NOT NULL REFERENCES rooms(id)   ON DELETE CASCADE,
  player_id     UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  col           TEXT NOT NULL,             -- 'went_well' | 'improve' | 'not_sure'
  content       TEXT NOT NULL,
  is_anonymous  BOOLEAN NOT NULL DEFAULT FALSE,
  vote_count    INTEGER NOT NULL DEFAULT 0,
  is_discussed  BOOLEAN NOT NULL DEFAULT FALSE,
  is_duplicate  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── card_votes ───────────────────────────────────────────────
CREATE TABLE card_votes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID NOT NULL REFERENCES rooms(id)       ON DELETE CASCADE,
  card_id    UUID NOT NULL REFERENCES retro_cards(id) ON DELETE CASCADE,
  voter_id   UUID NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (card_id, voter_id)
);

-- Keep retro_cards.vote_count in sync with card_votes
CREATE OR REPLACE FUNCTION fn_sync_card_vote_count() RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE retro_cards SET vote_count = vote_count + 1 WHERE id = NEW.card_id;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE retro_cards SET vote_count = GREATEST(0, vote_count - 1) WHERE id = OLD.card_id;
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_card_votes_sync
  AFTER INSERT OR DELETE ON card_votes
  FOR EACH ROW EXECUTE FUNCTION fn_sync_card_vote_count();

-- ── card_comments ────────────────────────────────────────────
CREATE TABLE card_comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id           UUID NOT NULL REFERENCES rooms(id)       ON DELETE CASCADE,
  card_id           UUID NOT NULL REFERENCES retro_cards(id) ON DELETE CASCADE,
  author_player_id  UUID NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
  content           TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── ice_questions ────────────────────────────────────────────
-- room_id IS NULL → built-in defaults (shared across all rooms)
CREATE TABLE ice_questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       UUID REFERENCES rooms(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  option_a      TEXT NOT NULL,
  option_b      TEXT NOT NULL,
  option_c      TEXT NOT NULL,
  option_d      TEXT NOT NULL,
  correct_idx   SMALLINT NOT NULL CHECK (correct_idx BETWEEN 0 AND 3),
  xp_value      INTEGER NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── ice_answers ──────────────────────────────────────────────
CREATE TABLE ice_answers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       UUID NOT NULL REFERENCES rooms(id)         ON DELETE CASCADE,
  player_id     UUID NOT NULL REFERENCES players(id)       ON DELETE CASCADE,
  question_id   UUID NOT NULL REFERENCES ice_questions(id) ON DELETE CASCADE,
  chosen_idx    SMALLINT NOT NULL,
  is_correct    BOOLEAN  NOT NULL,
  time_left_sec INTEGER  NOT NULL DEFAULT 0,
  xp_earned     INTEGER  NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, question_id)
);

-- ── xp_transactions ──────────────────────────────────────────
CREATE TABLE xp_transactions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID NOT NULL REFERENCES rooms(id)   ON DELETE CASCADE,
  player_id  UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  amount     INTEGER NOT NULL,
  source     TEXT    NOT NULL,   -- 'ice_correct' | 'retro_card' | 'retro_vote' | ...
  ref_id     UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotency: re-issuing the same action (card/vote/answer) must not double-credit XP.
  UNIQUE (player_id, source, ref_id)
);

-- ── chat_messages ────────────────────────────────────────────
CREATE TABLE chat_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID NOT NULL REFERENCES rooms(id)   ON DELETE CASCADE,
  player_id  UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── session_summaries ────────────────────────────────────────
CREATE TABLE session_summaries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id          UUID NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  total_cards      INTEGER NOT NULL DEFAULT 0,
  total_votes      INTEGER NOT NULL DEFAULT 0,
  mood_emoji       TEXT    NOT NULL DEFAULT '✨',
  mood_label       TEXT    NOT NULL DEFAULT 'Solid Sprint',
  ai_summary_text  TEXT,
  export_text      TEXT,
  committed_items  JSONB   NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── admin_users ──────────────────────────────────────────────
-- Replaces the old hardcoded client-side PIN with server-verified credentials.
CREATE TABLE admin_users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at  TIMESTAMPTZ
);

-- ── audit_log ────────────────────────────────────────────────
-- Append-only log of security-relevant events. Never rewritten or deleted by app code.
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,
  actor_kind  TEXT,          -- 'admin' | 'player' | 'system'
  actor_id    UUID,
  actor_name  TEXT,
  room_id     UUID,
  ip          TEXT,
  user_agent  TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX idx_audit_event_time        ON audit_log(event_type, created_at DESC);
CREATE INDEX idx_audit_room              ON audit_log(room_id, created_at DESC);
CREATE INDEX idx_rooms_code              ON rooms(code);
CREATE INDEX idx_players_room            ON players(room_id);
CREATE INDEX idx_players_session_token   ON players(session_token);
CREATE INDEX idx_retro_cards_room        ON retro_cards(room_id);
CREATE INDEX idx_card_votes_card         ON card_votes(card_id);
CREATE INDEX idx_card_votes_voter        ON card_votes(voter_id);
CREATE INDEX idx_card_comments_card      ON card_comments(card_id);
CREATE INDEX idx_ice_questions_room      ON ice_questions(room_id);
CREATE INDEX idx_ice_answers_room        ON ice_answers(room_id);
CREATE INDEX idx_ice_answers_player      ON ice_answers(player_id);
CREATE INDEX idx_xp_tx_room              ON xp_transactions(room_id);
CREATE INDEX idx_xp_tx_player            ON xp_transactions(player_id);
CREATE INDEX idx_chat_messages_room_time ON chat_messages(room_id, created_at DESC);

-- ── Leaderboard view ─────────────────────────────────────────
-- Consumed by /api/leaderboard/:room_id via supabase.from('v_room_leaderboard')
CREATE OR REPLACE VIEW v_room_leaderboard AS
SELECT
  p.room_id,
  p.id                         AS player_id,
  p.anon_handle,
  p.avatar,
  p.is_team_lead,
  COALESCE(SUM(x.amount), 0)::INTEGER AS xp_total,
  RANK() OVER (
    PARTITION BY p.room_id
    ORDER BY COALESCE(SUM(x.amount), 0) DESC, p.joined_at ASC
  ) AS rank
FROM players p
LEFT JOIN xp_transactions x
  ON x.player_id = p.id
GROUP BY p.id, p.room_id, p.anon_handle, p.avatar, p.is_team_lead, p.joined_at;
