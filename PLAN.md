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
| 0.1 | **User & station provisioning API** — invite a manager/attendant, assign them to a station, deactivate them | **DONE** | `routes/users.ts` (`GET`/`POST /users`, `PATCH /users/:id`), `services/user.service.ts`. Creating is OWNER-only and cannot mint a second OWNER (`schemas/user.schema.ts`); station ids are resolved through the tenant-scoped client, so another tenant's station is "not found"; deactivating clears the refresh token *and* clears the session inline; `middleware/auth.ts` re-reads `isActive` on every request so an unexpired access token stops working. `User.isActive` added in migration `20260930113038_user_and_station_lifecycle`. Tests: `tests/users.test.ts` (16). |
| 0.2 | **Station CRUD** — create/rename/deactivate a station, set its variance threshold, list its tanks and attendant roster | **DONE** | `routes/stations.ts` + `services/station.service.ts`: `POST /stations`, `PATCH /stations/:id`, `GET /stations/:id` (station + tanks + attendant roster + logins with access), plus tank and attendant create/update. `Station.isActive`, `Station.varianceThreshold`, `Tank` and `Attendant` models in migrations `..._user_and_station_lifecycle` and `..._tank_and_attendant_master_lists`. `Tank`/`Attendant` were added to `TENANT_SCOPED_MODELS`. Tests: `tests/stations.test.ts` (18). |
| 0.3 | **Auth hardening — logout is client-only** | **DONE** | `lib/auth.ts:61` `logout()` now POSTs `/api/auth/logout` before clearing local state; the backend route revokes the stored hash and clears the cookie. Covered by `tests/auth.test.ts` ("refuses a revoked token"). |
| 0.4 | **Refresh token stored in `localStorage`** | **DONE** | Cookie-only refresh, chosen over dropping the cookie. `routes/auth.ts` reads the token from the httpOnly cookie and never from the body; `AuthSession` (`packages/shared/src/types.ts`) carries the access token alone; `stores/authStore.ts` has a `version: 1` persist migration that deletes a `refreshToken` left behind by the old build. |
| 0.5 | **Rate limiting on `/auth/login` and `/auth/register`** | **DONE** | `@fastify/rate-limit` added as a real dependency (`apps/backend/package.json`, and to `pnpm-lock.yaml` — it was present in `node_modules` but declared nowhere, so a fresh install would have failed). Registered globally-off in `app.ts:59`; the four `/api/auth/*` routes opt in via `config.rateLimit` (10/min, raised under test). |
| 0.6 | **JWT secret fails open in production** | **DONE** | `app.ts:31` `resolveJwtSecret()` throws at boot when `NODE_ENV=production` and `JWT_SECRET` is unset or still the `.env.example` placeholder. |
| 0.7 | **No password reset / no email delivery** | **DONE** | `config/mail.ts`, `services/mail.service.ts`, `services/passwordReset.service.ts`, plus `POST /api/auth/forgot-password` and `/reset-password` in `routes/auth.ts`. `PasswordResetToken` (migration `20260930145259_password_reset_tokens`) stores only a SHA-256 of the token, 60-minute TTL, spent by marking rather than deleting, and spending one clears `User.refreshToken`. The request endpoint answers 202 identically for an address that exists and one that does not, and treats a deactivated account as unknown. Mail has two transports: `smtp` (nodemailer) and `log`, which writes the message to the server log; `log` counts as **no delivery** under `NODE_ENV=production`, where the route answers 503 instead of claiming to have sent an email it cannot send. Frontend: `/forgot-password` and `/reset-password` (public routes), and the sign-in screen's "Forgot password?" button is now a link that goes there. Tests: `tests/passwordReset.test.ts` (13), `tests/mail.test.ts` (9). Verified live against a host instance on 3111: 202 known/unknown, 400 malformed, 400 short password, 400 unknown token, 200 valid reset, 400 replay, 200 login with the new password, 401 with the old. |

### Fixed in passing (found while building the above)

