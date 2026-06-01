FROM oven/bun:1

WORKDIR /app
COPY shared/ ./shared/
COPY poller/ ./poller/

WORKDIR /app/poller
RUN bun install

CMD ["bun", "run", "src/index.ts"]
