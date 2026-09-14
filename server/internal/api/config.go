package api

import (
	"encoding/json"
	"net/http"
	"ollama-tiny-chat/server/internal/config"
)

// ConfigResponse represents the configuration returned to clients
type ConfigResponse struct {
	OllamaURL string `json:"ollamaUrl"`
	ServerPort int   `json:"serverPort"`
}

// GetConfig returns the current server configuration
func GetConfig(w http.ResponseWriter, r *http.Request) {
	// Create response object
	cfg := config.Get()
	configResp := ConfigResponse{
		OllamaURL: cfg.OllamaURL,
		ServerPort: cfg.ServerPort,
	}

	// Set JSON content type
	w.Header().Set("Content-Type", "application/json")

	// Encode and send the response
	if err := json.NewEncoder(w).Encode(configResp); err != nil {
		http.Error(w, "Failed to encode config", http.StatusInternalServerError)
		return
	}
}
