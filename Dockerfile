FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app/backend
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Install ca-certificates so Go binaries can verify TLS certificates
RUN apt-get update && apt-get install -y ca-certificates git && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
# Copy built frontend assets to backend public directory
COPY --from=frontend-build /app/frontend/dist ./public

EXPOSE 4000
CMD ["node", "server.js"]
