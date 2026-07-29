# node:22 (full Debian) already bundles git, curl, ca-certificates, python3,
# make and g++ — everything better-sqlite3 needs — so no apt layer.
#
# Unlike the opencode/openclaw templates there is no runtime CLI to install:
# Pi is a library, so the agent loop runs inside this Node process.
FROM node:22

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /data /tmp/pi-workspace

ENV PORT=8080 WORKDIR=/tmp/pi-workspace DB_PATH=/data/agents.db

EXPOSE 8080

CMD ["node", "src/index.mjs"]
