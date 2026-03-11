FROM node:20-alpine AS frontend-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM frontend-deps AS frontend-build
WORKDIR /app
COPY tsconfig*.json ./
COPY vite.config.ts ./
COPY index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:20-alpine AS backend-deps
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci

FROM node:20-alpine AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
COPY --from=backend-deps /app/server/node_modules ./node_modules
COPY server ./
COPY --from=frontend-build /app/dist ../dist
RUN npx prisma generate
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node index.js"]
