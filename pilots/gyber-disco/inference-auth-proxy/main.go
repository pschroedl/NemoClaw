// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

const defaultKeyFile = "/run/secrets/inference/api-key"

func main() {
	upstream, err := url.Parse(requiredEnv("UPSTREAM_URL"))
	if err != nil || upstream.Scheme != "http" || upstream.Host == "" || upstream.User != nil {
		panic("UPSTREAM_URL must be an unauthenticated cluster-local HTTP URL")
	}
	keyFile := os.Getenv("API_KEY_FILE")
	if keyFile == "" {
		keyFile = defaultKeyFile
	}
	apiKey, err := readKey(keyFile)
	if err != nil {
		panic(err)
	}

	proxy := newProxy(upstream, apiKey)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = response.Write([]byte("ok\n"))
	})
	mux.Handle("/v1/", requestLogger(proxy))
	mux.HandleFunc("/", func(response http.ResponseWriter, _ *http.Request) {
		http.Error(response, "not found", http.StatusNotFound)
	})

	server := &http.Server{
		Addr:              ":8080",
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	slog.Info("inference authentication proxy listening", "address", server.Addr, "upstream", upstream.Redacted())
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		panic(err)
	}
}

func newProxy(upstream *url.URL, apiKey string) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	proxy.Transport = &http.Transport{
		Proxy:                 nil,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 10 * time.Minute,
	}
	baseDirector := proxy.Director
	proxy.Director = func(request *http.Request) {
		baseDirector(request)
		request.Host = upstream.Host
		request.Header.Del("Proxy-Authorization")
		request.Header.Set("Authorization", "Bearer "+apiKey)
	}
	proxy.ErrorHandler = func(response http.ResponseWriter, request *http.Request, proxyErr error) {
		slog.Error("upstream request failed", "method", request.Method, "path", request.URL.Path, "error", proxyErr)
		http.Error(response, "inference upstream unavailable", http.StatusBadGateway)
	}
	return proxy
}

func requiredEnv(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		panic(fmt.Sprintf("%s is required", name))
	}
	return value
}

func readKey(path string) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read API key file: %w", err)
	}
	key := strings.TrimSpace(string(content))
	if len(key) < 32 || strings.ContainsAny(key, "\r\n\x00") {
		return "", errors.New("API key file has an invalid value")
	}
	return key, nil
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		started := time.Now()
		next.ServeHTTP(response, request)
		slog.Info("inference request", "method", request.Method, "path", request.URL.Path, "duration_ms", time.Since(started).Milliseconds())
	})
}
