# Changelog - Shadow Writer (`shadow-writer`)

All notable changes to this project will be documented in this file.

---

## [1.5.0] - 2026-07-17

### Added
- **Dynamic Parent-Subagent Orchestration**: Introduced a goal-oriented Parent Agent that analyzes requests and generates dynamic JSON task list workflows, and a `SubagentEngine` with Plan-Execute-Test loops.
  - Linked commit: [`bcea74b`](https://github.com/Shadow-Plays-de/shadow-writer/commit/bcea74bbdf9a95781a74d2b2c89fbfd397c11f4a)
- **Artifacts Database Collection**: Created a dedicated MongoDB `Artifact` collection to store intermediate subagent outputs and planning notes, separating them from user-facing Notes.
  - Linked commit: [`4301588`](https://github.com/Shadow-Plays-de/shadow-writer/commit/4301588d9255a88cbf32890db3c80a2b588667c2)
- **Direct Vertex AI & Gemini REST Client**: Integrated native Gemini model calling directly in Node.js using Vertex AI authentication (Google Service Accounts) or API Keys fallback.
  - Linked commit: [`9272a70`](https://github.com/Shadow-Plays-de/shadow-writer/commit/9272a70d8a57e6c4e0bcfdf9a8e976db5db78b0f)
- **Automated GHCR Deployment Workflow**: Added GitHub Actions workflow to build, tag, and publish Docker images to GitHub Container Registry (GHCR) upon release or tag push.
  - Linked commit: [`2db5c11`](https://github.com/Shadow-Plays-de/shadow-writer/commit/2db5c11de3a7fbe947d1f56be9c57e6027a4d8b9)
- **API Key & CORS Hardening**: Added middleware to validate the `MCP_API_KEY` header and support dynamic allowed CORS origins.
  - Linked commit: [`b4512a7`](https://github.com/Shadow-Plays-de/shadow-writer/commit/b4512a7d1cc96c21e06fa825c898c60a2d59ea0e)
- **Context Files API Endpoints**: Added endpoints (`GET`/`POST`/`PUT`/`DELETE` `/api/context-files`) to manage project-specific background dossiers and brain dumps.
  - Linked commit: [`c53cd26`](https://github.com/Shadow-Plays-de/shadow-writer/commit/c53cd269933de3053e4de8b9c38ca02f242a4330)
- **Template Chaining**: Extended templates metadata to support workflow behaviors (`Context Skill` / `Agent Workflow`) and sequential pipeline forwarding (`nextTemplateId`).
  - Linked commit: [`9dc98dd`](https://github.com/Shadow-Plays-de/shadow-writer/commit/9dc98ddf54d2b4cb9cf5a3158e64464c9c04c7c4)
- **Project Configuration Fields**: Added `writingPOV`, `writingTense`, and `genre` fields to the MongoDB schema.
  - Linked commit: [`bbfb265`](https://github.com/Shadow-Plays-de/shadow-writer/commit/bbfb265de3e7a9e14a1e94de8a74e987c2b58866)

### Changed
- **Database Migration**: Replaced the brittle JSON file-based storage with MongoDB. Added auto-import seeding scripts to parse existing markdown files and character attributes.
  - Linked commit: [`86e8fc6`](https://github.com/Shadow-Plays-de/shadow-writer/commit/86e8fc6)
- **System Isolation**: Refactored `server.js` by splitting orchestration scripts into `agentEngine.js` and prompt compilers into `prompt.js`.
  - Linked commit: [`cc8d4a8`](https://github.com/Shadow-Plays-de/shadow-writer/commit/cc8d4a8d438fbcfde7563d11b2b8c9d09bb0d8f0)
- **Template Restructuring**: Reworked writing and critique templates to enforce high-fidelity "shaping and typewriting" narrative behaviors (no head-hopping, dynamic action pacing).
  - Linked commit: [`43b0980`](https://github.com/Shadow-Plays-de/shadow-writer/commit/43b0980d2bbfdfa3cb49a46cbfd397223b5d15ca)
- **Agy CLI Migration**: Migrated the automation scripts execution backend to use the host's `agy` CLI instead of `antigravity` calls.
  - Linked commit: [`0d60bbc`](https://github.com/Shadow-Plays-de/shadow-writer/commit/0d60bbcd457e8be2d5c1bcf6a8d7be89ccab4de5)

### Fixed
- **Bearer Token Resolution**: Resolved JWT client OAuth token construction for service accounts which caused 401 unauthenticated calls to Vertex AI.
  - Linked commit: [`5b03ec7`](https://github.com/Shadow-Plays-de/shadow-writer/commit/5b03ec7d5e49c7bcde43b0a2bf923ef1f5c35b5a)
- **Vertex REP Endpoints Routing**: Fixed 404 Model Garden errors on Gemini 3.5/3.1 calls by mapping standard regions to Representative Endpoints (`aiplatform.us.rep.googleapis.com` / `aiplatform.eu.rep.googleapis.com`).
  - Linked commit: [`de1f03f`](https://github.com/Shadow-Plays-de/shadow-writer/commit/de1f03fdf5a79bfd0a89d7b97e937d97637db7b9)
- **Vulnerability Failures**: Installed `ca-certificates` and `git` inside the Docker image to prevent certificate validation errors and git spawning issues in production containers.
  - Linked commit: [`cc8d4a8`](https://github.com/Shadow-Plays-de/shadow-writer/commit/cc8d4a8d438fbcfde7563d11b2b8c9d09bb0d8f0)
- **Job ID Collision**: Fixed unique `jobId` missing attributes when creating history entries during character save and note deletion.
  - Linked commit: [`a8979c2`](https://github.com/Shadow-Plays-de/shadow-writer/commit/a8979c2df8b1a478b0c67e9cd0cc95963f278c2e)