| Item | Evidence |
|------|----------|
| **Zod failures returned 500** | No `setErrorHandler` existed, so any bad query or body (`?limit=abc`) answered 500 with the raw error. `app.ts:73` now maps `ZodError` → 400 with field details, honours an intentional `statusCode`, logs 5xx in full and answers them in outline. |
| **Duplicate registration returned 500** | `services/auth.service.ts` `registerTenantAndOwner` now catches `P2002` and answers 409 instead of surfacing a unique-constraint violation as a server fault. |
| **`slugify` had one copy in the parser** | Extracted to `parsing/slug.ts` and imported by `petronite.ts` and `station.service.ts`, so the key an owner fills in for a tank or attendant is produced by the same function the parser uses. Two copies would have drifted into "this tank exists but never matches anything". |
| **`pnpm db:migrate` did not work** | The root script delegated to the backend package, so Prisma ran with `apps/backend` as its working directory and found no `.env` — it failed with `Environment variable not found: DATABASE_URL`. The root script now invokes Prisma with `--schema` from the repo root. (The backend's own `db:migrate` script is unchanged for Docker/CI, where the environment supplies the variable.) |
| **`@fastify/rate-limit` was an undeclared dependency** | Present in `node_modules` and absent from both `package.json` and `pnpm-lock.yaml`, so a clean install would have failed to resolve the import. Now declared and locked. |
| **There was no CI at all** | No `.github/`, no workflow of any kind. The 123-test suite, the typecheck and the lint ran only when somebody remembered, and the parser's real-PDF coverage existed on one machine. `.github/workflows/ci.yml` now runs install → Prisma generate → migrate deploy → typecheck → lint → build → test against real PostgreSQL 17 and Redis services on every push to `main` and every PR. `migrate deploy` (not `dev`) is deliberate: it applies the committed migrations and refuses to invent one, so a schema change committed without its migration fails here. Verified locally first — `pnpm install --frozen-lockfile` resolves clean, and `migrate deploy` reports all 7 migrations applied with none pending. |
| **`pnpm typecheck` did not work on a clean checkout** | `turbo.json` declared `typecheck` with no `dependsOn`, but `@fuelflow/shared` resolves through its built `dist/index.d.ts` — so on a fresh clone the backend and frontend had no types to compile against and typecheck failed until someone ran a build first. It passed on a working tree only because `packages/shared/dist` already existed. `typecheck` now depends on `^build`. Confirmed by deleting every `dist/` and re-running: shared builds first, 4/4 tasks pass. |
| **`.omc/` was untracked and unignored** | Tool scratch state (session logs, mode state) that would have been swept into the next `git add -A`. Now gitignored. |
| **`resetDatabase` relied on an unstated cascade** | It deleted `Station` without naming `Tank` and `Attendant`, which only went away because of the `onDelete: Cascade` on their station relation. The helper's own documented rule is "children go first", so the next model hung off `Station` would have been covered or missed depending on which relation attribute someone happened to write. Both are now deleted explicitly. |
| **`hasStationAccess` let a foreign tenant's station through — on every route that used it** | For an OWNER it returns `true` for *any* id, because it works from the token alone and cannot know the tenant. A station belonging to another tenant therefore passed the guard and the route answered `200` with an empty result instead of `403`. No data leaked — the Prisma extension scopes by tenant regardless — but the route claimed success on a station the caller has no relationship with, which is the kind of answer that sends someone hunting a bug in the wrong place. Found while writing `tests/tankLeakage.routes.test.ts`. Fixed by pairing the check with the tenant-scoped `stationExistsInTenant()` (`services/station.service.ts`) in `routes/tankLeakage.ts` **and** in the pre-existing identical hole in `routes/dashboard.ts`, rather than leaving a known one behind. |
| **A test comment asserted a false invariant about tank keys** | `tests/stations.test.ts` claimed `TANK_1` "is what the parser produces from the label printed on the report". It is not: the parser produces `tank:1`. The comment described a bridge that did not exist, which is part of why the mismatch survived. It now states the two spellings and asserts the bridge — `expect(tankIdentity(tank.slug)).toBe('1')` — so the test fails if the slug ever stops resolving to the parser's key. |
| **The seed produced no tanks** | A demo station with no tanks cannot demonstrate the wet-stock screen at all, and every report against it would land in "unmapped". `prisma/seed.ts` now creates `Tank 1`–`Tank 3` with `TANK_1`-style slugs, one of them deliberately without a capacity or threshold so the screen's unconfigured-tank state is visible in development. |
| **The seed had no attendants and no variance threshold** | Both are needed before the profiling screen shows anything but its worst state. `prisma/seed.ts` now creates the two people the sample PDFs actually print — `John Mwaka` and `Grace Kimaro`, whose slugs come from the same `slugify` the parser uses rather than from hand-written literals — and sets the demo station's `varianceThreshold` to 5,000. Zero is the right default for a station that has not chosen a tolerance and a useless one for a demo, where every shift would carry a single-shift alert. |
| **Two attendants with initials on one report were merged into one person** | The attendant parser stripped a leading row index with the same rule the tank parser uses, and that rule also removes a single leading letter — so `J. MWANGI` and `P. MWANGI` both became `MWANGI` and shared one key. Every shift either of them worked landed on one record and one of them would have been shown the other's shortfalls: the exact harm the whole attendant-identity design exists to prevent, arriving from the other direction. `parsing/petronite.ts` now has `stripLeadingAttendantIndex()`, which removes a row number and nothing else (the tank parser still uses the original, where a letter *is* the identifier). The same change fixed a pre-existing slice-offset bug: the amounts were searched for from an offset taken off the unstripped line. Regression fixture `REPORT_INITIALS` in `tests/parsing/petronite.test.ts` asserts both keys exist and that no `attendant:MWANGI` key does. |

### Auth & RBAC audit result (what is already safe)

| Area | Verdict | Evidence |
|------|---------|----------|
| Register / login / refresh endpoints | **DONE** | `routes/auth.ts:15,33,55` (+ `:81` logout). |
| Password hashing (argon2id, not a stub) | **DONE** | `services/password.service.ts:4` (`argon2.hash`, m=65536, t=3, p=4); login verifies with `argon2.verify` via `services/auth.service.ts:87`. |
| JWT verification on protected routes | **DONE** | `middleware/auth.ts:42` verifies the access token and loads `req.user`; `app.ts:41` installs it globally as an `onRequest` hook, with per-route opt-out via `config.public` (`health.ts:5`, all of `routes/auth.ts`). Every route file was checked — no route was added without the guard. |
| Tenant scoping (centralised, not ad-hoc) | **DONE** | Prisma client extension + `AsyncLocalStorage`: `prisma/client.ts:4,77-195,197`; every handler wrapped in the tenant scope by `app.ts:44-54`; the BullMQ worker opens the scope explicitly (`jobs/processors/pdfProcessor.ts:16`). No route was found where scoping is missing. **Caveats:** `StationAssignment` and `Tenant` are not in `TENANT_SCOPED_MODELS` (`client.ts:4`) — both are only ever reached via a scoped parent or by `userId`, so this is acceptable today, but a new direct query on `StationAssignment` would be unscoped. The mechanism is also a silent no-op when no context is active, so any DB call from a `preHandler`/hook (none today) would run unscoped. |
| RBAC enforcement | **DONE** | `requireRole` (`middleware/rbac.ts:5`) is applied to upload (`shiftReports.ts:114`), field correction (`:216`), bulk accept (`:261`) and reparse (`:296`); station access is enforced inline via `hasStationAccess` (`:121,145,176,198,234,275,308`; `dashboard.ts:13`; `stations.ts:17`). Read routes carry no role gate by design (an ATTENDANT may read their own stations) — with **four deliberate exceptions, all OWNER/MANAGER only**: `GET /api/attendants/profiles`, `GET /api/findings`, and `GET /api/shift-reports/:id` with its `/file` (`shiftReports.ts:163,186`). The criterion is the same one in each case — whether the payload attributes money to a named person. The first returns money attributed to named people and the list is every colleague's (`routes/attendantProfiles.ts`); the second is the one read built to be printed and handed over (`routes/findings.ts`); the third carries every colleague's attendant row and the uploaded PDF with the same rows printed on it (`canReadReport`, `shiftReports.ts`), which the first of the four refuses on the stated ground that the list is every colleague's — the same figures refused by one route and served by another was an oversight, not a policy, and it is now the same answer in both places. `GET /api/shift-reports` (the list) and `GET /api/dashboard` stay open: they carry the shift's totals and name nobody. The write side is gated too: `routes/users.ts` reserves provisioning for an owner and the roster for OWNER/MANAGER, and `routes/stations.ts` splits a station's identity (owner) from its contents (OWNER/MANAGER plus `requireStationAccess`). `0.1` landed after this row was first written — the refusals are pinned in `tests/protected.test.ts`, `tests/rbac.test.ts`, `tests/users.test.ts` and `tests/stations.test.ts`. |
| Seed produces Tenant + OWNER + Station | **DONE** | `prisma/seed.ts` creates tenant `demo-tenant`, station `demo-station` with a 5,000 variance threshold, `owner@fuelflow.local` and `manager@fuelflow.local` (both password `password`), the manager→station assignment, the station's three tanks, and the two attendants the sample reports name (see "Fixed in passing"). Exceeds the ask. It also seeds one ATTENDANT login — `attendant@fuelflow.local`, assigned to the demo station and linked to `John Mwaka` — because the attendant-facing screen cannot be seen at all without one; the other attendant has no login, which is the ordinary state for the role. Upserts use `update: {}` for everything but the threshold, so a changed seed password never rotates, and the attendant link is claimed only when unset. |
| Frontend auth store / token attach / route guard | **DONE** | Zustand+persist store (`stores/authStore.ts`); `lib/api.ts:63` attaches the Bearer token and retries once on 401 with refresh, redirecting to `/login` on failure (`:17-22,70-79`); `components/ProtectedRoute.tsx` redirects unauthenticated users and gates roles; `AppRouter.tsx` protects `/`, `/upload`, `/shift-reports/recent`, `/shift-reports/:id`, `/review`, `/tanks`, `/attendants`, `/findings` and `/settings`. `/` is dispatched by role (`HomeRoute`): an ATTENDANT gets their own record, everybody else the dashboard. `/forgot-password` and `/reset-password` are deliberately **not** behind the guard: they exist for people who cannot sign in, so a redirect to `/login` from either would be a loop rather than a gate. |

---

## Module 1 — PDF Ingestion & Reconciliation Engine

| Item | Status | Evidence / what is missing |
|------|--------|----------------------------|
| Upload endpoint (PDF-only, size-capped, magic-byte checked, 202 + background parse) | **DONE** | `routes/shiftReports.ts:90`, `:82`; limit `schemas/shiftReport.schema.ts:42` (15 MB). |
| Background job processing (BullMQ) | **DONE** | `jobs/queues.ts`, `jobs/processors/pdfProcessor.ts`, `src/worker.ts`; 3 attempts, exponential backoff. |
| Deterministic Petronite parser | **PARTIAL** | `parsing/petronite.ts` — template markers with a 3-marker threshold (`:32,:44`), section extraction for credit / attendant / tank / adjustments / mobile money, scalar cash + bank deposit + totalizer, date reading, reconciliation arithmetic. **Real-PDF coverage now runs in CI** — see the CI row under "Fixed in passing": the suite drives genuine PDFs through pdfjs and our y-coordinate line reconstruction, not stubbed text. **Open:** (a) **no OCR.** A scan cannot be read, and that is now stated as a limitation instead of hedged — the failure names both causes and the action for each, because calling a good scan "possibly corrupted" sent managers to re-export a file that was never broken. Two tests cover it, including `buildImageOnlyPdf()` (a valid, ink-bearing PDF with no text layer). (b) Only the Petronite template is supported. **A real Petronite report has now been seen, and it does not match this template** — the sample is `ASAMOIL KISEMVULE-DAY-24_08_2026 (1).pdf` in the repository root, and what it does to the parser is written up under "The real report, and what it does to this template" below. The fixtures remain invented to the spec's structure, so the suite still proves the machinery and not the template match. (c) Template coverage can no longer advance by writing more fixtures — it needs a decision about what the template *is*, which is a human's to make, not a patch to be made quietly. (d) ~~An unreadable attendant row is a flag nothing can clear~~ — **fixed**: a row whose two figures cannot be told apart is now written as those two figures, empty and both flagged (`parsing/petronite.ts:454`), instead of as one `attendant:<slug>:row` flag. The review screen's ordinary correction control fills them in, so the row can be settled and the report leaves the queue; before, the flag had no control that could clear it and the report sat in NEEDS_REVIEW for good. Nothing is guessed at in the meantime — both figures stay null, the variance stays unknown, and the row is still left out of the card's totals while the person's profile counts the shift as one that cannot be compared rather than one that was never worked (`shiftsNotComparable`, never a zero) — and the one figure the parser *did* find is deliberately not filed under either column, since which column it belongs to is the thing that could not be read. The nameless-row key was fixed in the same pass: it was `fields.length / 3 + 1`, which a two-field row made fractional. Tests: `tests/parsing/petronite.test.ts` ("an unreadable attendant row", 6), `tests/parsing/attendantVariance.test.ts` (both shapes), `tests/shiftReports.integration.test.ts` ("an unreadable attendant row"). Legacy rows — reports parsed before the change — still take the old shape; the card says so and points at re-parsing, which now rewrites the row into the two fillable fields. |
| Field-level review & correction | **DONE** | `PATCH /shift-reports/:id/fields/:fieldId` (`shiftReports.ts:182`); `correctExtractedField` (`services/shiftReport.service.ts:337`) clears the review flag and stamps `correctedAt`/`correctedBy`/`correctionNote`; review UI in `pages/ShiftReport.tsx` + `components/FieldValue.tsx`, `components/ReportGroupCards.tsx`. |
| Status recomputation after review | **DONE** | `refreshReportStatus` (`service.ts:152`) moves NEEDS_REVIEW → PARSED as flags clear. Recompute-from-fields is enforced for the variance (`computeSummary` reused at `:185`). |
| Retry / re-parse path | **DONE** | `POST /shift-reports/:id/reparse` (`shiftReports.ts:262`); UI button in `pages/ShiftReport.tsx`. |
| Reviewer rationale capture | **DONE** | `ExtractedField.correctionNote` (migration `20260930115656_reviewer_correction_note`); optional `note` on `correctFieldBodySchema` (`schemas/shiftReport.schema.ts`), persisted in `correctExtractedField` (`services/shiftReport.service.ts:337`), returned by `serializeField` and carried on the shared `ExtractedField` type. The review screen asks for it in the correction form and reads it back under the row (`components/FieldValue.tsx`). Optional by design — the common fix needs no prose — and the field is single-slot like `correctedAt`/`correctedBy`, so a later correction replaces the earlier rationale rather than accumulating a history (documented at the write site; a real revision log is a larger feature and is not pretended to here). Test: `tests/shiftReports.integration.test.ts` ("keeps the reviewer's reason alongside the correction"). |
| Bulk review / next-unreviewed flow | **DONE** | Two halves, both built. **Bulk accept:** `POST /shift-reports/:id/fields/accept` (`routes/shiftReports.ts:227`) over `acceptExtractedFields` (`services/shiftReport.service.ts`) settles many flagged figures in one atomic transaction, each keeping the value it has. Accepting is recorded distinctly from correcting — `ExtractedField.reviewAction` (`FieldReviewAction`, migration `20260930170750_field_review_action`), `ACCEPTED` vs `CORRECTED` — because a reviewer who reads the paper and leaves the number alone has not corrected anything, and "the figure was never touched" is exactly what an owner asks when a variance disappears after review. The service refuses per id and says which (`not_found` / `not_flagged` / `nothing_read`), so an empty row can never have its flag cleared; a batch that settles nothing because every id belongs elsewhere is a 404, while "already checked" is a 200 that names it. Per-card "Accept all N remaining" and a per-row "Accept" in `components/ReportGroupCards.tsx` / `FieldValue.tsx`. **Walk-through:** a "next flagged figure" step in `pages/ShiftReport.tsx` scans forward with wrap, scrolls the figure into view and rings it, with a "N of M flagged figures checked" line. Tests: `tests/shiftReports.routes.test.ts` (11, access and refusal shapes), `tests/shiftReports.integration.test.ts` ("accepting a flagged field", 9). **One flag this flow could not clear, now cleared:** an unreadable attendant row used to be a whole-row flag with nothing to accept and no control to clear it, so a report carrying one never left NEEDS_REVIEW — and re-parsing could not help, because the same ambiguous line was unreadable every time. The parser now writes such a row as its two figures, empty and both flagged, which the correction control fills in; see the parser row's open item (d). Reports parsed before that change can be re-parsed from the review screen to get the same fillable fields. |

### The real report, and what it does to this template

A real Petronite shift report arrived in the repository — `ASAMOIL KISEMVULE-DAY-24_08_2026 (1).pdf`,
a genuine two-page iText 2.1.7 export with a real text layer. It was pushed through the genuine
pipeline rather than a unit test: `POST /api/shift-reports/upload` → the BullMQ worker →
`parseShiftReportText` → `ExtractedField` rows, then read back from `GET /api/shift-reports/:id`.
**It does not match the template, and the mismatch is structural.** It is reported here and not
patched, because what to do about it is a coverage decision rather than a bug to fix quietly.

**The gate passes anyway.** `matchedMarkers` = PETRONITE, SHIFT REPORT, TANK DIP, ATTENDANT,
CURRENCY TZS (5 of 8); missing = TOTALIZER, RECONCILIATION, MOBILE MONEY. The 3-marker threshold
(`parsing/petronite.ts:44`, patterns at `:32-41`) is cleared, so the document is *accepted* — and
two of the five hits are false positives. `TANK DIP` matches the word **"Dipping" in a column
header**, and `ATTENDANT` matches a column header on two unrelated tables (`… Order Type Shift
Attendant`). Nothing the parser then goes looking for is on the document.

**Every section is different.** The report's own sections are Pump Sales, Pump Test, Nozzle Credit
Sales, Loyalty Sales, Product & Services Credit/Cash Sales, Cash Sales, Expenditures, Stock
Movement By Tank / By Product, Fuel Received, Attendant Collection and Cash Position. There is no
TOTALIZER, no RECONCILIATION and no MOBILE MONEY. Against `SECTION_HEADERS`
(`parsing/petronite.ts:107-112`) and the scalar reads, what the pipeline actually stored was:

| Assumed | What the report has | What came out |
|---|---|---|
| a `CREDIT SALES` block | "Nozzle Credit Sales" / "Product & Services Credit Sales" | 12 invented `credit_sale:unidentified_1..12` scraped from the **Pump Sales** table columns (`3, 2, 3, 5, 502.597, … , 518.49`); `summary.approvedCredit = 1049.087` |
| `ATTENDANTS?` opens the attendant block | "Attendant Collection"; the word "Attendant" first appears as a **column header** at text line 36 | the block opens 30 lines early and closes on the wrong table — see below |
| `TANKS?\|DIP\|DIPPING` | "Stock Movement By Tank", rows shaped `AGO 1 14,536.842 …` | **zero** `TANK_READINGS` fields; Module 3 is inert on real data |
| TOTALIZER / CASH COLLECTED / BANK DEPOSITS scalars | "AMOUNT COLLECTED" under Cash Position, "CASH TO BE BANKED", "NMB-12170745" | `pump_totalizer_sales`, `cash_collected`, `bank_deposit_total` all null |
| an expenses/discounts block | Expenditures | the 15,100 recorded **twice** — `adjustment:ADJUSTMENT_2` *and* `adjustment:EXPENSE_1` — plus a spurious 310 from `CASHBACK DISCOUNT LTRS310` |

**The one that matters most, because it is not flagged.** The attendant rows the pipeline stored are
`AGO_DIESEL` and `attendant_2`:

```
ATTENDANT_RECONCILIATION  attendant:AGO_DIESEL:expected    502.597       needsReview=false
ATTENDANT_RECONCILIATION  attendant:AGO_DIESEL:collected   3,998.00      needsReview=false
ATTENDANT_RECONCILIATION  attendant:AGO_DIESEL:variance    2,009,382.81  needsReview=false
ATTENDANT_RECONCILIATION  attendant:attendant_2:expected   518.49        needsReview=false
ATTENDANT_RECONCILIATION  attendant:attendant_2:collected  3,917.00      needsReview=false
ATTENDANT_RECONCILIATION  attendant:attendant_2:variance   2,030,925.33  needsReview=false
```

Their source is the **Cash Sales product table** —

```
AGO - DIESEL      502.597   3,998.00   2,009,382.81
PMS / MSP - PETROL 518.49  3,917.00   2,030,925.33
```

— read as one attendant per product, with quantity, unit price and amount standing in for expected,
collected and variance. **A fuel product is filed as a person's money, at HIGH confidence, with
`needsReview: false`** — so it never reaches the review queue, and `attendantReadingsFromFields`
(`parsing/attendantVariance.ts:131`) groups it as a settled, non-provisional row because
`provisional` is derived from those same flags. The profiling screen would show an attendant called
AGO_DIESEL owed TZS 502.597 who handed over TZS 3,998. The three attendants who are actually on the
report — `AMINA MOHAMMED SHARIF`, `RAHMA HAMISI`, `ZAINABU SELEMANI`, under "Attendant Collection" —
are not read at all. This is the exact harm the attendant-identity design exists to prevent, and it
is reached by a route the design does not cover: not a bad name match, but a parser section landing
on the wrong table.

The immediate cause is a word rather than a layout — `SECTION_HEADERS.attendant` is
`/\bATTENDANTS?\b/i` (`parsing/petronite.ts:109`), the report uses "Attendant" as a column heading
on earlier tables, and so the block opens early and closes on the products. That one is fixable
locally. What is not fixable by the same move is the rest of the list: no totalizer, no
reconciliation, no mobile money, a tank section whose rows are shaped differently, and a grouped
two-column table layout whose line reconstruction interleaves `PUMP 2 / AGO` product labels with
unrelated data rows.

**Why this is reported and not patched.** Each misparse above has a plausible local fix — anchor the
attendant block on the word "Collection", accept "AMOUNT COLLECTED" as `cash_collected`, match
"Stock Movement By Tank" — and each one widens the template until the threshold stops meaning
anything. A gate that accepts a document with no totalizer, no reconciliation and no mobile money is
not testing for a Petronite shift report; it is testing for the vendor's name, and the two markers
that carry the decision are matching column headers. The honest reading is that **there are at least
two Petronite report layouts**, and this parser was written against neither of them — `:32-44` was
written from the spec's structure, and no real sample had been seen. Whether this layout replaces
the assumed one, whether the parser grows a per-layout dispatch, or whether the marker set is
re-chosen from the real documents, is a coverage decision with a cost attached. So: **status left
PARTIAL, nothing patched around, and the sample left untracked in the repository root** for that
decision to be made deliberately.

---

## Module 2 — Attendant Micro-Loss Profiling

**Status: DONE** — mapping, arithmetic, the three signals, API and screen.

- **Captured per report:** `attendant:<slug>:expected|collected|variance` fields
  (`parsing/petronite.ts`), grouped `ATTENDANT_RECONCILIATION`, rendered per shift
  by `components/ReportGroupCards.tsx` (`AttendantCard`).
- **The identity step is built, and it is a row somebody creates — never a similarity rule.**
  `Attendant` carries a per-station unique `slug` from the same `slugify` the parser uses;
  `AttendantAlias` (`prisma/schema.prisma`, migration `..._attendant_aliases`) joins *another*
  spelling to a person, with `POST`/`DELETE /api/stations/:id/attendants/:attendantId/aliases`
  behind the station-contents guard, and `indexAttendants()`
  (`services/attendantProfile.service.ts`) resolving exact-slug-first and alias-second. A fuzzy
  match that guessed wrong would move one person's shortfall onto a colleague's record, which is
  an accusation made by software with nobody in the loop — so "J. Mwangi is John Mwangi" is a
  fact a manager asserts, and the refusals are specific: the key cannot be the attendant's own
  slug (inert), cannot be another attendant's slug (an exact match would win and the link would
  silently do nothing), and cannot already be claimed (the 409 names who holds it).
