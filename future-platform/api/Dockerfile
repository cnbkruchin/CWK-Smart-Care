# Reference REST backend image. Build from the REPOSITORY ROOT (the API reuses src/ and serves future-platform/web):
#   docker build -f future-platform/api/Dockerfile -t cwk-api .
# Configuration comes from environment variables only (.env.example); pin the base image by digest in your registry policy.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY future-platform/api/package.json future-platform/api/package-lock.json ./future-platform/api/
RUN cd future-platform/api && npm ci --omit=dev --ignore-scripts && npm cache clean --force
# root package.json only marks src/*.js as ES modules ("type": "module"); nothing is installed from it
COPY package.json ./package.json
COPY src ./src
COPY database/postgres ./database/postgres
COPY future-platform/api/server.mjs future-platform/api/admin.mjs ./future-platform/api/
COPY future-platform/api/src ./future-platform/api/src
COPY future-platform/web ./future-platform/web
RUN mkdir -p /data/storage /data/exports && chown -R node:node /data
ENV STORAGE_DIR=/data/storage EXPORT_DIR=/data/exports
USER node
EXPOSE 8080
CMD ["node", "future-platform/api/server.mjs"]
