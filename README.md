every schema change follows 3 steps:
- edit the schema.prisma
- run bunx prisma migrate dev --name <init/cange_this_whatever>
- run bunx prisma generate

redis-cli -u "$REDIS_URL"