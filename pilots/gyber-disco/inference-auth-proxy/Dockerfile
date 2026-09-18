# SPDX-License-Identifier: Apache-2.0

FROM docker.io/library/golang:1.25.1-alpine3.22@sha256:b6ed3fd0452c0e9bcdef5597f29cc1418f61672e9d3a2f55bf02e7222c014abd AS build
WORKDIR /src
COPY go.mod main.go main_test.go ./
RUN go test ./... \
  && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w -buildid=' -o /out/inference-auth-proxy ./main.go

FROM scratch
COPY --from=build /out/inference-auth-proxy /inference-auth-proxy
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/inference-auth-proxy"]
