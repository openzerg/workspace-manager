FROM oven/bun:alpine AS builder
RUN apk add --no-cache git
WORKDIR /app
COPY workspace-manager/package.json workspace-manager/bun.lock* ./
RUN bun install
COPY workspace-manager/src/ src/
COPY workspace-manager/tsconfig.json ./
RUN bun build --compile src/main.ts --outfile workspace-manager
FROM alpine:latest
RUN apk add --no-cache ca-certificates libstdc++
WORKDIR /app
COPY --from=builder /app/workspace-manager /app/workspace-manager
RUN chmod +x /app/workspace-manager
EXPOSE 25020
ENTRYPOINT ["/app/workspace-manager"]
