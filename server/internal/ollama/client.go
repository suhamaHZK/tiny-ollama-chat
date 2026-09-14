package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
)

const (
	defaultBaseUrl = "http://localhost:11434"
	modelListPath  = "/api/tags"
	chatPath       = "/api/chat"
	showPath       = "/api/show"
)

type thinkCacheEntry struct {
	value any
	ok    bool
}

type Client struct {
	baseURL    string
	httpClient *http.Client

	thinkMu    sync.Mutex
	thinkCache map[string]thinkCacheEntry
}

type Message struct {
	Role     string `json:"role"`
	Content  string `json:"content"`
	Thinking string `json:"thinking,omitempty"`
}

type ChatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	Stream   bool      `json:"stream"`
	Think    any       `json:"think,omitempty"`
}

type ChatMessage struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	Thinking  string `json:"thinking,omitempty"`
	Reasoning string `json:"reasoning,omitempty"`
}

func (m ChatMessage) ThinkingText() string {
	if m.Thinking != "" {
		return m.Thinking
	}
	return m.Reasoning
}

type ChatResponse struct {
	Model   string      `json:"model"`
	Message ChatMessage `json:"message"`
	Done    bool        `json:"done"`
	Error   string      `json:"error,omitempty"`
}

type ModelDetails struct {
	ParameterSize string `json:"parameter_size"`
}

type ModelInfo struct {
	Name    string       `json:"name"`
	Model   string       `json:"model"`
	Details ModelDetails `json:"details"`
}

type ListModelResponse struct {
	Models []ModelInfo `json:"models"`
}

type ShowRequest struct {
	Model string `json:"model"`
}

type ShowResponse struct {
	Capabilities []string `json:"capabilities"`
}

func NewClient(baseURL string) *Client {
	if baseURL == "" {
		baseURL = defaultBaseUrl
	}

	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{},
		thinkCache: make(map[string]thinkCacheEntry),
	}
}

func (c *Client) ListModels() ([]ModelInfo, error) {
	resp, err := c.httpClient.Get(c.baseURL + modelListPath)

	if err != nil {
		return nil, fmt.Errorf("failed to get models: %w", err)
	}

	defer resp.Body.Close()

	var response ListModelResponse

	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Models, nil
}

// ShowModel POSTs to /api/show and returns model metadata including capabilities.
func (c *Client) ShowModel(ctx context.Context, model string) (*ShowResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	jsonData, err := json.Marshal(ShowRequest{Model: model})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal show request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+showPath, bytes.NewReader(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create show request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("failed to show model: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("ollama show failed: %s: %s", resp.Status, bytes.TrimSpace(body))
	}

	var show ShowResponse
	if err := json.NewDecoder(resp.Body).Decode(&show); err != nil {
		return nil, fmt.Errorf("failed to decode show response: %w", err)
	}
	return &show, nil
}

// ResolveThink decides the Ollama `think` value from /api/show capabilities,
// with a per-client cache and name-heuristic fallback for older Ollama.
func (c *Client) ResolveThink(ctx context.Context, model string) (any, bool) {
	if strings.TrimSpace(model) == "" {
		return nil, false
	}

	c.thinkMu.Lock()
	if entry, hit := c.thinkCache[model]; hit {
		c.thinkMu.Unlock()
		return entry.value, entry.ok
	}
	c.thinkMu.Unlock()

	var value any
	var ok bool

	show, err := c.ShowModel(ctx, model)
	if err != nil {
		log.Printf("ollama show %q failed, falling back to name heuristics: %v", model, err)
		value, ok = ThinkParam(model)
	} else if hasThinkingCapability(show.Capabilities) {
		if strings.Contains(strings.ToLower(model), "gpt-oss") {
			value, ok = "medium", true
		} else {
			value, ok = true, true
		}
	} else {
		value, ok = nil, false
	}

	c.thinkMu.Lock()
	c.thinkCache[model] = thinkCacheEntry{value: value, ok: ok}
	c.thinkMu.Unlock()

	return value, ok
}

// InvalidateThinkCache clears cached think resolutions (e.g. after model pull).
func (c *Client) InvalidateThinkCache() {
	c.thinkMu.Lock()
	c.thinkCache = make(map[string]thinkCacheEntry)
	c.thinkMu.Unlock()
}

func hasThinkingCapability(caps []string) bool {
	for _, cap := range caps {
		if strings.EqualFold(strings.TrimSpace(cap), "thinking") {
			return true
		}
	}
	return false
}

func (c *Client) ChatStream(ctx context.Context, model string, messages []Message) (*http.Response, error) {
	return c.chatStream(ctx, model, messages, false)
}

// ChatStreamNoThink retries a chat without sending the think field.
func (c *Client) ChatStreamNoThink(ctx context.Context, model string, messages []Message) (*http.Response, error) {
	return c.chatStream(ctx, model, messages, true)
}

func (c *Client) chatStream(ctx context.Context, model string, messages []Message, omitThink bool) (*http.Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	reqBody := ChatRequest{
		Model:    model,
		Messages: messages,
		Stream:   true,
	}
	if !omitThink {
		if think, ok := c.ResolveThink(ctx, model); ok {
			reqBody.Think = think
		}
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+chatPath, bytes.NewReader(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, fmt.Errorf("ollama chat failed: %s: %s", resp.Status, bytes.TrimSpace(body))
	}

	return resp, nil
}
