# Launchpad implementation contract

Frontend: React + TypeScript + Vite, Korean UI. Backend: Node ESM + Express; generated projects use dependency-free Node runtimes. API JSON uses src/types.ts shapes. Root owner maintains config, scripts, tests, README; frontend owner owns src (except types.ts); backend owner owns server.

- GET /api/config => AppConfig
- GET /api/projects => Project[] (can include all fields; persisted projects)
- POST /api/projects {prompt, kind:'web-app'|'ai-agent'} => Project, HTTP 202, starts asynchronous workflow
- GET /api/projects/:id => Project
- POST /api/projects/:id/cancel => Project
- POST /api/projects/:id/retry => Project, 202
- POST /api/projects/:id/launch => {url}, (re)starts generated project on separate loopback port
- GET /api/projects/:id/download => application/zip standalone source
- GET /api/projects/:id/events => SSE event: project, data: Project JSON (frontend may use polling instead)
- Errors => {error: string}, appropriate status codes.

Stages in order: requirements, features, architecture, scaffold, coding, validation, debugging, delivery. Debugging skipped when checks pass; bounded retries otherwise. Real file generation, syntax + auth/CRUD runtime validation, persisted reports. No fake delay loops. Plan features/assumptions are honest defaults. Local mode label is explicit, never claims arbitrary AI understanding. OpenAI uses Responses API server-side. Never execute model-authored backend code on host; model may author browser assets within allowlisted paths and trusted scaffold backend. Download excludes runtime data, keys and session values. Agent generated runtime uses local deterministic text tool plus optional OpenAI server-side execution when configured.

Project metadata and generated directories live in .data (configurable DATA_DIR). API factory should export createApp(options) for tests, ideally {app, shutdown} or app with lifecycle. Main runtime on 127.0.0.1:3001; Vite proxy /api. Production serves dist. Preview on separate port and hostname localhost if needed for cookie isolation. Root control API rejects cross-origin mutation requests; child code must not access controller credentials.
