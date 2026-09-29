# FuelFlow

A fuel station shift-report reconciliation platform built for the Tanzanian market.

FuelFlow lets fuel-station owners, managers, and attendants reconcile shift reports
submitted as PDFs. PDF parsing runs asynchronously as a background job so the
upload request stays fast and responsive.

## Tech Stack

| Layer | Tech |
|-------|------|
| Monorepo | pnpm workspaces + Turborepo |
| API | Fastify + TypeScript |
| ORM / DB | Prisma + PostgreSQL |
| Background jobs | BullMQ + Redis |
| Validation | Zod |
| Frontend | React + Vite + TypeScript |
| Styling | Tailwind CSS |
| Routing | React Router |
| Reverse proxy | Caddy |
| Tooling | ESLint + Prettier + Vitest |

## Project Structure

```
fuelflow/
├── apps/
│   ├── backend/          Fastify API, Prisma schema, BullMQ jobs
│   └── frontend/         React + Vite SPA
├── packages/
│   └── shared/           Shared TypeScript types / interfaces
├── docker-compose.yml    Local Docker orchestration
├── Caddyfile             Reverse-proxy rules
├── turbo.json            Turborepo pipeline
├── pnpm-workspace.yaml   Workspace definition
└── .env.example          Required environment variables
```

## Getting Started

### Prerequisites

- Node.js >= 20
- pnpm 9
- Docker + Docker Compose

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` if you want to change defaults.

### 3. Start everything with Docker Compose

```bash
docker compose up --build
```

Once healthy:

- Frontend: http://localhost
- API health check (via Caddy): http://localhost/api/health
- API direct: http://localhost:3000/health
- PostgreSQL: 127.0.0.1:5433 (see `POSTGRES_PORT` in `.env`)
- Redis: localhost:6379

### Local Development (without Docker)

Start backing services:

```bash
docker compose up postgres redis -d
```

Run the backend:

```bash
pnpm --filter backend dev
```

Run the frontend:

```bash
pnpm --filter frontend dev
```

Run tests:

```bash
pnpm test
```

Run lint:

```bash
pnpm lint
```

## Useful Commands

```bash
pnpm db:generate      # Generate Prisma client
pnpm db:migrate       # Run database migrations
pnpm docker:up        # docker compose up --build
pnpm docker:down      # docker compose down
```

## Notes

- No business logic has been implemented yet; this repository contains scaffolding only.
- PDF parsing is wired as a BullMQ background job (`pdf-parse` queue) with a stub processor ready for implementation.
