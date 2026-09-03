FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    CLIP_DATA_DIR=/data \
    CLIP_PORT=8080

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web

RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node

VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CLIP_PORT||8080)+'/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
