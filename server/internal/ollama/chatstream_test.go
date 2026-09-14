package ollama

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// showAndChatServer handles /api/show with the given capabilities and records chat bodies.
func showAndChatServer(t *testing.T, caps map[string][]string, got *ChatRequest) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case showPath:
			var req ShowRequest
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &req)
			w.Header().Set("Content-Type", "application/json")
			c := caps[req.Model]
			if c == nil {
				c = []string{"completion"}
			}
			_ = json.NewEncoder(w).Encode(ShowResponse{Capabilities: c})
		case chatPath:
			body, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(body, got); err != nil {
				t.Errorf("decode request: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"done":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestChatStreamOmitsThinkForUnknown(t *testing.T) {
	var got ChatRequest
	ts := showAndChatServer(t, map[string][]string{
		"gemma-4-e4b": {"completion"},
	}, &got)
	defer ts.Close()

	client := NewClient(ts.URL)
	resp, err := client.ChatStream(context.Background(), "gemma-4-e4b", []Message{{Role: "user", Content: "hi"}})
	if err != nil {
		t.Fatalf("ChatStream: %v", err)
	}
	resp.Body.Close()

	if got.Think != nil {
		t.Fatalf("expected think omitted for gemma-4-e4b, got %#v", got.Think)
	}
}

func TestChatStreamSendsThinkForQwen(t *testing.T) {
	var got ChatRequest
	ts := showAndChatServer(t, map[string][]string{
		"qwen3:latest": {"completion", "thinking"},
	}, &got)
	defer ts.Close()

	client := NewClient(ts.URL)
	resp, err := client.ChatStream(context.Background(), "qwen3:latest", []Message{{Role: "user", Content: "hi"}})
	if err != nil {
		t.Fatalf("ChatStream: %v", err)
	}
	resp.Body.Close()

	if got.Think != true {
		t.Fatalf("expected think=true for qwen3, got %#v", got.Think)
	}
}

func TestChatStreamSendsMediumForGptOss(t *testing.T) {
	var got ChatRequest
	ts := showAndChatServer(t, map[string][]string{
		"gpt-oss:20b": {"completion", "thinking"},
	}, &got)
	defer ts.Close()

	client := NewClient(ts.URL)
	resp, err := client.ChatStream(context.Background(), "gpt-oss:20b", []Message{{Role: "user", Content: "hi"}})
	if err != nil {
		t.Fatalf("ChatStream: %v", err)
	}
	resp.Body.Close()

	if got.Think != "medium" {
		t.Fatalf("expected think=medium for gpt-oss, got %#v", got.Think)
	}
}

func TestChatStreamNoThinkOmitsField(t *testing.T) {
	var raw map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == showPath {
			t.Fatal("ChatStreamNoThink should not call /api/show")
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &raw)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"done":true}`))
	}))
	defer ts.Close()

	client := NewClient(ts.URL)
	resp, err := client.ChatStreamNoThink(context.Background(), "qwen3:latest", []Message{{Role: "user", Content: "hi"}})
	if err != nil {
		t.Fatalf("ChatStreamNoThink: %v", err)
	}
	resp.Body.Close()

	if _, exists := raw["think"]; exists {
		t.Fatalf("expected think field omitted on retry, got %#v", raw["think"])
	}
}

func TestChatStreamUsesCapabilitiesNotName(t *testing.T) {
	// Custom model without heuristic keywords: capabilities alone drive think.
	var got ChatRequest
	ts := showAndChatServer(t, map[string][]string{
		"my-custom-reasoner": {"completion", "thinking"},
	}, &got)
	defer ts.Close()

	client := NewClient(ts.URL)
	resp, err := client.ChatStream(context.Background(), "my-custom-reasoner", []Message{{Role: "user", Content: "hi"}})
	if err != nil {
		t.Fatalf("ChatStream: %v", err)
	}
	resp.Body.Close()

	if got.Think != true {
		t.Fatalf("expected think=true from capabilities, got %#v", got.Think)
	}
}
