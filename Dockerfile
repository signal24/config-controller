FROM node:20-alpine

WORKDIR /app
COPY package.json yarn.lock tsconfig.json ./
COPY src ./src

RUN apk add --no-cache tini && \
    yarn && \
    yarn build && \
    yarn install --production && \
    yarn cache clean

ENTRYPOINT ["/sbin/tini"]
CMD ["node", "dist/index.js"]