- **The arithmetic — nothing is stored.** `attendantReadingsFromFields()`
  (`parsing/attendantVariance.ts`) derives `expected - collected` per shift, and
  `getAttendantProfiles()` (`services/attendantProfile.service.ts`) re-derives it from
  `ExtractedField` rows on every read, so correcting either figure on a shift report moves the
  person's profile immediately. The printed `attendant:<slug>:variance` column is deliberately
  **not** read: the two figures above it are the ones a manager can correct, and this keeps the
  profile, the shift summary and the review screen arithmetically identical.
- **Three signals, because "short" is not one kind of event** (`decideAlert`): `single_shift`
  (one shift at or over the station's own `varianceThreshold`), `recurring_shortfall` (≥3
  comparable shifts, ≥60% of them short, net short — each individually unremarkable, which is
  why it survives), and `worsening_drift` (their last 3 shifts all short where their earlier
  ones were not). The drift signal takes **no invented threshold**, consistent with
  `varianceThreshold` defaulting to 0 meaning "flag everything": it is a statement about one
  person's own history, and there is nothing station-wide to judge it against.
- **Screen:** `/attendants` (`pages/AttendantProfiles.tsx`, `lib/attendantProfiles.ts`), in the
  nav under Wet stock. Totals, an explainer for the sign convention, the trend strip per person
  (`components/VarianceBars.tsx` — the tank screen's `TankTrendBars` now delegates to it, so
  the geometry and the sign convention exist once), and an **unclaimed-names panel** that names
  the stray key the way the paper printed it and offers the inline link, because a repeated
  shortfall under a name nobody has claimed otherwise leaves no trace at all.
