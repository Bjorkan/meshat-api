FROM oven/bun:1.4.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
COPY src ./src
COPY tsconfig.json ./
RUN bun install --frozen-lockfile --production
USER bun
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD bun -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/main.ts"]
