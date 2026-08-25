FROM oven/bun:1.4.0-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ca-certificates git openssh-client \
  && mkdir -p /var/lib/meshat-docs \
  && chown bun:bun /var/lib/meshat-docs
COPY package.json bun.lock ./
COPY src ./src
COPY tsconfig.json ./
RUN bun install --frozen-lockfile --production
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD bun -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/server.ts"]
