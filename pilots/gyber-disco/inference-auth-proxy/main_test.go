// SPDX-License-Identifier: Apache-2.0

package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestProxyReplacesCallerAuthorization(t *testing.T) {
	t.Parallel()
	const key = "replacement-key-that-is-long-enough"
	upstreamURL, err := url.Parse("http://llama.internal/base")
	if err != nil {
		t.Fatal(err)
	}
	proxy := newProxy(upstreamURL, key)
	proxy.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if got := request.Header.Get("Authorization"); got != "Bearer "+key {
			t.Errorf("Authorization = %q", got)
		}
		if got := request.Header.Get("Proxy-Authorization"); got != "" {
			t.Errorf("Proxy-Authorization = %q", got)
		}
		if request.URL.Path != "/base/v1/models" {
			t.Errorf("path = %q", request.URL.Path)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("ok")),
		}, nil
	})

	request := httptest.NewRequest(http.MethodGet, "http://proxy.internal/v1/models", nil)
	request.Header.Set("Authorization", "Bearer caller-controlled")
	request.Header.Set("Proxy-Authorization", "Basic caller-controlled")
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}
