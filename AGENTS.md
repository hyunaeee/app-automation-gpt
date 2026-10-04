# Launchpad

Read `CODEX_HANDOFF.md` and `README.md` before continuing substantial development. This repository is the Launchpad AI Development Agent platform; `samples/atelier-mobile/` and `samples/fashion-design/` are generated example applications, not the entire platform.

- Preserve existing user data and sample versions. Local runtime state lives in `.data/` and is intentionally outside Git.
- Keep secrets and signing keys out of source, public assets, screenshots and exports. Use `.env.example` to document configuration names without credentials.
- Keep claims aligned with the implemented path: this Codex task created the Atelier UI reference before coding; a universal automated image-reference-first pipeline remains separate work.
- Use the existing Node/React architecture and trusted runtime boundaries. Consult `docs/` for OpenAI subscription, model routing, Android and Vercel integration details.
- Check whether port 3001 already serves this workspace before starting another local server.
- Validate the behavior affected by each change. `npm run build` checks types and the production bundle. `npm test` and relevant `e2e/` tests cover server and browser behavior.
- If mobile sample code changes, rerun its browser checks and rebuild the APK before labelling it verified. Reports include source hashes and must refer to the delivered code.
- Use Korean for user-facing progress and explanations unless asked otherwise. Prefer reasonable defaults over unnecessary questions.
