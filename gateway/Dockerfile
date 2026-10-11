# Build from the REPOSITORY ROOT so the shared protocol module is included:
#   docker build -f gateway/Dockerfile -t cwk-gateway .
# Pin the base image by digest in your registry policy if required.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY gateway/package.json gateway/package-lock.json ./gateway/
RUN cd gateway && npm ci --omit=dev && npm cache clean --force
COPY src/shared/gateway-protocol.js ./src/shared/gateway-protocol.js
COPY gateway/src ./gateway/src
USER node
WORKDIR /app/gateway
EXPOSE 8080
CMD ["node", "src/server.mjs"]
