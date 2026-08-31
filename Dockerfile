FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
COPY data ./data
COPY openapi.yaml ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000
USER node

CMD ["node", "src/server.ts"]
