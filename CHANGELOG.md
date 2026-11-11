# Changelog - Shadow Writer (`shadow-writer`)

All notable changes to this project will be documented in this file.

## [1.9.4] - 2026-11-11

### Added
- **Helix Status Guild Member Resolution (`backend/helixEngine.js`, `backend/test_ticket_103_helix_engine.js`)**:
  - Added guild/voice channel member resolution to `GET /api/helix/status` returning `members: [{ id, name, tag }]`.
  - Added support for mock state member resolution in tests and live Discord guild/voice channel cache resolution in production.

## [1.9.3] - 2026-11-08

### Added
- **Helix Discord Voice, STT & WebSocket Engine (`backend/helixEngine.js`, `Dockerfile`, `backend/package.json`)**:
  - Added real-time WebSocket bridge (`/helix/ws`) with `MCP_API_KEY` authentication for Foundry VTT and Flask internal proxy connections (`join_channel`, `leave_channel`, `start_recording`, `stop_recording`, `session_marker`, `update_player_mapping`).
  - Integrated Discord voice capture (`discord.js`, `@discordjs/voice`, `prism-media`, `opusscript`, `libsodium-wrappers`, `ffmpeg`) and streaming Google Cloud Speech-to-Text (`@google-cloud/speech`) with speaker diarization mapped to Foundry VTT character names.
  - Added Discord Bot custom Rich Presence activity (`shadowplays.de — Visit shadowplays.de | Shadowrun & Foundry VTT`) on `ready` and `guildCreate`.
  - Added internal Helix REST endpoints (`/api/helix/status`, `/api/helix/guilds/:guildId/channels`, `/api/helix/config`, `/api/helix/sessions/:sessionId/stop`).
- **Helix Database Models, Artifact CRUD & Shadowrun Genre (`backend/mongoDB.js`, `backend/server.js`, `backend/public/genres.json`)**:
  - Added `HelixConfig` model (`id: "default"`, `guildId`, `guildName`, `channelId`, `channelName`, `language`) and full `/api/artifacts` CRUD routes (`GET`, `POST`, `PUT`, `DELETE`).
  - Preserved `HELIX_METADATA_KEYS` (`sessionId`, `entries`, `markers`, `activePlayers`, `startedAt`, `endedAt`) across `normalizeAttributesToStructuredObjects` and `upsertStructuredDocument` while enforcing Structured Object Storage (`content: ""`, zero `attributes.unstructured`).
  - Seeded the `shadowrun` genre profile (`dossier`, `outline`, `locations`, `organizations`, `secrets`, `lore`, `summary`, `transcript`) and extended `/api/projects/:projectId/export-markdown` and `constructMarkdownFromAttributes` to synthesize `transcript` and `summary` Markdown on-the-fly.
- **Automated Release & GHCR Publish on PR Merge (`.github/workflows/publish_ghcr.yml`)**:
  - Updated GitHub Actions workflow so merging a PR into `master` automatically parses the top version (without a leading `v`) and release notes from `CHANGELOG.md`, creates the GitHub Release and Git tag, and builds/pushes `ghcr.io/shadows-eye/shadow-writer:latest` and `:<version>`.

### Refactored
- **Top-Level Import Consolidation (`backend/server.js`)**: Consolidated all `./mongoDB` and `./editorialEngine` imports at the top of `backend/server.js` and deduplicated `upsertNoteHandler` and `upsertArtifactHandler` into `upsertStructuredDocument`.

---

## [1.9.0] - 2026-08-13

### Added
- **Mongoose Template Schema Extensions (`backend/mongoDB.js`)**: Updated `TemplateSchema` with nested `subagents` array (`step`, `subagentTemplateId`, `contextInputs`, `outputType`, `outputId`), `parentAgentId`, `outputType`, and `outputId` for hierarchical pipeline orchestration.
- **MongoDB Job Collection & Schema**: Added `JobSchema` and `Job` model to track asynchronous multi-subagent background execution pipelines (`jobId`, `projectId`, `pipelineType`, `status`, `logs`, `runs`, `currentStep`, `totalSteps`, `pendingDiffs`).
- **Job REST API Endpoints (`backend/server.js`)**: Added `POST /api/jobs`, `GET /api/jobs/:id`, `PATCH /api/jobs/:id`, and `GET /api/jobs/active/:projectId` endpoints for pipeline run management.
- **Input Sanitization Helper**: Added `extractString` helper in `mongoDB.js` to clean string inputs (such as document names) before database persistence.
- **Clean Document Persistence Middleware**: Added `ensureCleanDocumentOnRead` middleware on `/api/notes`, `/api/characters`, and `/api/chapters` endpoints to strip bad formatting on reads/writes while preserving unstructured fallbacks (`note.content`).

