FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
# Copy built frontend assets to backend public directory
COPY --from=frontend-build /app/frontend/dist ./public

EXPOSE 4000
CMD ["node", "server.js"]
