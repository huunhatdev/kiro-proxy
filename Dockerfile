# Kiro Manager — OpenAI-compatible proxy + web UI to manage Kiro tokens.
# No external npm dependencies: pure Node.js stdlib.
FROM node:20-alpine

WORKDIR /app

# Only package.json + source are needed (no deps to install).
COPY package.json ./
COPY src ./src
COPY public ./public

ENV PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

# Persist accounts here.
VOLUME ["/data"]

EXPOSE 8080

# Basic container healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8080) +'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