### Changed
- **Execution History API Enhancements**: Updated `/api/history` endpoints to persist and return `pipelineType`, `jobId`, `payload`, `logs`, and `runs`.
- **Character Elements Upsert**: Extended `/api/character-elements` endpoint to support upsert workflows.

### Fixed
- **Unique Subtype Tag Integrity**: Enforced project-level uniqueness for **Master Dossier (`subtypeTag: 'dossier'`)** and **Story Outline (`subtypeTag: 'outline'`)**. Tagging a new note automatically reverts previous dossier/outline tags back to standard notes.

---

## [1.8.2] - 2026-08-11

### Added
- **POST /api/history Endpoint**: Implemented `POST /api/history` in `backend/server.js` to record AI Chat rewrites, formatting runs, and automation executions into the MongoDB History database in real-time.

### Fixed
- **Full History Details Formatting**: Updated `GET /api/history` in `backend/server.js` to return `id`, `userPrompt`, `aiResponse`, `pipelineType`, `status`, and `logs` for full execution log inspection.

---

## [1.8.1] - 2026-08-08

### Fixed
- **AI Prompt Strict Schema Directives**: Updated system prompts in `prompt.js` to mandate strict adherence to existing database JSON schemas, preventing model outputs from inventing unmapped keys or returning raw markdown code fence wrappers (` ```markdown `).

---

## [1.8.0] - 2026-08-07

### Changed
- **MongoDB Document Schema Updates**: Updated MongoDB document schemas and backend endpoints for 1.8.0 chapter structures and stripped legacy unstructured attributes.

---

## [1.7.6] - Unreleased

### Fixed
- **Gemini API Calling Hotfix** `[fix-Migration]`: Fixed a bug where the migration script passed an object payload to the `generateContent` function instead of a positional text string, which triggered Google API `INVALID_ARGUMENT` errors.

---

## [1.7.5] - 2026-08-05

### Added
- **Gemini-Powered Structural Migration** `[feat-Migration]`: Completely rewrote the 1.7.0 structural migration script (`migrate_1_7_0_structure.js`) to intelligently route legacy documents through the backend's native Gemini LLM integration.
- **Deep Prose Attribute Extraction** `[feat-Migration]`: Upgraded the migration prompt sequence to ingest both legacy root keys and the document's raw plain text body (`doc.content`), allowing the LLM to dynamically deduce and map new attributes directly from unstructured narrative prose.
- **Migration Progress Tracking**: Added precise pre-calculation logging and real-time visual `[1/x]` progress indicators to the migration script.

### Fixed
- **Mongoose Map Casting Safety** `[fix-Migration]`: Resolved a severe risk in the migration script where converting the Mongoose Map to a POJO threatened to overwrite or wipe existing `attributes` (like `chapter_content`). The script now safely injects new keys using strict Mongoose `doc.set('attributes.key', value)` syntax to perfectly preserve existing data.

---

## [1.7.0] - 2026-08-05

### Added
- **Database Migration Utilities** `[feat-Layland]`: Added new migration scripts (`migrate_character_attributes.js`, `fix_content.js`) to transition unstructured character data to discrete attributes, split `rank_clearance`, and purge legacy injected markdown from documents.
- **Template Auto-Syncing** `[feat-Layland]`: Implemented startup logic in `mongoDB.js` to automatically read `templates.json` and cleanly `upsert` all templates into the MongoDB collections, ensuring the database is always in sync with local UI schema changes.

### Changed
- **Element Schema Overhaul** `[feat-Layland]`: Updated default `characterElements.json` to formally declare `Race`, `Rank`, `Clearance`, and `Traits` as dedicated entity structures.
- **MongoDB Empty Attribute Deletions** `[feat-Layland]`: Enhanced the backend document update logic to explicitly process and `$unset` null/empty Map keys via `doc.attributes.delete()`, preventing zombie keys from lingering.

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
