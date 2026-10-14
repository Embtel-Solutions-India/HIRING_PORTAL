# Hirely: internal applicant tracking

A hiring workspace for your team. Resumes live in **Google Drive**, interviews land on **Google Calendar**, candidate emails go out from **your own domain** (any SMTP provider), and **Claude** summarizes every resume.

- **Pipeline board.** Drag candidates from Screening to Onboarding. The whole team sees the same board, refreshed live.
- **Swipe review.** Flip through resumes and AI summaries with the ‹ › arrows, the ← → keys, or by swiping on a phone. Advance or pass with one key.
- **Roles.** Interviewer, Recruiter, Admin, Super Admin, enforced by the server.
- **Interviews.** Real free/busy from Google Calendar, Google Meet links, scorecards, and Calendly-style booking links that candidates use to pick a time.
- **Email.** Templates with merge fields, bulk sends by job and stage, scheduling, open/click tracking.

**To launch it, follow [DEPLOY.md](DEPLOY.md).**

## Project layout

```
frontend/   React + Vite + Tailwind app (the screens)
backend/    Node API (Fastify + PostgreSQL), Google, SMTP and Claude integrations
Dockerfile, docker-compose.yml, Caddyfile   production setup (app + database + HTTPS)
scripts/    backup / restore / update helpers for the server
```

## Running it on your own computer

You need Node 24+. Run `npm install` once in both `backend/` and `frontend/`. Then open three terminals in this project folder.

1. Local database (leave it running):

```bash
cd backend && npm run dev:db
```

2. API server (optionally run `npm run seed:demo` in backend/ first for sample data):

```bash
cd backend && npm run dev
```

3. The app:

```bash
cd frontend && npm run dev
```

Open http://localhost:5173 and use the **Development sign-in** box with `admin@example.com`, or `priya@example.com` after loading the demo data. Local settings are in `backend/.env`. Emails are printed in terminal 2 instead of being sent.

### Database (Prisma)

The backend talks to Postgres through [Prisma ORM](https://www.prisma.io/). The schema lives in `backend/prisma/schema.prisma` and the SQL migrations in `backend/prisma/migrations/`; the server applies pending migrations every time it starts. `npm install` generates the client into `backend/src/generated/` (re-run `npx prisma generate` after editing the schema).

To change the schema: edit `schema.prisma`, run `npx prisma migrate dev --create-only --name <what-changed>` in `backend/`, review the generated SQL, then restart the server. The database must use the UTC time zone (Supabase and the Docker image already do).

To use a hosted database such as Supabase, set `DATABASE_URL` (the app's connection, e.g. the transaction pooler) and `DIRECT_URL` (used for migrations, e.g. the session pooler) in `backend/.env` or `.env`.

Type-check both projects:

```bash
cd backend && npm run typecheck && cd ../frontend && npm run typecheck
```
