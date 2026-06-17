FROM node:24-alpine AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY demo/package.json ./demo/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY demo ./demo
RUN pnpm --filter webernetes build
RUN pnpm --filter webernetes-demo build

FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY --from=build /app/demo/dist /usr/share/nginx/html

EXPOSE 8080
