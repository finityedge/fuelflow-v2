# FuelFlow — Phase 1 Plan & Status

> **Scope note.** The Phase 1 PRD PDF is **not in this repository** (searched the
> working tree for `*.pdf`, `*.docx`, `*prd*` — nothing). The module scope below is
> reconstructed from the product brief as given (PDF-first reconciliation platform for
> the Tanzanian market; MVP = Modules 1–3; free-audit go-to-market). **If the PRD says
> something different, this plan is wrong and should be corrected against it.**

Status markers: **DONE** · **PARTIAL** · **IN PROGRESS** · **NOT STARTED**.
Each item cites the file that is the evidence for its status.

---

## Phase 0 — Pilot blockers (auth / tenant-safety / provisioning)

These are not cleanup. Each one stops a real customer from being onboarded safely, so
they come before any feature work.

| # | Item | Status | Evidence / what is missing |
|---|------|--------|----------------------------|
| 0.1 | **User & station provisioning API** — invite a manager/attendant, assign them to a station, deactivate them | **NOT STARTED** | No route creates a user or a `StationAssignment` except `prisma/seed.ts`. `routes/stations.ts` is `GET /stations` only. Every real pilot user would have to be hand-written into the seed script. |
| 0.2 | **Station CRUD** — create/rename/deactivate a station, set its variance threshold, list its tanks and attendant roster | **NOT STARTED** | `Station` model has only `name`/`location` (`prisma/schema.prisma:21`). No `Tank`, no `Attendant`, no threshold column anywhere in the schema. |
| 0.3 | **Auth hardening — logout is client-only** | **PARTIAL** | `lib/auth.ts:48` clears local state and redirects but never calls `POST /api/auth/logout`, so the hashed refresh token stays valid server-side and the `refreshToken` httpOnly cookie is never cleared. The backend route exists and is unused (`routes/auth.ts:81`). |
| 0.4 | **Refresh token stored in `localStorage`** | **PARTIAL** | `stores/authStore.ts` persists `refreshToken` to localStorage (JS-readable, XSS-exposed) while the backend *also* sets an httpOnly cookie (`routes/auth.ts:24,46`) that the client never sends — `lib/api.ts:27` reads the token from the store and posts it in the body. The cookie is dead weight; the safe path it implies is not actually used. Pick one: cookie-only refresh, or drop the cookie. |
| 0.5 | **Rate limiting on `/auth/login` and `/auth/register`** | **NOT STARTED** | `@fastify/rate-limit` is not a dependency (`apps/backend/package.json`). Login is unthrottled brute-force surface, and `/register` is open tenant self-signup with no invite gate. |
| 0.6 | **JWT secret fails open in production** | **PARTIAL** | `app.ts:25` falls back to `'change-me-in-production'` when `JWT_SECRET` is unset. Should throw at boot when `NODE_ENV=production` and the secret is missing/default. |
| 0.7 | **No password reset / no email delivery** | **NOT STARTED** | Nothing in the tree. |

### Auth & RBAC audit result (what is already safe)

| Area | Verdict | Evidence |
|------|---------|----------|
| Register / login / refresh endpoints | **DONE** | `routes/auth.ts:15,33,55` (+ `:81` logout). |
| Password hashing (argon2id, not a stub) | **DONE** | `services/password.service.ts:4` (`argon2.hash`, m=65536, t=3, p=4); login verifies with `argon2.verify` via `services/auth.service.ts:87`. |
| JWT verification on protected routes | **DONE** | `middleware/auth.ts:42` verifies the access token and loads `req.user`; `app.ts:41` installs it globally as an `onRequest` hook, with per-route opt-out via `config.public` (`health.ts:5`, all of `routes/auth.ts`). Every route file was checked — no route was added without the guard. |
| Tenant scoping (centralised, not ad-hoc) | **DONE** | Prisma client extension + `AsyncLocalStorage`: `prisma/client.ts:4,77-195,197`; every handler wrapped in the tenant scope by `app.ts:44-54`; the BullMQ worker opens the scope explicitly (`jobs/processors/pdfProcessor.ts:16`). No route was found where scoping is missing. **Caveats:** `StationAssignment` and `Tenant` are not in `TENANT_SCOPED_MODELS` (`client.ts:4`) — both are only ever reached via a scoped parent or by `userId`, so this is acceptable today, but a new direct query on `StationAssignment` would be unscoped. The mechanism is also a silent no-op when no context is active, so any DB call from a `preHandler`/hook (none today) would run unscoped. |
| RBAC enforcement | **PARTIAL** | `requireRole` (`middleware/rbac.ts:5`) is applied to upload (`shiftReports.ts:88`), field correction (`:182`) and reparse (`:218`); station access is enforced inline via `hasStationAccess` (`:95,119,147,165,200,230`; `dashboard.ts:13`; `stations.ts:17`). Read routes carry no role gate by design (an ATTENDANT may read their own stations). **What is missing is 0.1** — because no user/station-management route exists, no route can enforce who may invite whom. |
| Seed produces Tenant + OWNER + Station | **DONE** | `prisma/seed.ts` creates tenant `demo-tenant`, station `demo-station`, `owner@fuelflow.local` and `manager@fuelflow.local` (both password `password`), plus the manager→station assignment. Exceeds the ask. No ATTENDANT seeded; upserts use `update: {}` so a changed seed password never rotates. |
| Frontend auth store / token attach / route guard | **DONE** | Zustand+persist store (`stores/authStore.ts`); `lib/api.ts:63` attaches the Bearer token and retries once on 401 with refresh, redirecting to `/login` on failure (`:17-22,70-79`); `components/ProtectedRoute.tsx` redirects unauthenticated users and gates roles; `AppRouter.tsx` protects `/`, `/upload`, `/shift-reports/recent`, `/shift-reports/:id`. Gaps are 0.3 and 0.4 above. |

