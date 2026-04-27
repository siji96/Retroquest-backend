# RetroQuest — Bug Report (2026-04-21)

Found via integration test (`dev-db/test-flow.js`) + code audit of backend routes, socket handlers, and `Retroquest/index.html`.

---

## 🔴 Top 5 to fix first

| # | Severity | Bug | Where |
|---|----------|-----|-------|
| 1 | CRITICAL | **Card content leaks during submit phase** — `card_added` socket broadcasts full card to everyone | `Retroquest-backend/src/routes/cards.js:33-36` |
| 2 | HIGH | **No host auth on socket events** — any participant can force `phase_change`, `start_timer`, `retro_phase_change`, `ice_next_q`, `host_transferred` | `Retroquest-backend/src/socket/handlers.js:64,90,101,111,118,159,165,179` |
| 3 | HIGH | **Host gets stuck on Ice reveal** — if host skips timer or doesn't answer, participants see reveal but host screen freezes | `Retroquest/index.html:1452-1461` |
| 4 | HIGH | **Socket reconnect doesn't rejoin room** — after WiFi blip, client gets no more `timer_tick`/`card_added`/chat etc for rest of session | `Retroquest/index.html:54-67` (missing `reconnect` handler) |
| 5 | HIGH | **Ice XP cheatable** — client sends `time_left_sec`, backend multiplies by 10. POST `{time_left_sec: 999}` → thousands of XP | `Retroquest-backend/src/routes/ice.js:75-95` |

---

## Findings by area

### Timer
- **T-1** HIGH — Host stuck on Ice reveal (`index.html:1452-1461`)
- **T-2** HIGH — Reconnect doesn't rejoin room (`index.html:54-67`)
- **T-3** MEDIUM — `roomTimers` in-memory Map lost on backend restart (`handlers.js:6-34`)
- **T-4** LOW — `add_time` negative delta → `timer:-1` tick before `timer_end` (`handlers.js:101-108`)
- **T-5** LOW — Dead `timer_updated` handler with loop hazard (`index.html:1481-1486`)

### Cards / Votes
- **CV-1** CRITICAL — Submit-phase card content broadcast to everyone via `card_added` (`cards.js:33-36`)
- **CV-2** HIGH — `/unvote` decrements count even when caller never voted (`cards.js:111-137`)
- **CV-3** HIGH — Vote (trigger) + unvote (manual update) race — final count drifts from actual vote rows (`cards.js:111-137`)
- **CV-4** MEDIUM — Unvote doesn't reverse the +5 XP row → leaderboard inflated (`cards.js:111-137` vs `:89-93`)
- **CV-5** MEDIUM — Local vote state not rolled back if POST fails (`index.html:2503-2531`)
- **CV-6** LOW — `myVotes` grows indefinitely across games (stale local IDs) (`index.html:2503-2531`)
- **XP-dup** MEDIUM — Vote→unvote→revote double-credits +5 XP (observed in test: alice=180 instead of 175) (`cards.js:89-93`)

### Phase transitions
- **P-1** HIGH — Refresh during retro vote phase re-enters submit UI; backend accepts the late card (`index.html:1904-1925, 2357-2368`)
- **P-2** MEDIUM — Refresh into `results` shows empty leaderboard (no data fetch) (`index.html:1947-1948`)
- **P-3** MEDIUM — Host "Next Phase" button doesn't stop the old timer (`index.html:2848-2854`)
- **P-4** MEDIUM — Participants transition to retro ~1.8s before host → blank screen with no timer (`index.html:2342-2352`)
- **P-5** LOW — Double-render on ice question advance (participant setTimeout + host broadcast both call `loadQ`) (`index.html:2311-2328`)

### Auth / Host
- **A-1** HIGH — No `is_team_lead` check on any socket events (`handlers.js:64,90,101,111,118,159,165,179`)
- **A-2** HIGH — `/api/rooms/:id/{lock,phase,end,start}` have no auth check (`rooms.js:150-236`)
- **A-3** MEDIUM — Socket `review_navigate` bypasses REST route's host guard (`handlers.js:153-156`)
- **A-4** MEDIUM — Ice XP cheatable via client-supplied `time_left_sec` (`ice.js:75-95`)
- **A-5** LOW — `player_left_voluntary` hard-deletes player row → rejoin gets new identity + cascade data loss (`handlers.js:171-176`)

