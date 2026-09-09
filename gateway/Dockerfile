FROM golang:1.27.1-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /clip-p2p .
RUN mkdir -p /licenses && go list -m -f '{{if not .Main}}{{.Path}} {{.Dir}}{{end}}' all | \
    while read -r module directory; do \
      [ -n "$directory" ] || continue; \
      name=$(printf '%s' "$module" | tr '/' '_'); \
      mkdir -p "/licenses/$name"; \
      find "$directory" -maxdepth 1 -type f \( -iname 'license*' -o -iname 'copying*' -o -iname 'notice*' \) -exec cp '{}' "/licenses/$name/" \;; \
    done

FROM alpine:3.23
RUN addgroup -S clip && adduser -S -G clip clip && apk add --no-cache ca-certificates
COPY --from=build /clip-p2p /usr/local/bin/clip-p2p
COPY --from=build /licenses /usr/share/licenses/clip-p2p
USER clip
EXPOSE 50000/udp
ENTRYPOINT ["/usr/local/bin/clip-p2p"]
