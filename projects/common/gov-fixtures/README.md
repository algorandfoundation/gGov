# gov-fixtures

JSON fixtures captured from the **old governance API** (read-only Cloudflare
replacement for the legacy Django platform), mirroring the **last voting
period**:

- Period: `governance-period-15` — "Governance Period 15"
- Voting session: `period-15-voting-session-1` — *xGov Council Election 2025*
  (22 candidate topics, each with Yes / No / Abstain options)

Source API: `https://governance.algorand.foundation/api`
(repo: `cloudflare-gov-api`). Captured 2026-06-08. Data is frozen, so these
responses are stable.

## Files → endpoint

| File | Endpoint | Storage | Notes |
|------|----------|---------|-------|
| `periods.json` | `GET /api/periods/` | KV | All 15 periods, DRF-paginated envelope |
| `period-15.json` | `GET /api/periods/governance-period-15/` | KV | Period detail incl. nested voting session summary |
| `voting-session-period-15-voting-session-1.json` | `GET /api/voting-sessions/period-15-voting-session-1/` | KV | **The core fixture** — full session with all 22 topics + topic_options |
| `period-15-accepted-assets.json` | `GET /api/periods/governance-period-15/accepted-assets/` | KV | Paginated (default page) |
| `statistics.json` | `GET /api/periods/statistics/` | KV | Cross-period statistics |
| `period-15-governors-page1.json` | `GET /api/periods/governance-period-15/governors/?limit=5` | D1 | First page sample; full count in `.count` |
| `period-15-governor-detail-sample.json` | `GET /api/periods/governance-period-15/governors/{address}/` | D1+KV | Governor who voted; `voting_session_history` expanded |
| `period-15-governor-activities-sample.json` | `GET /api/periods/governance-period-15/governors/{address}/activities/` | D1 | Same governor |
| `topic-option-votes-sample.json` | `GET /api/topic-options/{id}/votes/?limit=20` | D1 | First page; `.count` is the true total |
| `transaction-sample.json` | `GET /api/transactions/{transaction_id}/` | D1 | A vote transaction + its governor activity |

## Sampled identifiers

D1-backed fixtures are **first-page samples**, not full mirrors (governors
≈1394 rows, votes per option in the hundreds). The `count` field on each
paginated response gives the real total; `next` is non-null when more pages
exist.

- Sample governor address: `72LZKN7AOGKGOLIKPPF5RDAASVN5UPV4BIDLDFAOZCWW2N24K2U4NDSJNY`
- Sample topic-option id: `3672145628301864506` (topic "Robbie Baxter" → "Yes", `count` = 917)
- Sample transaction id: `V7TYKRDC2ASBBMNGQSG7WGGSJPERNTBJIURTJNTTJVCKSRWR7MPA`

To regenerate or extend, re-run the same `curl`s against the base URL above and
pretty-print through `python3 -m json.tool`.