### Session / Reconnect
- **SR-2** MEDIUM — Client-side host election race → multiple "You are Team Lead" banners (`index.html:1631-1677`)
- **SR-3** MEDIUM — New host promotion fails silently if elected client goes offline mid-promotion (`index.html:1657-1663`)
- **SR-4** LOW — Refresh into review phase → comments never refetched (`index.html:1926-1946`)

### Frontend state
- **FS-1** HIGH — Leaderboard XP inconsistent — others' retro/vote XP never broadcast; only ice XP is shared (`index.html:2875-2909, 1328-1342, 2859-2864`)
- **FS-2** MEDIUM — `playAgain` doesn't call `leaveRoom` → stale socket listeners, session, XP state carry over (`index.html:2991-2998`)
- **FS-3** MEDIUM — `leaveRoom` never disconnects socket; events from old room can hit new room state (`index.html:1585-1605`)
- **FS-4** MEDIUM — `G.ice._max` not reset in `loadQ` → timer ring offset on custom-config questions (`index.html:2156-2163`)
- **FS-5** LOW — `exportExcel` and `admExport` have inconsistent duplicate handling / no comments sheet (`index.html:2931-2945, 3285-3295`)

### Realtime sync
- **RT-1** HIGH — Duplicate `POST /api/ice/answer` still broadcasts `ice_answered` → peers double-count answers and XP (`ice.js:73-109`)
- **RT-2** HIGH — `/api/rooms/:id/end` never invoked by frontend; rooms stay `is_active=true` forever (`rooms.js:205-236`)
- **RT-3** MEDIUM — `host_transferred` socket doesn't update `players.is_team_lead` in DB (`handlers.js:179-182`)
- **RT-4** LOW — Two chat paths (socket emit-only vs REST persist-and-emit) — inconsistent (`handlers.js:138-150` vs `chat.js:25-56`)
- **RT-chat-order** MEDIUM — *(found in test)* Socket chat messages arrive out of order under rapid send; handler awaits DB lookup per message → emits interleaved (`handlers.js:138-150`)

### Other
- **O-1** MEDIUM — Supabase anon key hardcoded in HTML + admin PIN `1234` client-side → admin auth trivially bypassable (`index.html:12-13, 3003`)
- **O-2** MEDIUM — 20s disconnect grace shorter than client `reconnectionAttempts` × backoff → spurious "player left" + new-identity pop-back (`handlers.js:194-206` vs `index.html:58-61`)
- **O-3** LOW — Local fallback has only 5 hardcoded questions (`index.html:2094-2102`)
- **O-4** LOW — `committed_items` serialized inconsistently (JSON string vs array) between admin direct-write and backend `/end` (`index.html:3092` vs `rooms.js:208, 227-228`)

---

## Known-bug recap (vs. Session 3 list)

| Known issue | Status |
|---|---|
| Backend-driven timer, no drift | PARTIAL — works live but fails on reconnect (T-2) and restart (T-3) |
| Ice stop early / reveal delay / 0-XP no-answer | FIXED for participants; HOST still stuck (T-1) |
| Retro submit content not leaked | NOT FIXED — socket path leaks (CV-1) |
| Vote/unvote toggle | Vote path FIXED, unvote broken (CV-2/3/4) |
| Excel export | Works, small gaps (FS-5, O-4) |
| Host authority on socket events | NOT FIXED (A-1, A-2, A-3, A-4) |
| `socket.off()` before `on()` | FIXED (`index.html:1249-1255`) |
| Session token dedup | FIXED (`rooms.js:84-100`) |

---

## Test passes (integration test)

30+ checks passed including: session_token dedup, room lock enforcement, team-lead comment 403, submit content masking (via GET endpoint), vote unique constraint, ice XP 150 for correct + 0 for wrong, leaderboard totals, review navigate host-gating.
