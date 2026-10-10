# NexCampus: AI Handover Brief

Paste this file into the next AI together with `nexcampus.html` (attached alongside). Read all of it before acting.

## Role for you
Act as a senior full-stack engineer, backend architect, DB designer, UI/UX designer, QA engineer and security reviewer. Continue the project from its current state. Do not rebuild from scratch, and do not delete working code.

## Project
NexCampus: digital campus management platform. Tagline: "One Campus. Every Connection. Smarter Decisions."
Users: Student, Faculty, Parent, Alumni, Head of Department, Administrator.
Team: Mohammad Abrar, Kanika, Shamili, Pavitha.
Top priority: the Placement Preparation module.

## Current state
- Only deliverable: `nexcampus.html`, a single-file front-end prototype (HTML, CSS, vanilla JS, no build step, no framework).
- No backend, database, real auth or automated tests exist.
- All data is stored in browser localStorage. Keys: `nx_attempts`, `nx_active`, `nx_policy`, `nx_user`, `nx_n`, `nx_g` (unused).
- Nothing has been run through tests or checked on real devices.

## What the prototype already does
- Demo sign-in (role picker, no password). Role-based menus:
  - Student: Home, Practice, Mock test, Weak topics and plan, Coding practice, Notifications, Modules
  - Administrator: Exam policy, Notifications, Modules
  - Faculty and HOD: Notifications, Modules
  - Parent and Alumni: Notifications, Modules
- Question bank: 32 sample MCQs across 8 categories (Quantitative Aptitude, Logical Reasoning, Verbal Ability, Programming Fundamentals, DSA, DBMS, OS, Computer Networks), with topics, Easy/Medium/Hard and explanations.
- Practice mode: filters, optional timer, review with explanations, retry incorrect.
- Timed mock test:
  - Configurable count, duration and category.
  - Clock-based countdown, question palette, mark for review, clear answer, submit confirmation.
  - Auto-submit at expiry and resume after refresh.
  - Results: correct, incorrect, unanswered, test % (correct/total), accuracy % (correct/attempted, zero-safe), time taken, topic breakdown, answer review.
- Focus monitoring: `visibilitychange` plus `blur`/`focus`, with overlapping duplicates ignored. The timer is never paused. A notice appears on return.
- Exam policy screen: monitoring on/off, warning threshold, maximum events, action at limit (warn, acknowledge, auto-submit). The default is warn only.
- Dashboard: GitHub-style 6-month activity grid and square tiles (topic, category, per-mock score), difficulty table, recent attempts, all computed from saved attempts. Empty state when there is no data.
- Weak topics: flagged only if attempted ≥ minimum (default 4) and accuracy < threshold (default 60%). Shows evidence and a next step. "Practice this topic" opens practice with filters applied. Includes a practice plan. It is rule-based, not AI.
- Coding practice: 2 sample-based problems, no code execution.
- Notifications are generated from test results.
- Grievance code exists in the file but was removed from all menus at the owner's request. Do not re-add it unless asked.

## Design system (keep)
Background #101010, secondary #181818, gold #D4AF37, text #F5F5F5, secondary text #B8B8B8, borders #333333. Font: Instrument Sans. Gold is used sparingly. Subtle animation only (fade-in, count-up, staggered squares), disabled under `prefers-reduced-motion`. Keep visible focus outlines and keyboard accessibility. Avoid generic AI-dashboard looks, fake stats and dead buttons.

## Known problems (must fix in a real build)
1. Scoring, timer and answers run client-side, and correct answers are visible in the source. The server must own them.
2. Roles are not enforced and sign-in is a demo.
3. Data is per-browser and notifications go to a role, not a user.
4. Focus events are client-reported and can be altered. Never claim they prove cheating or prevent it.
5. No tests, no admin question-bank screen, only 32 questions.

## Not built yet
Backend and DB, real auth, student/faculty/parent/alumni/HOD/admin campus dashboards, attendance, marks, timetable, assignments, alumni mentorship, resource booking, Campus Impact Engine, Faculty Load Balancer, academic insights, parent portal, events, cafeteria, transport (label simulated data clearly), audit logs, admin question bank and mock-test configuration.

## Hard rules from the original brief
- Never expose correct answers before submission.
- Never trust client-supplied score, role, user ID or time. Derive identity from the server session.
- Backend: store start and expiry time, reject late changes, make submission idempotent (no duplicate attempts), score on the server.
- Persist per attempt: student, test, attempt id, start, expiry, submit time, answers, counts, score, %, time taken, category and topic breakdown.
- Monitoring endpoint: ownership and state checks, server timestamp, sequence number, policy applied. No screenshots, webcam, history or reading other tabs. Show a privacy notice before the test.
- Auto-submit on focus loss only if explicitly enabled. Never auto-zero marks.
- Recommendations must come from saved results, explain their evidence, and never be called AI unless a real model exists.
- Parents must never access mentorship. Mentorship is visible only to the student and the alumnus involved. Admins get no default access to private conversations.
- Prevent room booking conflicts in the backend. Timetable changes need approval.
- Do not implement a gate pass, a Student Digital Twin or a separate study planner.
- Do not claim live GPS, email, SMS or push works unless configured and tested.
- Use parameterized queries, hashed passwords, input validation on client and server, no hard-coded secrets, and audit logs for admin actions.
- Do not report tests as passed unless they were run.

## Suggested order of work
1. Pick stack (ask the owner if unsure; SQLite is fine for a local demo).
2. Backend for placement: questions (answers private), tests, attempts, scoring service, monitoring events, policy, analytics endpoints. Wire the existing UI to it.
3. Write and run the placement tests: scoring, expiry, duplicates, answer privacy, cross-student access, monitoring thresholds, auto-submit only when configured, refresh and resume.
4. Admin question bank and exam configuration.
5. Remaining campus modules and role dashboards.
6. Security review, then a final report: features done, features missing, files changed, run commands, real test results, demo accounts, known issues.

## First action
Inspect `nexcampus.html`, summarise the plan in a few lines, then start step 2.
