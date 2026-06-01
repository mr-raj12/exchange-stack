FROM oven/bun:1

WORKDIR /app
COPY shared/ ./shared/
COPY backend/ ./backend/

WORKDIR /app/backend
RUN bun install
RUN bunx prisma generate

CMD ["sh", "-c", "bunx prisma migrate deploy && bun run src/index.ts"]
