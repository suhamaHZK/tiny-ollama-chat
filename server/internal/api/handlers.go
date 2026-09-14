package api

import (
	"encoding/json"
	"log"
	"net/http"
	"ollama-tiny-chat/server/internal/config"
	"ollama-tiny-chat/server/internal/database"
	"ollama-tiny-chat/server/internal/ollama"

	"github.com/gorilla/mux"
)

type CreateConversationRequest struct {
	Model   string `json:"model"`
	Message string `json:"message"`
}

type CreateConversationResponse struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Model string `json:"model"`
}

type ErrorResponse struct {
	Message string `json:"message"`
}

func sendErrorResponse(w http.ResponseWriter, message string, statusCode int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(ErrorResponse{Message: message})
}

func CreateConversation(w http.ResponseWriter, r *http.Request) {
	var req CreateConversationRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendErrorResponse(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	title := req.Message
	if len(title) > 30 {
		title = title[:30] + "..."
	}

	convoID, err := database.CreateConversation(title, req.Model)

	if err != nil {

		sendErrorResponse(w, "Failed to create conversation", http.StatusInternalServerError)
		return
	}

	if err := database.AddMessage(convoID, "user", req.Message); err != nil {
		sendErrorResponse(w, "Failed to add message to conversation", http.StatusInternalServerError)
		return
	}

	response := CreateConversationResponse{
		ID:    convoID,
		Title: title,
		Model: req.Model,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)

}

func GetConversation(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	convoID := vars["id"]

	conversation, err := database.GetConversationByID(convoID)

	if err != nil {
		sendErrorResponse(w, "Failed to fetch conversation", http.StatusInternalServerError)
		return
	}

	if conversation == nil {
		sendErrorResponse(w, "Conversation not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(conversation)
}

func ListModels(w http.ResponseWriter, r *http.Request) {
	client := ollama.NewClient(config.Get().OllamaURL)

	models, err := client.ListModels()
	if err != nil {
		// Ollama may be offline — return empty list so clients can still browse history.
		log.Printf("ListModels: Ollama unavailable, returning empty list: %v", err)
		models = []ollama.ModelInfo{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(models)
}

func ListConversations(w http.ResponseWriter, r *http.Request) {
	conversations, err := database.ListConversations()
	if err != nil {
		sendErrorResponse(w, "Failed to fetch conversations", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(conversations)
}

func DeleteConversation(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	convoID := vars["id"]

	if err := database.DeleteConversation(convoID); err != nil {
		// http.Error(w, "Failed to delete conversation", http.StatusInternalServerError)
		return
	}

	// Return 204 No Content for successful deletion
	w.WriteHeader(http.StatusNoContent)
}
