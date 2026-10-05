# AGENTS.md

This file is the shared collaboration contract for Codex, Claude Code, and human contributors.

---

## 0. Project Context

> At project creation, the agent should fill or update this section from the user's initial project description.
> If key details are missing, ask concise follow-up questions before implementation.

> Source: `docs/plans/active-plan.md` (approved design baseline, 2026-10-05). If this section and the blueprint disagree, the blueprint wins until this section is updated.

- **Project name:** Morrow — Event-Driven Investment OS
- **Project goal:** Build an auditable investment research loop: `Discovery → Events → Research → Underwriting → Thesis → Strategy → Risk → Execution → Monitoring → Attribution → Calibration`. First market is Solana meme, micro-cap, and emerging-narrative tokens. The MVP (milestones M0–M4) ends at real data + research + a Paper trading loop. It is meant to prove the data, research, decision, and accounting flow — not profitability or unattended trading.
- **Target users:** Personal use. Single tenant, single operator.
- **Tech stack:**
  - TypeScript on Node.js 24 LTS; npm workspaces with a committed lockfile
  - Backend: Fastify with explicit application services; one codebase, two entrypoints (API and background worker)
  - Frontend: React + Vite, built to static files served by the local API
  - Database: local PostgreSQL 17 via `pg`, versioned SQL migrations
  - Queue: PostgreSQL jobs + transactional outbox/inbox (at-least-once, consumer dedupe)
  - Layout: `apps/runtime`, `apps/web`, `packages/core` (modular monolith)
  - Not used: Kafka, Redis, RabbitMQ, Temporal, graph DB, vector DB, microservices, Next.js, paid LLM APIs, Docker as a prerequisite
- **High-risk areas** (auth / DB schema / payments / deployment / etc.):
  - Live-mode gating: all live limits are 0. No signer, private key, or funded wallet exists in M0–M4, and nothing may promote itself to a live mode.
  - DB schema and migrations, especially append-only tables (raw observations, audit, ledger).
  - Paper accounting: token amounts are integer strings and money/ratios are explicit-precision decimals. Never JavaScript floats.
  - Provider credentials: secret redaction in logs, never in the frontend, a ResearchPacket, or Git.
  - Quota and budget enforcement: no x402 or automatic payment, no paid LLM API, no bypassing rate limits or switching accounts to dodge them.
  - Untrusted external content (token metadata, news, websites, model output) reaching AI import or strategy input.
  - Local API exposure: loopback only, Host/Origin validation, session/CSRF protection on writes.
- **Architecture constraints:**
  - Fixed pipeline: provider adapters → raw evidence → canonical events → discovery → research packet → versioned thesis → deterministic strategy → risk/reservation → Paper ledger → monitoring/attribution/evaluation.
  - Provider-specific types must not leak into `packages/core`.
  - AI only researches and proposes. It never trades, signs, changes risk limits, or promotes a strategy.
  - Assets are identified by `namespace + network + reference` (Solana reference = mint). Never by symbol.
  - Store time in UTC, display in Asia/Taipei. Keep `event_time`, `observed_at`, and `available_at` separate; never substitute fetch time for a missing source time.
  - `KNOWN / UNKNOWN / UNSUPPORTED / STALE / CONFLICTING` must stay distinguishable. Missing data is not zero.
  - Paper and live records are fully separated. No fake signatures; a quote model is never labelled as an on-chain fill.
  - Schema changes are additive migrations with explicit converters. Never silently rewrite past decisions.
  - Never expose `raw_sign_transaction`, `send_arbitrary_transaction`, or `export_private_key`.
  - No new service cost in M0–M4. M5–M8 are roadmap only and are not authorized.
- **Verification commands:** Not available yet. They are added with the M0 scaffolding and recorded here once they exist.

---

## 0.1 Current Technical State

> Fill only after the project has stable facts worth preserving.

- **Main entry points:**
- **Storage / data model:**
- **Test coverage:**
- **Deployment / cache notes:**

---

## 1. Execution Modes

Agents must operate in one of two modes:

### Mode A: Planning / Architecture
- Analyze the request
- Propose structure and changes
- Outline risks and next steps
- **DO NOT modify files yet**

### Mode B: Implementation
- Apply changes strictly based on the agreed plan
- Avoid introducing new design decisions mid-implementation

If the mode is unclear, default to **Mode A first**.

For clear low-risk tasks such as typo fixes, focused tests, or small documentation updates, agents may proceed in **Mode B** directly while still summarizing the change afterward.

---

## 2. Scope Control Rules

Agents must strictly limit changes to the requested scope.

Do NOT:
- Refactor unrelated files "while you are here"
- Rename or restructure directories outside the task scope
- Modify styling, formatting, or naming conventions globally without instruction

If an improvement is detected outside scope:
- Propose it instead of implementing it

---

## 3. Prohibited Behaviors

Do not:
- Silently replace or rewrite major files without instruction
- Mix a feature task with broad unrelated cleanup
- Sneak in schema, auth, or deployment edits under an unrelated feature PR
- Turn the repo into multiple conflicting architectural styles

---

## 4. Change Requirements

Every substantial change must make these clear:
- What changed
- Why this change was made
- What risks remain
- What the next recommended step is

The goal is handoff clarity, not just code delivery.

---

## 5. Canonical Baseline & Editing Rules

All changes must treat the current repository content as the canonical baseline.

- Preserve existing language, structure, and major content unless explicitly instructed otherwise
- Prefer **additive edits** over rewrites
- Do NOT replace entire files unless explicitly requested
- Do NOT reorganize large sections without clear instruction

---

## 6. Handoff Friendliness

Code and documentation should be written so another agent or human can continue without relying on private memory or one-off chat context.

- Write module responsibilities clearly
- Keep comments focused and actionable
- Make placeholders explicit
- Prefer obvious extension points over clever shortcuts

---

## 7. Branch / PR Hygiene

At the start of every task:
- Check current branch and worktree status first
- If starting from product baseline, switch to `main`, fetch, and fast-forward from `origin/main` before creating a new branch
- If already on a feature branch, confirm it is the intended branch for this task

Before opening or updating a PR:
- Fetch and fast-forward local `main` from `origin/main`
- Branch from current `main`, not from an older local checkout
- Before pushing, check the branch against `origin/main` again — if `main` moved, rebase first
- Do not re-submit duplicate generated assets or older runtime code under the same filenames

---

## 8. Task Lifecycle

Tasks must move through the following states:

**Backlog → Next → In Progress → Done**

Use `tasks.md` as the default lightweight task board unless the project explicitly uses GitHub Issues, Linear, Notion, or another tracker.

Rules:
- Do not start a task that is not in Next or In Progress
- Move task to In Progress before implementation
- Move to Done only when completed
- Do not silently skip or reorder tasks
- For tiny fixes or direct user requests, agents may complete the work first, then add or update the task record afterward

---

## 9. Task Granularity Rule

Tasks must be:
- Small enough to complete in one session
- Clear enough that no interpretation is needed
- Independent enough to not require large refactors

Avoid vague tasks like "implement system", "build feature", or "add 3D".

---

## 10. Security Baseline

### Environment variables
- Never print secret values to the terminal — only check existence:
  ```bash
  [ -n "$API_KEY" ] && echo "API_KEY is set" || echo "API_KEY is missing"
  ```
- Never use `echo $SECRET`, `printenv KEY`, or any command that outputs a value
- Never hardcode secrets in source files
- Never commit `.env` files (use `.env.example` as template)

### General
- Never use `service_role`, admin, server-only, or equivalent privileged keys on the client side
- Database, storage, and API access policies must be explicit — do not rely on default-open behavior
