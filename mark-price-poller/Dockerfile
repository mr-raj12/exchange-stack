FROM oven/bun:1

WORKDIR /app
COPY shared/ ./shared/
COPY mark-price-poller/ ./mark-price-poller/

WORKDIR /app/mark-price-poller
RUN bun install

CMD ["bun", "run", "src/index.ts"]
