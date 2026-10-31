# Self-hosted tunnel: docker run -e PUBLIC_URL=… -e COOKIE_SECRET=… -v tunnel:/data -p 8787:8787 codeflower-tunnel

# better-sqlite3 compiles its native module here, where the build tools are.
FROM node:22-bookworm AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production TUNNEL_DB=/data/tunnel.sqlite PORT=8787
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY migrations ./migrations
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "src/node.ts"]
