FROM oven/bun:1

WORKDIR /app
COPY shared/ ./shared/
COPY ws-server/ ./ws-server/

WORKDIR /app/ws-server
RUN bun install

CMD ["bun", "run", "src/index.ts"]
