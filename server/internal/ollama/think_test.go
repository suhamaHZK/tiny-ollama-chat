package ollama

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestThinkParam(t *testing.T) {
	cases := []struct {
		model string
		want  any
		ok    bool
	}{
		{"", nil, false},
		{"llama3.2:latest", nil, false},
		{"gemma2:2b", nil, false},
		{"gemma-4-e4b", nil, false},
		{"gemma4:e4b", nil, false},
		{"Gemma-4-E4B", nil, false},
		{"gemma-4-e4b-thinking", nil, false},
		{"qwen3:latest", true, true},
		{"qwen3.8", true, true},
		{"hf.co/foo/qwen3.8:latest", true, true},
		{"deepseek-r1:7b", true, true},
		{"r1:latest", true, true},
		{"my-r1-distill", true, true},
		{"gpt-oss:20b", "medium", true},
		{"gpt-oss-120b", "medium", true},
		{"gemma4:e2b", true, true},
		{"gemma-4-e2b", true, true},
		{"gemma-4-26b", true, true},
		{"gemma4:26b", true, true},
		{"some-thinking-model", true, true},
	}

	for _, tc := range cases {
		got, ok := ThinkParam(tc.model)
		if ok != tc.ok {
			t.Errorf("ThinkParam(%q) ok=%v, want %v", tc.model, ok, tc.ok)
		}
		if got != tc.want {
			t.Errorf("ThinkParam(%q) = %#v, want %#v", tc.model, got, tc.want)
		}
	}
}

func TestIsThinkUnsupported(t *testing.T) {
	if IsThinkUnsupported(nil) {
		t.Fatal("nil should not be think-unsupported")
	}
	if !IsThinkUnsupported(errors.New(`ollama chat failed: 400 Bad Request: {"error":"gemma4 does not support thinking"}`)) {
		t.Fatal("expected think-unsupported match")
	}
	if IsThinkUnsupported(errors.New("connection refused")) {
		t.Fatal("generic error should not match")
	}
}

func TestHasThinkingCapability(t *testing.T) {
	cases := []struct {
		caps []string
		want bool
	}{
		{nil, false},
		{[]string{}, false},
		{[]string{"completion"}, false},
		{[]string{"completion", "thinking"}, true},
		{[]string{"Thinking"}, true},
		{[]string{" THINKING "}, true},
		{[]string{"tools", "completion"}, false},
	}
	for _, tc := range cases {
		if got := hasThinkingCapability(tc.caps); got != tc.want {
			t.Errorf("hasThinkingCapability(%v)=%v, want %v", tc.caps, got, tc.want)
		}
	}
}

func TestResolveThinkFromCapabilities(t *testing.T) {
	cases := []struct {
		name     string
		model    string
		caps     []string
		want     any
		ok       bool
		showHits int64
	}{
		{"empty model", "", nil, nil, false, 0},
		{"completion only", "custom-gemma-e4b", []string{"completion"}, nil, false, 1},
		{"thinking bool", "qwen3", []string{"completion", "thinking"}, true, true, 1},
		{"thinking case", "DeepSeek-R1", []string{"Thinking"}, true, true, 1},
		{"gpt-oss medium", "gpt-oss:20b", []string{"completion", "thinking"}, "medium", true, 1},
		{"gpt-oss case", "GPT-OSS-120b", []string{"thinking"}, "medium", true, 1},
		{"no thinking cap", "llama3.2", []string{"completion"}, nil, false, 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var hits atomic.Int64
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != showPath || r.Method != http.MethodPost {
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
					return
				}
				hits.Add(1)
				var req ShowRequest
				body, _ := io.ReadAll(r.Body)
				_ = json.Unmarshal(body, &req)
				if req.Model != tc.model && tc.model != "" {
					t.Errorf("show model=%q, want %q", req.Model, tc.model)
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(ShowResponse{Capabilities: tc.caps})
			}))
			defer ts.Close()

			client := NewClient(ts.URL)
			got, ok := client.ResolveThink(context.Background(), tc.model)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("ResolveThink(%q)=(%#v,%v), want (%#v,%v)", tc.model, got, ok, tc.want, tc.ok)
			}
			if hits.Load() != tc.showHits {
				t.Fatalf("show hits=%d, want %d", hits.Load(), tc.showHits)
			}

			// Second call should hit cache (no extra show).
			got2, ok2 := client.ResolveThink(context.Background(), tc.model)
			if ok2 != tc.ok || got2 != tc.want {
				t.Fatalf("cached ResolveThink(%q)=(%#v,%v), want (%#v,%v)", tc.model, got2, ok2, tc.want, tc.ok)
			}
			if hits.Load() != tc.showHits {
				t.Fatalf("after cache show hits=%d, want %d", hits.Load(), tc.showHits)
			}
		})
	}
}

func TestResolveThinkFallbackOnShowError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer ts.Close()

	client := NewClient(ts.URL)

	got, ok := client.ResolveThink(context.Background(), "qwen3:latest")
	if !ok || got != true {
		t.Fatalf("fallback ResolveThink(qwen3)=(%#v,%v), want (true,true)", got, ok)
	}

	got, ok = client.ResolveThink(context.Background(), "gemma-4-e4b")
	if ok || got != nil {
		t.Fatalf("fallback ResolveThink(e4b)=(%#v,%v), want (nil,false)", got, ok)
	}

	got, ok = client.ResolveThink(context.Background(), "gpt-oss:20b")
	if !ok || got != "medium" {
		t.Fatalf("fallback ResolveThink(gpt-oss)=(%#v,%v), want (medium,true)", got, ok)
	}

	// Cached after fallback — closing server must not change result.
	ts.Close()
	got, ok = client.ResolveThink(context.Background(), "qwen3:latest")
	if !ok || got != true {
		t.Fatalf("cached fallback ResolveThink(qwen3)=(%#v,%v)", got, ok)
	}
}

func TestShowModel(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != showPath {
			t.Fatalf("path=%q", r.URL.Path)
		}
		var req ShowRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Model != "qwen3" {
			t.Fatalf("model=%q", req.Model)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"capabilities":["completion","thinking"],"modelfile":"..."}`))
	}))
	defer ts.Close()

	client := NewClient(ts.URL)
	show, err := client.ShowModel(context.Background(), "qwen3")
	if err != nil {
		t.Fatalf("ShowModel: %v", err)
	}
	if !hasThinkingCapability(show.Capabilities) {
		t.Fatalf("capabilities=%v", show.Capabilities)
	}
}
