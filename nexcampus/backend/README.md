# NexCampus backend (placement assessment core)

Zero-dependency Node.js service: `node:http` + built-in `node:sqlite` + `crypto.scrypt`. Needs Node 22.5+.
Express and a validation library were not used because package installation was unavailable when this was built; handlers are plain functions in `src/app.js` and can be moved onto Express later.

## Run
    cd backend
    # optional: create an administrator on startup
    ADMIN_EMAIL=admin@example.edu ADMIN_PASSWORD='choose-a-strong-one' npm start
    npm test

Server: http://localhost:3000 (serves ../nexcampus.html at /). The database is created at `data/nexcampus.db` on first start
(migrations in `migrations/`, 32 questions seeded from the frontend). The app reads environment variables only; see `.env.example`
for the names (PORT, DB_FILE, ADMIN_EMAIL, ADMIN_PASSWORD, COOKIE_SECURE, FRONTEND_FILE).

## Security model
- scrypt password hashes; random session tokens stored hashed; HttpOnly + SameSite=Strict cookie (`COOKIE_SECURE=1` behind HTTPS).
- Role is never accepted from the client: self-registration always creates a student; admins come from `ADMIN_EMAIL`.
- Every attempt query is scoped to the session user (other users get 404). Admin routes return 403 for non-admins.
- Answer keys are only selected in the post-submission result query and in admin question routes.
- Rate limits per IP and on failed logins. JSON-only bodies, 100 KB cap, cross-origin writes blocked.

## API (JSON; * = admin only)
| Method | Path | Purpose |
|---|---|---|
| POST | /api/auth/register, /login, /logout | Account and session |
| GET | /api/auth/me | Current user |
| GET | /api/categories, /api/policy | Categories/topics, current exam policy |
| GET | /api/questions?category&topic&difficulty&page&pageSize | Question list (no answers) |
| POST | /api/attempts | `{mode:'mock'\|'practice',count,durationMinutes?,category?,topic?,difficulty?}`; resumes an open attempt of the same mode |
| GET | /api/attempts/:id | State, questions, saved answers, `expiresAt`, `serverNow` |
| PUT | /api/attempts/:id/answers | `{questionId,selected?,marked?}`; `selected:null` clears |
| POST | /api/attempts/:id/submit | Idempotent; scored on the server from saved answers |
| GET | /api/attempts/:id/result | Result and review (after submission only) |
| POST/GET | /api/attempts/:id/events | Record/list focus events (`visibilitychange` or `blur`) |
| GET | /api/students/me/dashboard | Stats from saved results |
| GET | /api/students/me/weak-topics | Rule-based weak topics with evidence and practice filters |
| GET/PATCH | /api/notifications, /api/notifications/read | Own notifications |
| PUT* | /api/admin/policy | `{on,warn,max,act:'warn'\|'confirm'\|'auto',neg}` |
| PUT* | /api/admin/settings/weak-topics | `{min,threshold}` (defaults 4 and 60) |
| POST/PATCH/DELETE* | /api/admin/questions[/:id] | Question bank (delete is soft) |
| GET* | /api/admin/audit | Audit log |

## Behaviour notes
- Test % = correct / total; accuracy % = correct / attempted; both 0 when the denominator is 0. Negative marking is `neg` per wrong answer, default 0.
- Expiry is enforced on every request. After expiry, answer changes get 409 and the attempt is finalized from saved answers (`auto_submitted`, reason `time`).
- Focus events are client-reported signals. Overlapping events within 1.5 s count once. The timer never pauses. Auto-submit happens only when the policy action is `auto`, and keeps saved answers.
- Policy is snapshotted into each attempt at start. Dashboard `activity` dates are UTC.

## Not built yet
Student profiles, jobs/applications/eligibility, recruitment drives, resume analysis, the eight games (including sandboxed code and SQL execution), readiness engine, leaderboards/achievements, other role modules, and wiring `nexcampus.html` to these APIs (it still uses localStorage).
