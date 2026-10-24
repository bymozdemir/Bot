FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY package-lock.json* ./
# Reproducible install only. Missing lockfiles must fail with an actionable message.
RUN test -f package-lock.json || (echo "ERROR: package-lock.json is required; generate and review it in a network-enabled trusted environment." >&2; exit 1) \
 && npm ci --omit=dev \
 && npm cache clean --force
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