---

## Module 1 — PDF Ingestion & Reconciliation Engine

| Item | Status | Evidence / what is missing |
|------|--------|----------------------------|
| Upload endpoint (PDF-only, size-capped, magic-byte checked, 202 + background parse) | **DONE** | `routes/shiftReports.ts:88`, `:80`; limit `schemas/shiftReport.schema.ts:42` (15 MB). |
| Background job processing (BullMQ) | **DONE** | `jobs/queues.ts`, `jobs/processors/pdfProcessor.ts`, `src/worker.ts`; 3 attempts, exponential backoff. |
| Deterministic Petronite parser | **IN PROGRESS** | `parsing/petronite.ts` — template markers with a 3-marker threshold (`:31,:43`), section extraction for credit / attendant / tank / adjustments / mobile money, scalar cash + bank deposit + totalizer, date reading (`:722`), reconciliation arithmetic (`:784`). **Open:** only the Petronite template is supported; text-layer only (no OCR for scanned/image PDFs — `extractPdfText` has no fallback); parser tuned against hand-written text fixtures, and the real-PDF corpus generated by `scripts/make-samples.ts` is not exercised in CI. |
| Field-level review & correction | **DONE** | `PATCH /shift-reports/:id/fields/:fieldId` (`shiftReports.ts:180`); `correctExtractedField` (`services/shiftReport.service.ts:337`) clears the review flag and stamps `correctedAt`/`correctedBy`; review UI in `pages/ShiftReport.tsx` + `components/FieldValue.tsx`, `components/ReportGroupCards.tsx`. |
| Status recomputation after review | **DONE** | `refreshReportStatus` (`service.ts:152`) moves NEEDS_REVIEW → PARSED as flags clear. Recompute-from-fields is enforced for the variance (`computeSummary` reused at `:185`). |
| Retry / re-parse path | **DONE** | `POST /shift-reports/:id/reparse` (`shiftReports.ts:216`); UI button in `pages/ShiftReport.tsx`. |
| Reviewer rationale capture | **NOT STARTED** | A correction records who and when, but not *why*. For an audit product the reviewer's note is evidence a station owner will ask for. |
| Bulk review / next-unreviewed flow | **NOT STARTED** | Corrections are one field at a time. |

---

## Module 2 — Attendant Micro-Loss Profiling

**Status: NOT STARTED** (the raw data is captured; nothing profiles it).

- **Captured per report:** `attendant:<slug>:expected|collected|variance` fields
  (`parsing/petronite.ts:409-492`), grouped `ATTENDANT_RECONCILIATION`, rendered per shift
  by `components/ReportGroupCards.tsx` (`AttendantCard`).
- **Missing — and this is the design blocker:** there is no `Attendant` entity. The slug is
  derived from the name printed on the page (`slugify`, `petronite.ts:205`), so "J. Mwangi"
  and "John Mwangi" become different keys and there is **no stable identity across shifts**.
  Cross-shift profiling cannot be built on this without first introducing an attendant
  record and a mapping step at parse/review time.
- **Also missing:** per-attendant variance history (aggregate across shifts), pattern
  detection (repeat shortfalls, direction, rising magnitude vs that attendant's own
  baseline), and any UI to surface it.

