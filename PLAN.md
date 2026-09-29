# FuelFlow Authentication & RBAC Implementation Plan

## Goal
Implement authentication and role-based access control across the monorepo before adding any business logic. This must include tenant-scoped Prisma queries, JWT auth/refresh flow, role middleware, frontend auth state, route guards, and end-to-end verification.

## Backend Plan

### Dependencies to add
- `argon2` for password hashing
- `@fastify/jwt` for JWT signing/verification
- `@fastify/cookie` for refresh token cookies
- `zod` already present

### Prisma schema changes
- Add `ExtractedField` model (referenced in the prompt) for future PDF-parsed fields.
- Add `StationAssignment` model linking `User` to `Station` so managers/attendants can be assigned to specific stations.
- Add `refreshToken` string to `User` to store hashed refresh tokens for rotation/revocation.

### Auth modules
1. **Schemas** (`src/schemas/auth.schema.ts`)
   - `registerBody`, `loginBody`, `refreshBody` with Zod.
2. **Password service** (`src/services/password.service.ts`)
   - `hashPassword`, `verifyPassword` using argon2.
3. **Token service** (`src/services/token.service.ts`)
   - `createAccessToken`, `createRefreshToken`, `verifyRefreshToken`, `hashRefreshToken`.
4. **Auth service** (`src/services/auth.service.ts`)
   - `registerTenantAndOwner` (creates tenant + owner user, returns tokens).
   - `login` (email/password, returns tokens and sets refresh cookie).
   - `refreshAccessToken` (validates refresh token hash, issues new access token).
5. **Auth routes** (`src/routes/auth.ts`)
   - `POST /api/auth/register`
   - `POST /api/auth/login`
   - `POST /api/auth/refresh`
6. **Prisma client with tenant scoping** (`src/prisma/client.ts`)
   - A Prisma middleware that automatically injects `tenantId` into `findUnique`, `findFirst`, `findMany`, `update`, `delete`, `create`, and `aggregate` queries for `Station`, `User`, `ShiftReport`, and `ExtractedField`.
   - The middleware reads `tenantId` from an AsyncLocalStorage context.
   - A helper `withTenantScope(tenantId, callback)` sets the ALS context.
   - `findUnique` requires `where: { id, tenantId }` style arguments; the middleware will inject tenantId if missing.
7. **Auth middleware** (`src/middleware/auth.ts`)
   - Verify access JWT from `Authorization: Bearer <token>` header.
   - Load user from DB, populate `req.user` with `{ id, tenantId, role, stationIds }`.
   - Reject 401 on missing/invalid token.
8. **RBAC middleware** (`src/middleware/rbac.ts`)
   - `requireRole(roles: UserRole[])` returns Fastify preHandler.
   - Additionally check station assignment for MANAGER/ATTENDANT when target stationId is present.
9. **App wiring** (`src/app.ts`)
   - Register `@fastify/jwt`, `@fastify/cookie`.
   - Add `authenticate` hook to all routes by default; routes can opt out with `config: { public: true }`.
   - Wrap route handlers with tenant scoping automatically using `onRequest` hook that reads `req.user.tenantId`.

### Seed script
- `apps/backend/src/prisma/seed.ts`
  - Create one tenant: "Demo Fuel Station".
  - Create one owner user with email `owner@fuelflow.local` and password `password`.
  - Create one manager user with email `manager@fuelflow.local` and password `password`, assigned to the created station.
  - Create one station belonging to the tenant.
- Add `prisma:seed` script and `prisma.seed` field in `package.json`.

### Testing backend
- `apps/backend/tests/auth.test.ts`
  - Register returns tokens.
  - Login with valid credentials returns tokens.
  - Login with invalid credentials returns 401.
  - Accessing protected route without token returns 401.
  - Accessing protected route with cross-tenant data is rejected (tenant scoping).
  - ATTENDANT cannot hit upload/correction-like routes (RBAC).

## Frontend Plan

### Dependencies to add
- `zustand` for auth store
- `js-cookie` or just localStorage for access token
- `react-router-dom` already present

### Auth modules
1. **Types** (`src/types/auth.ts`)
   - `AuthUser`, `AuthTokens`.
2. **API client** (`src/lib/api.ts`)
   - Attach `Authorization` header from auth store.
   - On 401, attempt refresh once via `/api/auth/refresh`.
   - On refresh failure, redirect to `/login`.
3. **Auth store** (`src/stores/auth.ts`)
   - Zustand store: `user`, `tenant`, `accessToken`, `setAuth`, `logout`, `hydrate` from localStorage.
4. **Login page** (`src/pages/Login.tsx`)
   - Email/password form, calls `/api/auth/login`, stores token, redirects to `/`.
5. **Route guards** (`src/components/ProtectedRoute.tsx`)
   - Redirect to `/login` if no access token.
6. **Role-aware helpers** (`src/lib/rbac.ts`)
   - `canUpload(role)`, `canCorrect(role)`, `canManageUsers(role)`.
7. **UI wiring**
   - Update `AppRouter` with protected routes for `/upload` and `/shift-reports/:id`.
   - Update `Home` with role-aware action links/buttons.
8. **Register page** (`src/pages/Register.tsx`) optional but useful for onboarding test; include a minimal one.

### Testing frontend
- Manual E2E: register tenant, login, verify authenticated requests succeed and unauthenticated/cross-tenant requests fail.

## End-to-end verification checklist
1. `pnpm db:seed` creates owner + manager + station.
2. `docker compose up --build` starts clean.
3. `curl /api/auth/register` creates tenant/user and returns tokens.
4. `curl /api/auth/login` returns tokens.
5. `curl /api/auth/refresh` returns new access token.
6. `curl -H "Authorization: Bearer ..." /api/health` or a protected test route succeeds.
7. Missing/invalid token on protected route returns 401.
8. Tenant A token cannot read Tenant B data.
9. ATTENDANT token cannot access manager/owner endpoints.
10. Frontend login stores token; protected routes redirect when logged out.
