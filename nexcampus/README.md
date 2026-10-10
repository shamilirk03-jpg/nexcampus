# NexCampus (student portal)

- `nexcampus.html`: front-end (single file). It opens straight to the student placement dashboard with no login screen.
- `backend/`: Node.js API (Node 22.5+, no npm install needed). See `backend/README.md`.
- `NEXCAMPUS_AI_HANDOVER.md`: project brief for continuing the work. It was written before the login screen was removed.

## Run
    cd backend
    ADMIN_EMAIL=admin@example.edu ADMIN_PASSWORD='choose-a-strong-one' npm start
    npm test

Open http://localhost:3000.

Note: the front-end is not yet connected to the backend and keeps its data in the browser's local storage.
