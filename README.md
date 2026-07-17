# Shadow Writer Microservice (`shadow-writer`)

**Shadow Writer** is a microservice dedicated to orchestrating automated AI writing workflows, setting up character/dossier templates, managing project contexts (notes, chapters, settings), and managing active writing sessions. It integrates with Google Vertex AI / Gemini API for generating long-form fiction, conducting research, and refining prose.

---

## 🏗 Directory Structure

```text
shadow-writer/
├── backend/            # Express.js API server & agent orchestrator
│   ├── db/            # Seeding & configuration files (projects, templates, elements)
│   ├── mongoDB.js     # MongoDB connection, schemas, and seeding scripts
│   ├── geminiClient.js# Direct Google GenAI API Client
│   ├── agentEngine.js # Parent Agent execution engine and task queue
│   ├── subagentEngine.js # Plan-Execute-Test loop subagents
│   └── server.js      # Express server routes
├── frontend/           # React + Vite admin dashboard (runs at port 4000/gui)
├── Dockerfile          # Multi-stage production container build
└── README.md           # This file
```

---

## 🛠 Features

- **Direct Vertex AI & Gemini APIs Integration**: Direct calls to Google Vertex AI using service account authentication, with automatic model-upgrading (`gemini-3.1-flash-lite` -> `gemini-3.5-flash` -> `gemini-3.1-pro-preview`) and representative endpoint routing.
- **Parent-Subagent Orchestration**: A goal-oriented Parent Agent breaks down high-level requests into specific JSON `task_list` workflows, and runs a dedicated `SubagentEngine` with Plan-Execute-Test loops.
- **MongoDB Persistence**: All templates, chapters, notes, characters, historical runs, and intermediate artifacts are stored structured in MongoDB.
- **Template Chaining & Agent Workflows**: Setup automated writing pipelines where one template chains directly into another (e.g. Brainstorming -> Outlining -> Character Dossiers).
- **API Key Authentication**: Secure route validation preventing unauthorized access outside the registry app.
- **Vulnerability-free Setup**: Native system dependencies (like `git` and `ca-certificates`) built into the production runner.

---

## ⚙️ Environment Variables

Configure the following variables in your `.env` file (copied from `.env.example` if available):

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Node server listening port | `4000` |
| `MONGODB_URI` | Connection URI to MongoDB | `mongodb://localhost:27017/shadow_writer` |
| `MCP_API_KEY` | Security authentication token | *Required* |
| `ALLOWED_CORS_ORIGINS` | List of comma-separated allowed origins | *Required* |
| `GEMINI_API_KEY` | Direct API Key for Google AI Studio (fallback) | *Optional* |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to Google Service Account JSON | *Optional* |
| `GOOGLE_CLOUD_PROJECT` | GCP Project ID | *Optional* |
| `GOOGLE_CLOUD_LOCATION` | Representative Endpoint Location | `europe-west3` |

---

## 🚀 Running the Microservice

### Development Setup

1. **Install backend dependencies**:
   ```bash
   cd backend
   npm install
   ```

2. **Start the backend in development**:
   ```bash
   npm run dev
   ```

3. **Install and run the frontend**:
   ```bash
   cd ../frontend
   npm install
   npm run dev
   ```

### Production Docker Stack

Build and run using the parent Docker Compose file in `api_module_building`:
```bash
docker compose up -d --build shadowplays_writer
```