- **Two things the screen says that the numbers do not:** the takings beside every shortfall
  (TZS 5,000 means one thing on 50,000 of sales and another on five million), and that the
  figure is derived from the report's own two columns rather than being a judgement.
- Tests: `tests/parsing/attendantVariance.test.ts` (11), `tests/attendantProfiles.integration.test.ts`
  (22 — the arithmetic and the three signals), `tests/attendantProfiles.routes.test.ts` (21 —
  access at the HTTP boundary, including that an ATTENDANT gets 403: this is the one read in the
  product whose subject is a named person, and the list is every colleague's).
- **Still open, deliberately:** nothing surfaces this on the *review* screen (the plan's
  original phrasing). The link prompt lives where the stray name is met — on the profiling
  screen — and putting a second copy on the shift being reviewed would be the same action in two
  places with two different ideas of which station it belongs to.

---

## Module 3 — Wet-Stock Leakage Trend Detection

**Status: DONE** — arithmetic, alerting, API and screen.

- **Captured per report:** `tank:<slug>:book_stock` and `tank:<slug>:closing_dip`
  (`parsing/petronite.ts:494-563`), grouped `TANK_READINGS`, rendered by `TankReadingsCard`.
- **The identity blocker is cleared, and it was real.** The parser writes the bare identifier
  after the word TANK (`tank:1:book_stock`) while station settings derives `TANK_1` from "Tank 1"
  — two spellings of the same tank, confirmed by `tests/parsing/petronite.test.ts:133-136`
  against `tests/stations.test.ts:188`. `tankIdentity()` (`parsing/slug.ts`) normalises both to
  `1`, and `indexTanks()` (`services/tankLeakage.service.ts`) matches on it with exact-slug-wins
  so a normalisation collision cannot silently redirect a tank's history. Deliberately not fixed
  by changing either side: rewriting the parser's key would orphan every field already stored,
  and changing the settings slug would rename tanks owners have already set up.
- **The arithmetic — nothing is stored.** `tankReadingsFromFields()` (`parsing/tankVariance.ts`)
  derives each shift's variance, and `getTankLeakage()` re-derives it from `ExtractedField` rows
  on every read. A manager correcting a misread dip therefore moves the leak number immediately,
  which is the whole point: the shift where the misread happened is exactly the shift they are
  looking at. Tested directly ("clears the alert when the dip it was built from is corrected").
  Positive means fuel the paperwork believes in and the tank did not have.
- **Alerting — two named signals, because a leak and a robbery are different shapes.**
  `single_shift` fires when one shift's shortfall clears the tank's threshold. `persistent_shortfall`
  fires when a tank is short on ≥3 comparable shifts, on ≥60% of them, and by ≥ one threshold in
  total — the loss no single shift reveals. 60% and not 100% on purpose: a real leak must not stop
  alerting because someone once recorded the tank correctly.
- **Threshold resolution:** `Tank.leakThresholdLitres` (settable, migration
  `20260930122635_tank_leak_threshold`) → `0.5%` of `capacityLitres` → **null**. Null is a real
  answer, not a failure: with neither figure there is no honest line to draw, so such a tank is
  shown with its numbers and never alerted on alone. The threshold actually used is returned to
  the screen, so the alert and the displayed figure cannot disagree.
- **A missing dip is never zero.** A shift with one figure and not the other is counted as
  `shiftsNotComparable` rather than scored, because treating a missing dip as a full tank would
  invent a loss the size of the book figure.
- **Unmapped tanks are not dropped.** A tank on a report that is not set up on the station still
  has real litres missing; it appears in `unmapped[]` with its slug and total, so the screen can
  ask for it by name instead of hiding the loss — which is also how the key mismatch above would
  have shown itself had it not been fixed.
- **API:** `GET /api/tanks/leakage?stationId&periodDays` (`routes/tankLeakage.ts`, 1–90 days,
  default 30, `MAX_SCANNED_REPORTS = 300`). OWNER sees the tenant; everyone else is restricted to
  `user.stationIds`.
- **Screen:** `pages/TankLeakage.tsx` at `/tanks` (OWNER/MANAGER), nav row in `Layout.tsx` under
  the review queue; `components/TankTrendBars.tsx` draws each tank's shift-by-shift direction;
  `formatLitres()` added to `lib/format.ts` so a bare `1,240` beside a `TZS 1,240` cannot be
  misread as cash.
- **Tests:** `tests/parsing/tankVariance.test.ts` (10), `tests/parsing/slug.test.ts` (10),
  `tests/tankLeakage.integration.test.ts` (16), `tests/tankLeakage.routes.test.ts` (8).
- **Verified beyond the suite** against the real development database: a genuine PDF pushed
  through the genuine upload → parse pipeline produced `tank:1:book_stock = 12000` /
  `tank:1:closing_dip = 11500`, and `GET /api/tanks/leakage` returned `Tank 1` (Diesel, threshold
  100) at 500 L missing with a `single_shift` alert and `unmapped: []` — the parser's key
  resolving to the settings-written slug, end to end. The suite proves each half; this is the
  join between them, which is where the feature was broken. **One correction, now that a real
  report exists:** the file was a genuine PDF but its *text* was the suite's invented fixture built
  to the spec's structure, so that run proved the join and not that this report shape occurs in the
  wild. It does not — see the next bullet.
- **`book_stock` is a closing figure — settled, on the real report's own labeling.** The real
  sample's tank table header reads `Fuel Tank Opening Balance RTT Addition Liters Sold Book Stock
  Closing Dipping Variance`, which places `Book Stock` after `Liters Sold` and immediately before
  `Closing Dipping` — the *expected closing* slot — and the report's own figures agree:
  `AGO 3   954.054  0  0  192.597  761.457  762.162  0.705` (954.054 − 192.597 = 761.457, and
  762.162 − 761.457 = 0.705) and `AGO 4  29,692.308  0  0  510  29,182.308  29,178.846  -3.462`.
  The one-shift-offset worry is therefore answered: it is a closing figure, and the variance is
  against the same shift's dip. **What this does not close is the feature's real-data coverage.**
  The parser reads **zero** tank fields from that report, whose section is "Stock Movement By Tank"
  with rows shaped `AGO 1 14,536.842 …` rather than `TANK 1 PMS …` (see Module 1's finding). The
  answer is known; nothing can act on it until the tank section reads a real report. Do not read an
  alert as covering real Petronite data on the strength of this module alone.

---

## UI — remaining screens

| Screen | Status | Evidence / what is missing |
|--------|--------|----------------------------|
| Dashboard (totals, variance trend, attention list, recent table) | **DONE** | `pages/Home.tsx`, `services/dashboard.service.ts`. |
| Shift Report List / History **with variance on every row** | **DONE** | `pages/ShiftReports.tsx`; the variance column is `VarianceCell` in `components/ReportListRow.tsx:36`; summary travels on the row (`packages/shared/src/types.ts:147`). |
| Shift Report review / correction | **DONE** | `pages/ShiftReport.tsx`. |
| Upload | **DONE** | `pages/Upload.tsx`, `lib/shiftReports.ts:59` (XHR for progress). |
| Login / Register | **DONE** | `pages/Login.tsx`, `pages/Register.tsx`. |
| **Failed / Needs-Review Queue as its own view** | **DONE** | `pages/Queue.tsx` at `/review` (OWNER/MANAGER). Two tabs — Needs review / Couldn't be read — over `status` only, no station or date filters, because a queue is a place to work rather than a place to browse. It opens **oldest-first**, which needed a server-side `order` param: reversing a page on the client would reverse only that page, so "Load more" would splice newer rows under older ones. See `order` in `services/shiftReport.service.ts` and `schemas/shiftReport.schema.ts`. Rows link in with `?from=queue`, which is what draws the walk-through bar on the detail screen (`ShiftReport.tsx`): back to the queue, and a "next" into the next unreviewed report of the same status, with an explicit finished/waiting distinction so a failed lookup cannot tell a manager the backlog is empty. Dashboard's two attention tiles and the bell now deep-link to `/review?tab=…` rather than to the history list. |
| **Station Settings** (variance threshold, tank list, attendant roster, attendant aliases) | **DONE** | `pages/StationSettings.tsx` at `/settings` (OWNER/MANAGER), nav row in `Layout.tsx` — the row the mock always listed, withheld until a screen existed behind it. Edits everything `getStationDetail` returns, and creates the **first station** as well. See the section below. |
| **ATTENDANT-facing screen** | **DONE** | `pages/MyShifts.tsx`, drawn by `/` for that role through `HomeRoute` in `components/AppRouter.tsx`; `GET /api/attendants/me` (`routes/attendantProfiles.ts`). The sidebar's first row becomes "My shifts" (`Layout.tsx`) and it is an attendant's only row. The attendant profile list stays out of reach: `/attendants` is still behind `allowedRoles={['OWNER','MANAGER']}` and the API still returns 403, because that list is every colleague's. See the section below. |
| **Wet stock** (per-tank book-versus-dip, trend, alerts) | **DONE** | `pages/TankLeakage.tsx` at `/tanks` (OWNER/MANAGER), nav row in `Layout.tsx` beside the review queue. See Module 3 for the arithmetic and the tests. |
| **Attendants** (per-person variance, trend, three signals, unclaimed names) | **DONE** | `pages/AttendantProfiles.tsx` at `/attendants` (OWNER/MANAGER), nav row in `Layout.tsx` after Wet stock. The trend strip is `components/VarianceBars.tsx`, which `TankTrendBars` now delegates to. See Module 2. |
| **Findings sheet** (one station, printable, from the dashboard) | **DONE** | `pages/FindingsSheet.tsx` at `/findings` (OWNER/MANAGER), linked from the dashboard rather than the sidebar. Prints via `window.print()` with the app's only print block in `index.css`; the sidebar and mobile bar hide themselves with `print:` variants in `Layout.tsx`. See the section below. |

---

## Free-audit findings sheet — **GTM-CRITICAL**

**Status: DONE.**

The document the free audit hands over: one station, one period, printed. `GET /api/findings`
(`routes/findings.ts`, `services/findings.service.ts`) returns the whole sheet; `pages/FindingsSheet.tsx`
at `/findings` renders it and prints it; `Layout` hides its own chrome with `print:` variants and
`index.css` holds the one print block in the app (`@page`, `break-inside: avoid`,
`print-color-adjust: exact` on the sheet).

The design decision worth keeping: **the sheet computes nothing.** It calls `getDashboardSummary`,
`getAttendantProfiles` and `getTankLeakage` — the three services behind the three screens — and
reports what they say. The only new query is the per-shift evidence table, which no screen returns
in full (the dashboard's recent list stops at eight and its trend drops the file names), and it
reads the same rows through the same `computeSummary`. So the sheet cannot disagree with the screen
it was built from, which is the one way a document like this does real damage —
`tests/findings.integration.test.ts` asserts the agreement anyway, because "by construction" is a
claim a refactor can invalidate and a printed page cannot be recalled.

The **headlines are generated server-side**, in the same function that has the figures, for the same
reason: a client that assembled the prose would be free to describe a clean period over a table of
shortfalls. They use a local `formatTZS` duplicating `apps/frontend/src/lib/format.ts`; the twelve
lines are bought back by the sentence and the table below it being incapable of using different
numbers.

Two properties the tests pin deliberately:

- **A clean period says so.** "No reports were uploaded", "every shift balanced" and "all reports
  failed to reconcile" are three different findings, and a blank sheet renders them all the same
  way. Each has its own headline.
- **`provisional` is on the document, not the row.** If any reading under the period is still
  flagged, the sheet says so at the top. It is handed to somebody as evidence; it has to say when
  it is not finished.

Access is `OWNER`/`MANAGER` plus the usual `hasStationAccess && stationExistsInTenant` pair, and
the role gate is the second deliberate one in the product: an ATTENDANT assigned to the station
would pass `hasStationAccess`, and this is the read that names people and is designed to leave the
building (`tests/findings.routes.test.ts`).

Reached from the dashboard rather than the sidebar — it is the dashboard written down, not a sixth
place to go — and it carries the station the reader was already looking at (`?stationId=`).

One deliberate divergence from every other screen: **changing the station or the period clears the
sheet rather than leaving the old one up behind a banner.** The other screens keep stale figures
visible so a slow load does not blank the page, which is right for a console and wrong for a
document — a stale sheet under a freshly-chosen station name is a printed page attributing one
forecourt's shortfalls to another.

---

## Station settings — **DONE**

**Status: DONE.** `pages/StationSettings.tsx` at `/settings`, `lib/stations.ts` extended with the
writes (`createStation`, `updateStation`, `createTank`, `updateTank`, `createAttendant`,
`updateAttendant`; the alias pair already existed). **No backend change was needed** — every
endpoint was already there and already covered by `tests/stations.test.ts` and
`tests/attendantProfiles.routes.test.ts`, so this was the UI gap the plan said it was.

Three things shape the screen, and each is a decision rather than a layout:

- **Two guards, mirrored.** The server reserves a station's own identity — name, location,
  `varianceThreshold`, trading — for the owner (`canAdministerStation` in `routes/stations.ts`) and
  lets a manager fill in the tanks and attendants of the station they run. The screen mirrors
  both: a manager sees the station card read-only and the two lists editable. A button the API is
  about to refuse is worse than no button, because it turns a permissions boundary into an error
  message. Verified against the running dev API: manager `PATCH /stations/:id` → 403 while manager
  `POST /stations/:id/tanks` → 201.
- **A name and a key are different fields.** The name is what the report prints; the key is what
  the parser derives from it (`tank:<key>:book_stock`). Both are shown and both are editable, and
  the form always sends the key it was shown. The server re-derives the key from the name when
  none is sent, which is right for a typo fix and wrong for anything else — a rename would re-key
  the tank and point its history at a spelling no report has printed.
- **Nothing here is deleted.** A tank, an attendant and a station are retired; an alias is
  unlinked. All four are reversible, which is why none asks for confirmation — the button that
  undoes it is the button that did it. Unlinking an alias touches no report: the shifts filed
  under that spelling simply stop counting towards the person and go back to being unclaimed.

Two smaller things:

- **The first station.** Registering creates a tenant and an owner and no station at all, so an
  owner who has just signed up had a dashboard with nothing behind it and no way to put anything
  there. The screen's empty state *is* the create form.
- **The leakage screen's `unmapped` tanks now link here** (`/settings?stationId=…&newTank=<key>`,
  `TankLeakage.tsx`), arriving with the form already open on the exact key the reports are
  printing. That closes a loop the panel had only ever described in prose ("Name them on the
  station and they appear here") with nothing behind it. The first alias still belongs where the
  stray name is met, on `/attendants`; this screen is for the bulk of them.

**A type lie corrected in passing:** `listStations()` was typed `Station[]` while the API returns
`StationSummary` — `tenantId`, `createdAt` and `updatedAt` do not exist on the wire, and
`isActive`/`varianceThreshold`/the two counts do. Nothing dereferenced the missing fields, so it
was latent. The settings screen needs the real ones, so the type was fixed and the six call sites
updated.

**Linking a *login* to an attendant record (`Attendant.userId`)** was the one thing here the plan
deliberately held back, because it needed the answer to "what does an attendant see" first. It has
both halves now, in two places: the picker on each attendant row joins the record to a login, and
the Access card below it is where the login comes from at all. See the section below.


---

## Attendant-facing screen — **DONE**

**Status: DONE.** `/` draws `pages/MyShifts.tsx` for an ATTENDANT and `pages/Home.tsx` for
everybody else (`HomeRoute` in `components/AppRouter.tsx`). The record comes from a new read,
`GET /api/attendants/me` (`routes/attendantProfiles.ts`, `services/attendantProfile.service.ts`),
with `MyAttendantProfile` on the shared types. Six new tests in
`tests/attendantProfiles.routes.test.ts` (27 in the file, 253 across the backend suite).

Five decisions carry the screen:

- **The record is the authorisation.** The endpoint resolves the caller's own `Attendant` row and
  answers about that person, with no `stationId` in the request and nothing checked against the
  caller's station assignments. That is deliberate: an attendant's link is what says which shifts
  are theirs, and requiring a station assignment as well would mean a correct link that silently
  returns nothing. The consequence is that the answer is narrower than the caller's reach, never
  wider — `tests/attendantProfiles.routes.test.ts` pins the case where the record's station is not
  the caller's assigned one, and the record wins.
- **The figures are the manager's figures, by construction.** The handler calls the same
  `getAttendantProfiles` the profiling screen does and picks its own row out. A number disputed
  with a manager is the same number on both screens, because it is the same computation — not two
  implementations that agree today.
- **`linked: false` at HTTP 200, not 403.** For an attendant an unlinked login is an unmade link
  and therefore actionable ("whoever runs the station can link the two in Station settings"); for
  an owner or a manager it is simply the ordinary state. A 403 would have made the one screen an
  attendant can reach an error page, and would have made the manager's own record look forbidden.
- **Figures, not verdicts.** The screen shows the person's own variance, the middle shift, the
  worst shift and the trend, and marks each shift against the station's published
  `varianceThreshold` — and stops there. The three signals (`single_shift`,
  `recurring_shortfall`, `worsening_drift`) are **not rendered**: they are the product's
  accusation layer, built to tell a manager who to look at, and they are heuristics — "most of
  their shifts were short" is a majority test, not a finding. Showing one to the person it names
  would be an accusation made by software with nobody in the loop, which is the same objection
  `linkAttendantAlias` raises against joining a stray name on a fuzzy match. The line itself is
  disclosed, because a shift marked "over the line" against a number the reader cannot see is
  worse than either extreme.
- **No link into the shift reports.** A report detail is the whole forecourt's shift — every
  colleague's attendant row, the tank readings, the cash reconciliation. The list is a record to
  read, not a set of doors.

**The login chain is closed in two steps, and it needed both.** First, `AttendantForm` on Station
settings gained a **login picker**, which is where `Attendant.userId` finally gets set. It is
guarded by a `userIdTouched` flag, for the reason the tank form sends the key it was shown: the
list it is given is the logins *assigned to this station*, while a link is checked against the
tenant, so a record can be joined to a login that is not in that list — and sending the empty
value back on an unrelated rename would silently unlink that person.

Second, and this is the part the plan did not anticipate: **nothing in the product could create a
login at all.** `POST /users` and `PATCH /users/:id` have existed since `0.1` and no screen called
them, so the ATTENDANT role was reachable only through the API and the screen above would have
been behind a door nobody could make. The Access card on Station settings is now the staff screen
for an owner — add a login (email, initial password, role, born on this station), move an existing
one on or off the station, retire and bring one back — over a new `lib/users.ts`. Two details are
load-bearing:

- **It reads the full roster (`GET /users`), not just this station's list.** The server *replaces*
  `stationIds` on a write, so an owner assigning somebody from this page without knowing their
  other stations would quietly remove them from all of them. The card always sends the whole list
  it read.
- **Only an owner sees any of it** (`canManageUsers` ↔ `canProvision` in `routes/users.ts`), and
  an owner's own row offers nothing, because the API refuses a self-change outright. Role changes
  are left out on purpose: this card is about who can reach this station, and promoting a manager
  is a staffing decision rather than a station one.

The dev seed now creates `attendant@fuelflow.local` (password `password`), assigned to the demo
station and linked to **John Mwaka** — one of the two names the sample reports already print, so
signing in as that login lands on figures rather than on the empty state. It claims the link only
when it is unset, so re-seeding never undoes a link somebody changed by hand.

**The bypass this screen implied, now closed.** This paragraph used to say that an attendant
assigned to a station "can still reach `GET /shift-reports`, `GET /shift-reports/:id` and
`GET /dashboard?stationId=…` by URL and see the station's collective figures", and treated that as
a product decision to be made later. The premise was wrong for one of the three. A report's
**detail** is not the station's collective figures: it carries every colleague's attendant row —
the money each of them was due and handed over — and `getAttendantProfiles` derives its numbers
from exactly those rows. So `/attendants/profiles` refused an attendant a 403 on the stated ground
that "the list is every colleague's", while `GET /shift-reports/:id` served the same figures to the
same caller, and the refusal was decorative. An attendant posted to the station *and* refused was
the test case, and it is now pinned. `GET /shift-reports/:id` and `GET /shift-reports/:id/file`
(the uploaded PDF, where the same rows are printed) take the role gate every write already had
(`canReadReport`, `routes/shiftReports.ts`); the findings sheet had reached the same conclusion
about the same figures — "an attendant being assigned to the station is not consent to be given a
document about the people working beside them". The two frontend routes went with them, because a
list whose every row opens a door that is locked is not a screen to show anybody, and the sidebar
already gives that role one row. Tests: `tests/shiftReports.routes.test.ts` ("GET
/api/shift-reports/:id and the uploaded file", 7 — the manager's 200 that shows the colleague row
first, then the refusals).

**Still genuinely open, and unchanged by that fix:** `GET /shift-reports` (the list) and
`GET /dashboard?stationId=…` remain readable by an attendant. Both carry only the shift's own
totals and name nobody, and an attendant's screen already shows them their share of that same
arithmetic, so hiding it would withhold the denominator rather than a secret. But whether an
attendant login is a personal record or a station user is a question this plan has not answered,
and it is now answered in exactly one place instead of two — the boundary is pinned by a test
(`tests/shiftReports.routes.test.ts`, "still lets an attendant read the station's list of reports,
which names nobody") so that moving it is a deliberate change rather than a drift.

---

## Ordering (what to build next, pilot-first)

**P0 — pilot blockers** — ✅ **complete**
1. ~~`0.1` User & station provisioning API~~ **DONE**
2. ~~`0.3` + `0.4` Auth hardening~~ **DONE**
3. ~~`0.5` + `0.6` Rate limiting + fail-closed JWT secret~~ **DONE**
4. ~~`0.2` Station CRUD with variance threshold~~ **DONE**
5. ~~`0.7` Password reset / email delivery~~ **DONE** — see the P2 list below

**P1 — core reconciliation completeness**
5. Module 1 hardening — **PARTIAL**: CI and real-PDF-in-CI are done, and OCR is absent by design.
   Template coverage is no longer *blocked* on a sample — one arrived, and it does not match the
   template. That is a finding, written up under Module 1, and it is a decision to make rather than
   work to sequence
6. ~~Failed / Needs-Review queue as a dedicated view~~ **DONE**
7. ~~Module 3 — wet-stock leakage~~ **DONE**
8. ~~Module 2 — attendant micro-loss profiling~~ **DONE**
9. ~~Reviewer rationale capture on corrections~~ **DONE**
10. ~~Bulk review / next-unreviewed flow~~ **DONE**
11. ~~The unreadable attendant row, a flag nothing could clear~~ **DONE** — the parser writes the
    row as its two figures, empty and flagged, so the correction control fills them in. Written
    up under Module 1, open item (d), with the test files that cover it.
12. ~~The shift-report detail, served to the people the profiling screen refuses~~ **DONE** — an
    attendant was refused every colleague's figures by `GET /api/attendants/profiles` and handed
    them by `GET /api/shift-reports/:id`. Found while re-reading the attendant screen's own
    reasoning, not from a report. See the closing note under "ATTENDANT-facing screen".

**P1 is complete.** Module 1's remaining open item is no longer blocked on a missing input: the real
Petronite sample the plan had been waiting for arrived, and it does not match the template — it
misreads the report's Cash Sales product table as attendant rows and files fuel products as named
people's money, unflagged. That is written up under Module 1 with the stored `ExtractedField` values
as evidence. OCR is still absent by design, and widening the template is a coverage decision for a
human, not a patch to make quietly.
One question is open rather than blocked, and it is recorded as such: whether an attendant may read
the station's *collective* figures — the report list and the dashboard — which name nobody and
which the station assignment already answers. See "ATTENDANT-facing screen".

**P2 — go-to-market & remaining UI**
10. ~~Free-audit findings sheet export~~ **DONE**
11. ~~Station Settings screen (threshold, tank list, roster, attendant aliases)~~ **DONE**
12. ~~ATTENDANT-facing screen~~ **DONE**
13. ~~Password reset / email delivery (`0.7`)~~ **DONE**

**Phase 0 and the sequenced P2 list are complete.** What is left is not a queue of screens:
Module 1's parser does not match the real Petronite report that arrived, and closing that means
choosing what the template should be and re-testing against real documents; the deployment half of
`0.7` — an actual `SMTP_URL` and a public `APP_URL` — is an operational decision rather than code.
Until those are set, password reset answers 503 in production by design.

**One known defect is open, and it is the first one this document has had to record rather than
close.** A real Petronite report is accepted by the 3-marker gate and then read along the wrong
lines: the Cash Sales product table is parsed as attendant rows, so `AGO - DIESEL` is filed as a
person owed TZS 502.597 who collected TZS 3,998, at HIGH confidence and with `needsReview: false`,
and the three attendants actually printed on the report are not read at all. It is left open
deliberately — patching it locally would widen the template until the threshold means nothing, and
which layout the parser should be built for is a coverage decision. Module 1 carries the evidence;
the sample is in the repository root.

**Both of the closed defects were the same shape** — a flag the product had written and then left
without a way to act on. An unreadable attendant row was a review flag with no control that could
clear it, so a report carrying one sat in NEEDS_REVIEW for good (P1 item 11). And an attendant was
refused every colleague's figures by `/attendants/profiles` while `GET /shift-reports/:id` served
them the same figures — a refusal that a second route made decorative (P1 item 12). Both are fixed
and both are pinned by tests.