---

## Module 3 — Wet-Stock Leakage Trend Detection

**Status: NOT STARTED** (readings captured only; no leakage arithmetic).

- **Captured per report:** `tank:<slug>:book_stock` and `tank:<slug>:closing_dip`
  (`parsing/petronite.ts:494-563`), grouped `TANK_READINGS`, rendered by `TankReadingsCard`.
- **Missing:** no `Tank` entity (no capacity, no product grade, no tank master list — see
  blocker 0.2), so a book-vs-dip volume cannot be converted into a meaningful loss figure;
  no per-shift tank variance; no cross-shift leakage trend; no thresholds or alerting; no UI.
  As with Module 2, slug-from-printed-label is not a stable tank identity.

---

## UI — remaining screens

| Screen | Status | Evidence / what is missing |
|--------|--------|----------------------------|
| Dashboard (totals, variance trend, attention list, recent table) | **DONE** | `pages/Home.tsx`, `services/dashboard.service.ts`. |
| Shift Report List / History **with variance on every row** | **DONE** | `pages/ShiftReports.tsx`; the variance column is `VarianceCell` in `components/ReportListRow.tsx:36`; summary travels on the row (`packages/shared/src/types.ts:147`). |
| Shift Report review / correction | **DONE** | `pages/ShiftReport.tsx`. |
| Upload | **DONE** | `pages/Upload.tsx`, `lib/shiftReports.ts:59` (XHR for progress). |
| Login / Register | **DONE** | `pages/Login.tsx`, `pages/Register.tsx`. |
| **Failed / Needs-Review Queue as its own view** | **PARTIAL** | The list can already filter by status (`lib/reportFilters.ts`, `LIST_STATUS_VALUES` in `schemas/shiftReport.schema.ts:22`) and the dashboard links attention there (`Home.tsx:187,342,356`). What is missing is a dedicated route/view that opens straight into the queue and walks through it — today the user lands on the unfiltered history list. |
| **Station Settings** (variance threshold, tank list, attendant roster) | **NOT STARTED** | No model, no route, no screen. `SettingsIcon` exists but is unused (`components/icons.tsx:374`); `components/Layout.tsx:27-29` documents the deliberate omission of Attendants/Tanks/Settings nav until the screens exist. Depends on 0.2. |
| ATTENDANT-facing screen | **NOT STARTED** | The sidebar nav (`Layout.tsx:36-41`) offers only Dashboard plus Shift reports (OWNER/MANAGER only), so an ATTENDANT logs in to a dashboard and nothing else. |

---

## Free-audit findings sheet — **GTM-CRITICAL**

**Status: NOT STARTED — nothing exists.** There is no print stylesheet, no `window.print`,
no CSV/PDF export, no export endpoint anywhere in the tree (verified by grep across
`apps/**` for `window.print`, `@media print`, `.csv`, `download=`, `jsPDF`, `pdfkit`,
`puppeteer`, `findings`). The one-page-per-shift (or per-station) summary that the free-audit
sales motion hands to a prospective station owner has to be built from scratch: a
backend-assembled payload (variance, flagged figures, attendant and tank exceptions), a
print-optimised layout, and a way to produce it as a file.

**This is the artifact the Phase 1 go-to-market depends on. If a pilot is being run as a
free audit, pull this to the front of the queue ahead of the module work below.**

---

## Ordering (what to build next, pilot-first)

**P0 — pilot blockers**
1. `0.1` User & station provisioning API (nothing else is onboardable without it)
2. `0.3` + `0.4` Auth hardening (logout wiring; decide refresh-token storage)
3. `0.5` + `0.6` Rate limiting + fail-closed JWT secret
4. `0.2` Station CRUD with variance threshold *(also unblocks Modules 2 & 3 and Settings)*

**P1 — core reconciliation completeness**
5. Module 1 hardening: real-PDF corpus in CI, scanned-PDF fallback, template coverage
6. Failed / Needs-Review queue as a dedicated view
7. Module 3 — wet-stock leakage (needs `Tank` from `0.2`)
8. Module 2 — attendant micro-loss profiling (needs `Attendant` identity)
9. Reviewer rationale capture on corrections

**P2 — go-to-market & remaining UI**
10. **Free-audit findings sheet export** *(GTM-critical — move to P0 if the pilot is an audit demo)*
11. Station Settings screen (threshold, tank list, roster) — over `0.2`
12. ATTENDANT-facing screen
13. Password reset / email delivery (`0.7`)
