# Shadow-Writer & Shadowplays.de Dual-Layer API Reference

This document provides a comprehensive technical reference for interacting with **shadow-writer** services deployed on `https://shadowplays.de`. It describes the dual-layer architecture, authentication protocols, internal routing mechanics, complete endpoint specifications, and practical JavaScript integration patterns for **Foundry VTT modules**.

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [Authentication & Authorization Protocols](#2-authentication--authorization-protocols)
3. [Structured Object Storage Invariants](#3-structured-object-storage-invariants)
4. [Public Gateway Endpoints Catalog](#4-public-gateway-endpoints-catalog)
   - [4.1 System & Authentication](#41-system--authentication)
   - [4.2 Campaign & Project Management](#42-campaign--project-management)
   - [4.3 Entity & Lore Synchronization](#43-entity--lore-synchronization)
   - [4.4 Live Voice & Session Management](#44-live-voice--session-management)
   - [4.5 AI Summaries & Intelligence](#45-ai-summaries--intelligence)
   - [4.6 Shadowrun Compendium & Rules Lookup](#46-shadowrun-compendium--rules-lookup)
   - [4.7 Writer & Editorial Pipelines](#47-writer--editorial-pipelines)
   - [4.8 Streaming & WebSocket Gateways](#48-streaming--websocket-gateways)
5. [Foundry VTT Module Integration Guide](#5-foundry-vtt-module-integration-guide)
   - [5.1 Module Settings Configuration](#51-module-settings-configuration)
   - [5.2 Robust Foundry VTT API Client](#52-robust-foundry-vtt-api-client)
   - [5.3 Syncing Actors (Characters)](#53-syncing-actors-characters)
   - [5.4 Syncing Journals (Lore & Notes)](#54-syncing-journals-lore--notes)
   - [5.5 Managing Live Audio Sessions](#55-managing-live-audio-sessions)
   - [5.6 Generating & Polling Session Summaries](#56-generating--polling-session-summaries)
6. [Status Codes & Error Handling](#6-status-codes--error-handling)

---

## 1. Architecture Overview

Direct external access to the internal `shadow-writer` microservice (port `4000`) is strictly blocked in production. All client communications, including automated requests from Foundry VTT modules and external tools, must pass through the **Flask Public Gateway** on `https://shadowplays.de` (or `http://shadowplays-dev.de` in local development).

```
   ┌────────────────────────────────────────────────────────┐
   │                  Foundry VTT Module                    │
   │               (Client / User Machine)                  │
   └───────────────────────────┬────────────────────────────┘
                               │ HTTPS / WSS
                               │ X-API-Key: <license_key>
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│               Public Reverse Proxy & Ingress Gateway                   │
│                       (shadowplays.de)                                 │
├──────────────────────────────────┬─────────────────────────────────────┤
│   Nginx Reverse Proxy Paths      │   Flask REST API Gateway            │
│   • /writer_backend/sse (SSE)    │   • /api/shadowrun/*                │
│   • /writer_backend/helix/ws (WS)│   • /api/shadowrun/helix/*          │
│                                  │   • /writer/api/*                   │
│                                  │                                     │
│                                  │   [Auth Engine: verify_helix_key]   │
│                                  │   • Validates LicenseKey            │
│                                  │   • Resolves User Context           │
│                                  │   • Attaches downstream headers:    │
│                                  │     x-user-id, x-user-email         │
└─────────────────┬────────────────┴──────────────────┬──────────────────┘
                  │                                   │ Internal Docker
                  │ http://shadow_writer:4000         │ Network
                  ▼                                   ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────┐
│     shadow-writer Microservice       │  │    redShadow Microservice    │
│            (Node.js:4000)            │  │        (FastAPI:8000)        │
├──────────────────────────────────────┤  ├──────────────────────────────┤
│ • MongoDB Database Engine            │  │ • Compendium Data Clusters   │
│ • Helix Discord / Voice Engine       │  │ • Foundry Compendium Exports │
│ • 4-Phase Editorial Pipeline         │  │ • ActiveEffects Resolution   │
│ • Gemini AI Prompt Pipeline          │  └──────────────┬───────────────┘
└──────────────────┬───────────────────┘                 │
                   ▼                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          MongoDB Database                              │
│         Collections: projects, characters, notes, chapters,            │
│                      artifacts, history, templates                     │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Invariants
1. **Never Call Port 4000 Directly**: External clients must never attempt to communicate with internal container ports. Requests route via `https://shadowplays.de/api/shadowrun/*` or `https://shadowplays.de/writer/api/*`.
2. **Context Enrichment**: When Flask verifies an API key or session, it automatically determines the owner (`User` model) and injects the following headers to the internal microservice:
   * `x-user-id`: Internal database integer ID of the resolved user.
   * `x-user-email`: Email of the resolved user.
   * `x-user-role`: User role (`creator`, `admin`, `author`, `user`).
3. **Transparent Stream Handlers**:
   * Long-lived Server-Sent Events (SSE) stream via `https://shadowplays.de/writer_backend/sse`.
   * Live audio Discord/Voice WebSockets stream via `wss://shadowplays.de/writer_backend/helix/ws`.

---

## 2. Authentication & Authorization Protocols

### 2.1 API Key & Token Authentication (Foundry VTT Gateway)
Endpoints mounted under `/api/shadowrun/*` and `/api/shadowrun/helix/*` are dedicated to external integrations and Foundry VTT modules.

* **Exempt from Cookie CSRF**: Requests to `/api/shadowrun/*` do not require CSRF tokens.
* **Accepted Credentials**:
  * **Header (Recommended)**: `X-API-Key: <license_key_or_token>`
  * **Bearer Header**: `Authorization: Bearer <license_key_or_token>`
  * **Fast-Auth Session Header**: `X-Session-ID: <session_uuid>` (cached after starting an active session)
  * **Query Parameter**: `?apiKey=<license_key_or_token>`
* **Validation Logic (`verify_helix_api_key`)**:
  1. Checks active in-memory session cache `_HELIX_SESSION_AUTH_CACHE` ($O(1)$ fast-auth).
  2. Matches against internal master keys (`MCP_API_KEY`, `REDSHADOW_INTERNAL_API_KEY`).
  3. Queries PostgreSQL database table `LicenseKey`. The key must be active (`is_valid=True`) and associated with the `shadows-creater` module.

### 2.2 Flask Session Authentication (Writer Web Application)
Endpoints mounted under `/writer/api/*` (aliased from `/author/writer/api/*`) are designed for browser sessions.

* **Cookie Required**: Requires a valid `session` cookie established via the user login flow (`/login` or development endpoint `/dev-login-admin`).
* **Role Check**: Requests require `@login_required` and caller roles of `creator` or `admin`.
* **CSRF Token**: Non-GET mutations via browser forms require the `X-CSRFToken` header fetched from `/writer/api/csrf-token`.

---

## 3. Structured Object Storage Invariants

All entities synchronized into `shadow-writer` (characters, notes, chapters, artifacts) **MUST** comply with the Structured Object Storage Invariant:

1. **No Raw Markdown Dumps**: Entities must store structured attribute maps. The top-level `content` field must always be `""` (empty string). Unstructured markdown dumps (`attributes.unstructured`) are forbidden.
2. **Attribute Values**: Every prose text field within `attributes` must be structured as an object with both plain-text and HTML formatting:
   ```json
   {
     "biography": {
       "text": "A street samurai operating out of Seattle.",
       "html": "<p>A street samurai operating out of Seattle.</p>"
     }
   }
   ```
3. **Identifier Normalization**: Entity IDs must be URL-safe slugs (e.g., `ch-k9-runner`, `note-mission-briefing`).

---

## 4. Public Gateway Endpoints Catalog

### 4.1 System & Authentication

#### `GET /api/shadowrun/helix/verify-key`
Validates an API key or license token without initiating any actions.
* **Auth**: `X-API-Key`
* **Downstream Target**: Internal Flask verification
* **Request Headers**:
  ```http
  X-API-Key: your_foundry_license_key
  ```
* **Success Response (`200 OK`)**:
  ```json
  {
    "valid": true,
    "user_id": "1",
    "email": "creator@shadowplays.de"
  }
  ```
* **Error Response (`401 Unauthorized`)**:
  ```json
  {
    "valid": false,
    "error": "Missing or invalid API key"
  }
  ```

#### `GET /api/shadowrun/helix/status`
Checks the operational health of the downstream `shadow-writer` service and Helix Discord integration.
* **Auth**: `X-API-Key`
* **Downstream Target**: `GET http://shadow_writer:4000/api/helix/status`
* **Success Response (`200 OK`)**:
  ```json
  {
    "status": "online",
    "service": "shadow-writer",
    "version": "1.9.9",
    "helix": {
      "connected": true,
      "activeSessions": 1
    }
  }
  ```

---

### 4.2 Campaign & Project Management

#### `POST /api/shadowrun/helix/projects`
Creates or updates a campaign workspace in `shadow-writer`, strictly scoped to the authenticated user.
* **Auth**: `X-API-Key`
* **Downstream Target**: `POST http://shadow_writer:4000/api/projects`
* **Request Body**:
  ```json
  {
    "id": "seattle-shadows-2077",
    "title": "Seattle Shadows 2077",
    "description": "High-tech low-life campaign set in the Redmond Barrens.",
    "genre": "shadowrun",
    "language": "de"
  }
  ```
* **Success Response (`200 OK`)**:
  ```json
  {
    "id": "seattle-shadows-2077",
    "projectId": "seattle-shadows-2077",
    "title": "Seattle Shadows 2077",
    "genre": "shadowrun",
    "language": "de",
    "createdAt": "2026-11-12T14:00:00.000Z"
  }
  ```

---

### 4.3 Entity & Lore Synchronization

#### `POST /api/shadowrun/helix/sync`
Synchronizes Foundry VTT Actors, Journal Entries, and Lore entities into `shadow-writer`'s MongoDB collections. Automatically normalizes plain strings into structured `{ text, html }` attributes.
* **Auth**: `X-API-Key`
* **Downstream Routing**:
  * Type `character` $\rightarrow$ `POST http://shadow_writer:4000/api/characters/:docId`
  * Type `artifact` / `transcript` $\rightarrow$ `POST http://shadow_writer:4000/api/artifacts/:docId`
  * Type `note` / `location` / `faction` $\rightarrow$ `POST http://shadow_writer:4000/api/notes/:docId`
* **Request Body**:
  ```json
  {
    "projectId": "seattle-shadows-2077",
    "entities": [
      {
        "externalId": "Actor.a8B9cD0eF1g2H3",
        "name": "K9 - Street Samurai",
        "type": "character",
        "attributes": {
          "archetype": "Street Samurai",
          "street_cred": 4,
          "biography": "<p>Former Ares cyber-soldier gone rogue.</p>"
        }
      },
      {
        "externalId": "JournalEntry.x7Y8Z9a1B2c3",
        "name": "The Coffin Motel Safehouse",
        "type": "note",
        "attributes": {
          "category": "Location",
          "security_rating": "C",
          "notes": "<p>Located in the heart of the Redmond Barrens.</p>"
        }
      }
    ]
  }
  ```
* **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "projectId": "seattle-shadows-2077",
    "synced": 2,
    "entities": [
      {
        "id": "actor-a8b9cd0ef1g2h3",
        "externalId": "Actor.a8B9cD0eF1g2H3",
        "name": "K9 - Street Samurai",
        "type": "character",
        "subtypeTag": "character",
        "collection": "characters",
        "status_code": 200,
        "content": "",
        "attributes": {
          "archetype": {
            "text": "Street Samurai",
            "html": "<p>Street Samurai</p>"
          },
          "street_cred": 4,
          "biography": {
            "text": "Former Ares cyber-soldier gone rogue.",
            "html": "<p>Former Ares cyber-soldier gone rogue.</p>"
          }
        }
      }
    ]
  }
  ```

---

### 4.4 Live Voice & Session Management

#### `POST /api/shadowrun/helix/session/start`
Initializes a live game session. Can connect to Discord voice channels or listen for audio markers. Automatically registers fast-auth session routing.
* **Auth**: `X-API-Key`
* **Downstream Target**: `POST http://shadow_writer:4000/api/helix/session/start`
* **Request Body**:
  ```json
  {
    "projectId": "seattle-shadows-2077",
    "sessionId": "run-session-42",
    "title": "Infiltration of the Renraku Substation",
    "guildId": "123456789012345678",
    "channelId": "987654321098765432"
  }
  ```
* **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "sessionId": "run-session-42",
    "status": "active",
    "startedAt": "2026-11-12T14:30:00.000Z"
  }
  ```

#### `POST /api/shadowrun/helix/session/end`
Gracefully finalizes an active recording session.
* **Auth**: `X-API-Key` or `X-Session-ID`
* **Downstream Target**: `POST http://shadow_writer:4000/api/helix/session/end`
* **Request Body**:
  ```json
  {
    "sessionId": "run-session-42"
  }
  ```
* **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "sessionId": "run-session-42",
    "status": "ended",
    "endedAt": "2026-11-12T17:45:00.000Z"
  }
  ```

---

### 4.5 AI Summaries & Intelligence

#### `POST /api/shadowrun/helix/summary`
Asynchronously triggers Gemini AI to analyze raw transcript entries or GM session logs, generate an episodic campaign recap with next steps, and persist it as a structured note in `shadow-writer`.
* **Auth**: `X-API-Key`
* **Downstream Target**: Internal Flask AI Orchestrator $\rightarrow$ `POST http://shadow_writer:4000/api/notes/summary-:sessionId`
* **Request Body**:
  ```json
  {
    "projectId": "seattle-shadows-2077",
    "sessionId": "run-session-42",
    "title": "Session 42 Summary: Renraku Heist",
    "language": "de",
    "transcript": [
      { "speaker": "GM", "text": "The alarms begin blaring across floor 3." },
      { "speaker": "K9", "text": "I set up suppression fire at the corridor doors." }
    ],
    "dossier": "Previous context: The team is hunting for the encrypted datapad."
  }
  ```
* **Success Response (`200 OK`)**:
  ```json
  {
    "sessionId": "run-session-42",
    "summary": "Die Runner infiltrierten erfolgreich das Renraku-Umspannwerk...",
    "next_steps": "1. Datenpad entschlüsseln lassen. 2. Beim Schieber untertauchen."
  }
  ```

#### `GET /api/shadowrun/helix/summary/<job_id>`
Polls the generation status of an episodic summary.
* **Auth**: `X-API-Key`
* **Downstream Target**: `GET http://shadow_writer:4000/api/helix/summary/:jobId` (with fallback to `/api/notes/summary-:jobId`)
* **Success Response (Completed - `200 OK`)**:
  ```json
  {
    "status": "completed",
    "jobId": "run-session-42",
    "sessionId": "run-session-42",
    "summary": {
      "text": "The team successfully retrieved the Renraku prototype...",
      "html": "<p>The team successfully retrieved the Renraku prototype...</p>"
    },
    "nextSteps": {
      "text": "1. Contact the fixer.\n2. Evade the Lone Star patrol.",
      "html": "<ul><li>Contact the fixer.</li><li>Evade the Lone Star patrol.</li></ul>"
    }
  }
  ```
* **Success Response (In Progress - `200 OK`)**:
  ```json
  {
    "status": "processing",
    "jobId": "run-session-42"
  }
  ```

---

### 4.6 Shadowrun Compendium & Rules Lookup

#### `GET /api/shadowrun/items`
Searches the official Shadowrun compendium with authorized German rule text and ActiveEffects.
* **Auth**: `X-API-Key`
* **Downstream Target**: `GET http://redshadow:8000/api/foundry/export`
* **Query Parameters**:
  * `cluster`: Filter by category (`cyberware`, `weapons`, `spells`, `gear`, `adept_powers`, `vehicles`).
  * `query`: Search string by item name or German translation.
* **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "count": 1,
    "items": [
      {
        "id": "ares-predator-v",
        "name": "Ares Predator V",
        "type": "weapon",
        "system": {
          "damage": "8P",
          "ap": -1,
          "mode": "SA",
          "rc": 0,
          "ammo": 15
        },
        "effects": []
      }
    ]
  }
  ```

#### `GET /api/shadowrun/items/<item_id>`
Fetches complete item data ready for Foundry VTT item sheet injection.
* **Auth**: `X-API-Key`
* **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "item": {
      "_id": "ares-predator-v",
      "name": "Ares Predator V",
      "type": "weapon",
      "img": "systems/shadowrun5e/dist/icons/weapons/heavy-pistols/ares-predator-v.webp",
      "system": {
        "description": {
          "value": "<p>Die Ares Predator V ist die meistverkaufte schwere Pistole der Welt.</p>"
        }
      }
    }
  }
  ```

---

### 4.7 Writer & Editorial Pipelines

> [!NOTE]
> The `/writer/api/*` pipeline endpoints are protected by Flask user session cookies (`@login_required` with `creator` / `admin` roles). For automated background execution from external modules, use the token-gated `/api/shadowrun/helix/*` gateway above.

#### `POST /writer/api/automation/start`
Starts a non-blocking background AI pipeline job (e.g. 4-phase chapter generation, beat expansion, structural polish).
* **Auth**: Session Cookie
* **Request Body**:
  ```json
  {
    "projectId": "seattle-shadows-2077",
    "pipelineType": "chapter_generation",
    "chapterId": "chapter-1",
    "options": {
      "genre": "shadowrun",
      "targetWordCount": 2500,
      "tone": "gritty"
    }
  }
  ```
* **Success Response (`200 OK`)**:
  ```json
  {
    "job_id": "job-8f7a6b5c-4d3e-2f1a",
    "status": "started",
    "message": "Pipeline worker thread dispatched"
  }
  ```

#### `GET /writer/api/automation/status/<job_id>`
Polls status and incremental log progress of an active pipeline job.
* **Auth**: Session Cookie
* **Success Response (`200 OK`)**:
  ```json
  {
    "job_id": "job-8f7a6b5c-4d3e-2f1a",
    "status": "completed",
    "progress": 100,
    "steps": [
      { "name": "Concept Expansion", "status": "completed" },
      { "name": "Beat Outlining", "status": "completed" },
      { "name": "Drafting", "status": "completed" }
    ],
    "result": {
      "chapterId": "chapter-1",
      "wordCount": 2640
    }
  }
  ```

---

### 4.8 Streaming & WebSocket Gateways

#### `GET /writer_backend/sse`
Real-time Server-Sent Events stream for live pipeline execution logs.
* **URL**: `https://shadowplays.de/writer_backend/sse`
* **Transport**: HTTP/1.1 SSE (Streaming)
* **Event Format**:
  ```
  event: job_progress
  data: {"jobId": "job-8f7a6b5c", "phase": "drafting", "progress": 65, "message": "Drafting scene 2..."}
  ```

#### `WebSocket /writer_backend/helix/ws`
Full-duplex WebSocket connection for real-time audio chunk transmission and transcript marker events.
* **URL**: `wss://shadowplays.de/writer_backend/helix/ws`
* **Client Handshake Message**:
  ```json
  {
    "action": "subscribe",
    "sessionId": "run-session-42",
    "apiKey": "your_foundry_license_key"
  }
  ```

---

## 5. Foundry VTT Module Integration Guide

Below is a complete, production-ready implementation of a Foundry VTT module integration.

### 5.1 Module Settings Configuration

Register module settings in your module entry point (`scripts/module.js`):

```javascript
/**
 * Register Shadow-Writer integration settings in Foundry VTT
 */
Hooks.once("init", () => {
  game.settings.register("shadowrun-writer-sync", "serverUrl", {
    name: "Shadowplays Server URL",
    hint: "The public URL of the Shadowplays gateway (e.g., https://shadowplays.de).",
    scope: "world",
    config: true,
    type: String,
    default: "https://shadowplays.de"
  });

  game.settings.register("shadowrun-writer-sync", "apiKey", {
    name: "License API Key",
    hint: "Your active API license key from shadowplays.de.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register("shadowrun-writer-sync", "projectId", {
    name: "Campaign Project ID",
    hint: "The target project identifier in shadow-writer.",
    scope: "world",
    config: true,
    type: String,
    default: "my-shadowrun-campaign"
  });
});
```

---

### 5.2 Robust Foundry VTT API Client

Create a clean client class to manage headers, authentication, and error reporting:

```javascript
/**
 * scripts/ShadowWriterClient.js
 * Centralized API client for communicating with shadowplays.de from Foundry VTT.
 */
export class ShadowWriterClient {
  static get baseUrl() {
    return game.settings.get("shadowrun-writer-sync", "serverUrl").replace(/\/+$/, "");
  }

  static get apiKey() {
    return game.settings.get("shadowrun-writer-sync", "apiKey").trim();
  }

  static get projectId() {
    return game.settings.get("shadowrun-writer-sync", "projectId").trim() || "global";
  }

  /**
   * Builds standardized headers for all requests
   */
  static getHeaders(extraHeaders = {}) {
    return {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-API-Key": this.apiKey,
      ...extraHeaders
    };
  }

  /**
   * Generic request wrapper with comprehensive error handling
   */
  static async request(path, options = {}) {
    if (!this.apiKey) {
      ui.notifications.error("ShadowWriter: API Key is not configured in Module Settings.");
      throw new Error("Missing API Key");
    }

    const url = `${this.baseUrl}${path.startsWith("/") ? path : "/" + path}`;
    const config = {
      ...options,
      headers: this.getHeaders(options.headers || {})
    };

    try {
      const response = await fetch(url, config);
      if (!response.ok) {
        let errorMsg = `HTTP ${response.status}: ${response.statusText}`;
        try {
          const errData = await response.json();
          if (errData.error) errorMsg = errData.error;
        } catch (_) {}
        throw new Error(errorMsg);
      }
      return await response.json();
    } catch (err) {
      console.error(`[ShadowWriter] Request failed: ${url}`, err);
      ui.notifications.error(`ShadowWriter Error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Verify API Key Validity
   */
  static async verifyKey() {
    return await this.request("/api/shadowrun/helix/verify-key", { method: "GET" });
  }
}
```

---

### 5.3 Syncing Actors (Characters)

Hook into actor updates or provide a title bar button on the Actor Sheet:

```javascript
/**
 * Synchronize a Foundry VTT Actor to shadow-writer
 * @param {Actor} actor - The Foundry VTT Actor document
 */
export async function syncActorToShadowWriter(actor) {
  const payload = {
    projectId: ShadowWriterClient.projectId,
    entities: [
      {
        externalId: actor.uuid || `Actor.${actor.id}`,
        name: actor.name,
        type: "character",
        attributes: {
          concept: actor.system.concept || "",
          metatype: actor.system.metatype || "Human",
          street_cred: actor.system.street_cred || 0,
          biography: actor.system.biography || actor.system.notes || "",
          karma_total: actor.system.karma?.total || 0
        }
      }
    ]
  };

  ui.notifications.info(`Syncing ${actor.name} to Shadow-Writer...`);
  const result = await ShadowWriterClient.request("/api/shadowrun/helix/sync", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (result.success) {
    ui.notifications.info(`Successfully synced ${actor.name}!`);
  }
  return result;
}

// Automatically sync when an actor is modified
Hooks.on("updateActor", async (actor, changes, options, userId) => {
  // Only the active GM executes synchronization to prevent duplicate calls
  if (!game.user.isGM) return;
  
  // Throttle or filter updates to character bio/concept changes
  if (changes.name || changes.system?.biography || changes.system?.concept) {
    await syncActorToShadowWriter(actor);
  }
});
```

---

### 5.4 Syncing Journals (Lore & Notes)

Synchronize campaign journal entries as structured notes:

```javascript
/**
 * Synchronize a JournalEntry to shadow-writer
 * @param {JournalEntry} journal - The Foundry VTT JournalEntry document
 */
export async function syncJournalToShadowWriter(journal) {
  // Extract text from pages
  let combinedContent = "";
  for (const page of journal.pages) {
    if (page.type === "text" && page.text?.content) {
      combinedContent += `<h2>${page.name}</h2>${page.text.content}`;
    }
  }

  const payload = {
    projectId: ShadowWriterClient.projectId,
    entities: [
      {
        externalId: journal.uuid || `JournalEntry.${journal.id}`,
        name: journal.name,
        type: "note",
        attributes: {
          category: "Lore",
          folder: journal.folder?.name || "General Lore",
          content: combinedContent
        }
      }
    ]
  };

  return await ShadowWriterClient.request("/api/shadowrun/helix/sync", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
```

---

### 5.5 Managing Live Audio Sessions

Control live session states directly from the Foundry VTT GM toolbar:

```javascript
/**
 * Start a live game session in shadow-writer
 * @param {string} sessionName - Descriptive title of the run
 */
export async function startLiveSession(sessionName) {
  const sessionId = `session-${Date.now()}`;
  const payload = {
    projectId: ShadowWriterClient.projectId,
    sessionId: sessionId,
    title: sessionName
  };

  const response = await ShadowWriterClient.request("/api/shadowrun/helix/session/start", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  // Store active session ID in client memory or world flag
  await game.settings.set("shadowrun-writer-sync", "activeSessionId", sessionId);
  ui.notifications.info(`Live session started: ${sessionName}`);
  return response;
}

/**
 * End the currently active live game session
 */
export async function endLiveSession() {
  const sessionId = game.settings.get("shadowrun-writer-sync", "activeSessionId");
  if (!sessionId) {
    ui.notifications.warn("No active session to end.");
    return;
  }

  const response = await ShadowWriterClient.request("/api/shadowrun/helix/session/end", {
    method: "POST",
    body: JSON.stringify({ sessionId })
  });

  await game.settings.set("shadowrun-writer-sync", "activeSessionId", "");
  ui.notifications.info("Live session finalized.");
  return response;
}
```

---

### 5.6 Generating & Polling Session Summaries

Trigger AI session analysis and poll the job until complete:

```javascript
/**
 * Generate episodic summary from notes and poll until completion
 * @param {string} sessionId - Identifier of the session to summarize
 * @param {Array<{speaker: string, text: string}>} sessionLog - Transcripts or notes
 */
export async function generateAndPollSessionSummary(sessionId, sessionLog) {
  ui.notifications.info("Requesting AI session summary...");

  // 1. Dispatch summary generation
  const summaryResponse = await ShadowWriterClient.request("/api/shadowrun/helix/summary", {
    method: "POST",
    body: JSON.stringify({
      projectId: ShadowWriterClient.projectId,
      sessionId: sessionId,
      title: `Summary for Session ${sessionId}`,
      language: "de",
      transcript: sessionLog
    })
  });

  // 2. Poll status until complete (timeout after 60s)
  const maxAttempts = 20;
  const pollIntervalMs = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    const statusData = await ShadowWriterClient.request(
      `/api/shadowrun/helix/summary/${sessionId}?projectId=${ShadowWriterClient.projectId}`,
      { method: "GET" }
    );

    if (statusData.status === "completed") {
      ui.notifications.info("Summary generated successfully!");

      // 3. Create a Foundry Journal Entry with the generated summary
      await JournalEntry.create({
        name: `Session Summary: ${sessionId}`,
        pages: [
          {
            name: "Overview",
            type: "text",
            text: {
              content: typeof statusData.summary === "object"
                ? statusData.summary.html
                : `<p>${statusData.summary}</p>`
            }
          },
          {
            name: "Next Steps",
            type: "text",
            text: {
              content: typeof statusData.nextSteps === "object"
                ? statusData.nextSteps.html
                : `<p>${statusData.nextSteps}</p>`
            }
          }
        ]
      });
      return statusData;
    }
  }

  throw new Error("Summary polling timed out after 60 seconds.");
}
```

---

## 6. Status Codes & Error Handling

| HTTP Status | Meaning | Typical Cause & Resolution |
|:---:|:---|:---|
| **200 OK** | Success | Request succeeded. Response body contains requested object. |
| **400 Bad Request** | Invalid Input | Malformed JSON, missing required attributes, or unstructured content violations. |
| **401 Unauthorized** | Auth Failed | Missing `X-API-Key` header, invalid license token, or inactive license record in database. |
| **403 Forbidden** | Role / Scope Violation | Token does not have permission for the requested entity or project workspace. |
| **404 Not Found** | Resource Missing | Non-existent entity ID, summary job ID, or project ID. |
| **405 Method Not Allowed** | Method Blocked | `DELETE` method called on `/api/shadowrun/*` routes (explicitly forbidden for safety). |
| **502 Bad Gateway** | Downstream Unreachable | The Flask Gateway could not reach internal microservices (`shadow_writer:4000` or `redshadow:8000`). |
| **504 Gateway Timeout** | Process Timeout | Downstream AI generation took longer than Nginx proxy timeout (60s). Use asynchronous polling. |

