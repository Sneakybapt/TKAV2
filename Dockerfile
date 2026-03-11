FROM node:20-alpine AS deps
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci

FROM node:20-alpine AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
COPY --from=deps /app/server/node_modules ./node_modules
COPY server ./
RUN npx prisma generate
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node index.js"]
