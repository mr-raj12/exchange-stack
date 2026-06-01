FROM oven/bun:1

WORKDIR /app
COPY shared/ ./shared/
COPY engine/ ./engine/

WORKDIR /app/engine
RUN bun install
RUN bunx prisma generate --schema=./prisma/schema.prisma

CMD ["bun", "run", "src/index.ts"]
