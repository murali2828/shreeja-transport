# Shreeja Backend - Node.js 20
# Runs DB migrations automatically on startup, then starts API

FROM node:20-alpine

# Install wget for healthcheck; tzdata so TZ env (Asia/Kolkata) actually applies
RUN apk add --no-cache wget tzdata

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

EXPOSE 5000

ENV NODE_ENV=production

# Runs migrations first, then starts the Express server
CMD ["sh", "-c", "node src/config/migrate.js && node src/app.js"]
