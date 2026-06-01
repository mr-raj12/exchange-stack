FROM oven/bun:1

WORKDIR /app
COPY shared/ ./shared/
COPY funding-timer/ ./funding-timer/

WORKDIR /app/funding-timer
RUN bun install

CMD ["bun", "run", "src/index.ts"]
