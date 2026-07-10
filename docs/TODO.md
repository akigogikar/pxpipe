# pxpipe — Consolidated TODO (single source of truth)

Consolidated 2026-07-10 during the multi-branch merge/cleanup session. All prior
branch work is merged into `main`; feature branches are deleted. Work the list
top-to-bottom; check items off and commit per item.

## Provenance / past-chat context

| Source | Where it came from |
| --- | --- |
| `docs/IMPROVEMENT_PLAN.md` (18 ranked initiatives, Quick Wins, Eval Agenda, Privacy Posture, Metrics) | Branch `claude/arbitrage-onenewai-api-aec773`, PR #1, workflow `wf_1f2dd924-223`, session `local_18a9eba9-aba9-486d-afbb-5d77427552df` — "Arbitrage product with OneNewAI API" (2026-07-10) |
| `docs/ADAPTIVE_CPT_PLAN.md` (Task #18 detail plan) | Authored on `main` (commit `99be6b0` era); no indexed chat session — plan doc is self-contained |
| `eval/glyph-matrix/PLAN.md` (Task #7, paused for usage budget) | Authored on `main`; no indexed chat session — banked state in the doc |
| `FINDINGS.md` §"Open threads" (research, parked 2026-07-05) | Authored on `main` across the eval sessions logged inside FINDINGS.md itself |
| This file / branch consolidation | Current session (branch merge `43ee963`, this TODO) |

## P0 — Correctness, privacy, security (do first)

- [ ] **1. Fail closed on provider-prefixed passthrough** — stop the OpenAI-credential-to-Anthropic leak; 502 before touching headers/body when `config.provider !== 'cloudflare-ai-gateway'`; regression test. (IMPROVEMENT_PLAN §1)
- [ ] **2. Stop the Cloudflare Worker shipping transformed prompt bodies off-machine** — default `PXPIPE_TRACK` to metadata-only; README/worker.ts carve-out. (§2)
- [ ] **3. Fix baseline.ts honesty bugs** — 1h cache-create rate and probe-miss savings collapse. (§3)
- [ ] **4. Verify gpt-5.6 vision profile; lock model scope to vetted exact ids** — drop the `startsWith` alias. (§4)
- [ ] **9. Dashboard CSRF protection** on state-changing endpoints — shared-secret header or strict Origin check; JSON-only. (§9)
- [ ] **QW: umask 0o077 around openssl key writes** in `mitm-ca.ts:65-91` with finally-restore. (Quick Wins)
- [ ] **QW: 413 request-body cap (~25-32MB)** before `arrayBuffer()` in `proxy.ts:725`. (Quick Wins)

## P1 — Honest accounting & fidelity

- [ ] **5. Partition dashboard $ by provider**; pin price constants with regression tests. (§5)
- [ ] **6. Request-level image ceiling** — reminder cap, 100-image budget, history cap. (§6)
- [ ] **7. Render system/tool slab on the anti-aliased atlas**; resolve atlas-gray bundling. Gate on the slab-shaped OCR eval (AA ≥98.95%). (§7 + Eval Agenda; related: `eval/glyph-matrix/PLAN.md`)
- [ ] **8. Swap production fact-sheet callers to the page-aware variant**; surface dropped counts. (§8)
- [ ] **10. Decouple reminder/tool_result compression from the static-slab's own gates.** (§10)
- [ ] **11. Wire the built 4xx-body retention lifecycle** — prune, rotation, opt-in (`PXPIPE_TRACK_BODY_SAMPLES` off by default), secret redaction. (§11 + Privacy Posture)

## P2 — Measurement & evals

- [ ] **12. Fidelity evals in CI**; re-validate shipped render style on L2; fix reproducibility (incl. QW: fix `eval/verbatim-15/run.sh` cwd + `/tmp/verb25` dependency). (§12)
- [ ] **13. Surface fidelity signals and passthrough reasons** in stats + dashboard. (§13)
- [ ] **14. Lower Responses-API built-in item types; guard images** so Codex/MCP history collapses again. (§14)
- [ ] **15. Per-bucket adaptive cpt into the reminder/tool_result gate; fix phantom-header token count.** Detailed design already written: `docs/ADAPTIVE_CPT_PLAN.md` (Task #18) — implement per its Phasing §6. (§15)
- [ ] **16. sharp.ts exact-string protection in production behind an eval gate** — restores hex/UUID/path recall (measured 6/15). (§16 + Eval Agenda)
- [ ] **17. Network-edge robustness** — abort propagation, honest stream errors, multi-host MITM (fork branch `feat/mitm-mode` folded here). (§17)
- [ ] **18. GPT deferred savings** — realistic gate height, schema-delta tool docs, history rollup. (§18)
- [ ] **Glyph confusion matrix + render-style A/B (Task #7)** — PAUSED for usage budget; resume when budget allows, per decision criteria in `eval/glyph-matrix/PLAN.md`.

## P3 — Quick-win hygiene (batchable, from IMPROVEMENT_PLAN §Quick Wins)

- [ ] `runHistoryCollapse` helper for the duplicated call sites (transform.ts:1432 / :2132)
- [ ] Churn-detector per-process instance id instead of `'global'` fallback (transform.ts:1639)
- [ ] `GPT_MAX_HEIGHT_PX 1932→1920` + regression assertion
- [ ] Shared `DEFAULT_MODEL_BASES` constant for export.ts / render.ts / applicability.ts
- [ ] shrinkColsToContent JSDoc + `docs/RENDER_SIZING.md` refresh; drop stale eslint-disable
- [ ] `docs/TRANSFORM_INFO.md` §8 → pointer to `docs/CACHING_AND_SAVINGS.md`
- [ ] Drop stale "EXPECTED FAIL today" describe titles (anthropic/gpt cache-align tests)
- [ ] Delete dead SessionTotals Map / baselineWarmth / current-session.json endpoint
- [ ] Shared `waitFor` test helper replacing ~30 fixed setTimeouts

## Parked research (FINDINGS.md — revisit only with new capacity evidence)

- Verbatim misreads are capacity-bound; open threads banked in FINDINGS.md §"Open threads" (2026-07-05). Do not reopen without a new model generation or the DeepSeek-OCR-style encoder direction.
