package ws

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"ollama-tiny-chat/server/internal/config"
	"ollama-tiny-chat/server/internal/database"
	"ollama-tiny-chat/server/internal/ollama"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Client struct {
	conn           *websocket.Conn
	currentConvoID string
	writeMu        sync.Mutex
	genMu          sync.Mutex
	generating     bool
	genCancel      context.CancelFunc
	connCtx        context.Context
}

type WSRequest struct {
	Type    string `json:"type"` // "message", "start_conversation", "resume_conversation"
	Message string `json:"message"`
	Model   string `json:"model"`
	ConvoID string `json:"convo_id,omitempty"`
}

type WSResponse struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	log.Printf("New WebSocket connection request from: %s", r.RemoteAddr)

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		http.Error(w, "Could not upgrade connection", http.StatusInternalServerError)
		return
	}
	defer conn.Close()

	connCtx, connCancel := context.WithCancel(r.Context())
	defer connCancel()

	client := &Client{
		conn:           conn,
		currentConvoID: "",
		connCtx:        connCtx,
	}
	log.Printf("WebSocket client connected from: %s", r.RemoteAddr)

	for {
		var req WSRequest
		if err := conn.ReadJSON(&req); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}
		log.Printf("Received message type: %s", req.Type)

		switch req.Type {
		case "start_conversation":
			log.Printf("Starting new conversation with model: %s", req.Model)
			handleNewConversation(client, req)
		case "resume_conversation":
			log.Printf("Resuming conversation: %s", req.ConvoID)
			handleResumeConversation(client, req)
		case "message":
			log.Printf("Handling message for conversation: %s", client.currentConvoID)
			handleMessage(client, req)
		}
	}
}

func (c *Client) writeJSON(v interface{}) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	err := c.conn.WriteJSON(v)
	_ = c.conn.SetWriteDeadline(time.Time{})
	return err
}

func handleNewConversation(client *Client, req WSRequest) {
	ctx, ok := client.beginGeneration()
	if !ok {
		sendError(client, "Please wait for the current reply to finish")
		return
	}

	log.Printf("Creating new conversation with first message: %s", req.Message)
	title := req.Message
	if len(title) > 30 {
		title = title[:30] + "..."
	}
	convoID, err := database.CreateConversation(title, req.Model)
	if err != nil {
		client.endGeneration()
		log.Printf("Failed to create conversation: %v", err)
		sendError(client, "Failed to create conversation")
		return
	}
	client.currentConvoID = convoID
	log.Printf("Created conversation with ID: %s", convoID)

	log.Printf("Saving initial user message")
	if err := database.AddMessage(convoID, "user", req.Message); err != nil {
		client.endGeneration()
		log.Printf("Failed to save initial message: %v", err)
		sendError(client, "Failed to save message")
		return
	}

	_ = client.writeJSON(WSResponse{
		Type:    "conversation_started",
		Content: convoID,
	})

	// Non-blocking: keep the read loop free for follow-ups / resume
	go generateResponse(client, req, ctx)
}

func handleResumeConversation(client *Client, req WSRequest) {
	// Verify conversation exists
	convo, err := database.GetConversationByID(req.ConvoID)
	if err != nil {
		log.Printf("Error fetching conversation: %v", err)
		sendError(client, "Failed to resume conversation")
		return
	}
	if convo == nil {
		log.Printf("Conversation not found: %s", req.ConvoID)
		sendError(client, "Conversation not found")
		return
	}

	// Set the conversation ID
	client.currentConvoID = req.ConvoID
	log.Printf("Resumed conversation: %s", req.ConvoID)

	// Send success response
	_ = client.writeJSON(WSResponse{
		Type:    "conversation_resumed",
		Content: req.ConvoID,
	})
}

func handleMessage(client *Client, req WSRequest) {
	// Prefer convo_id from the client payload so follow-ups survive WS reconnects
	// where Client.currentConvoID would otherwise be empty.
	if req.ConvoID != "" {
		convo, err := database.GetConversationByID(req.ConvoID)
		if err != nil {
			log.Printf("Error fetching conversation %s: %v", req.ConvoID, err)
			sendError(client, "Failed to load conversation")
			return
		}
		if convo == nil {
			log.Printf("Conversation not found: %s", req.ConvoID)
			sendError(client, "Conversation not found")
			return
		}
		client.currentConvoID = req.ConvoID
	}

	if client.currentConvoID == "" {
		log.Printf("Received message without active conversation")
		sendError(client, "No active conversation")
		return
	}
	ctx, ok := client.beginGeneration()
	if !ok {
		sendError(client, "Please wait for the current reply to finish")
		return
	}

	log.Printf("User sent Message: %s, For model: %s", req.Message, req.Model)
	log.Printf("Saving user message to conversation: %s", client.currentConvoID)
	if err := database.AddMessage(client.currentConvoID, "user", req.Message); err != nil {
		client.endGeneration()
		log.Printf("Failed to save user message: %v", err)
		sendError(client, "Failed to save message")
		return
	}

	// Non-blocking: keep the read loop free for follow-ups / resume
	go generateResponse(client, req, ctx)
}

func generateResponse(client *Client, req WSRequest, ctx context.Context) {
	log.Printf("Starting response generation - ConvoID: %s", client.currentConvoID)
	if ctx == nil {
		ctx = context.Background()
	}

	// Always emit done so the client can clear isGenerating
	doneSent := false
	sendDone := func() {
		if doneSent {
			return
		}
		doneSent = true
		if err := client.writeJSON(WSResponse{Type: "done", Content: ""}); err != nil {
			log.Printf("Failed to send done: %v", err)
		}
	}
	defer func() {
		client.endGeneration()
		sendDone()
	}()

	messages, err := database.GetMessagesByConversationID(client.currentConvoID)
	if err != nil {
		log.Printf("Error fetching history: %v", err)
		sendError(client, "Failed to get conversation history")
		return
	}
	log.Printf("Found %d previous messages", len(messages))

	ollamaMessages := make([]ollama.Message, 0, len(messages))
	for _, msg := range messages {
		m := ollama.Message{
			Role:    msg.Role,
			Content: msg.Content,
		}
		if msg.Thinking != nil && strings.TrimSpace(*msg.Thinking) != "" {
			m.Thinking = *msg.Thinking
		}
		ollamaMessages = append(ollamaMessages, m)
	}

	log.Printf("Sending request to Ollama with %d messages", len(ollamaMessages))

	ollamaClient := ollama.NewClient(config.Get().OllamaURL)
	resp, err := ollamaClient.ChatStream(ctx, req.Model, ollamaMessages)
	if err != nil && ollama.IsThinkUnsupported(err) {
		log.Printf("Model rejected think; retrying without think: %v", err)
		resp, err = ollamaClient.ChatStreamNoThink(ctx, req.Model, ollamaMessages)
	}
	if err != nil {
		if ctx.Err() != nil {
			log.Printf("Generation cancelled: %v", ctx.Err())
			return
		}
		log.Printf("Ollama request failed: %v", err)
		sendError(client, "Failed to generate response")
		return
	}
	defer resp.Body.Close()

	var fullResponse strings.Builder
	var thinking strings.Builder
	var tagParser ollama.TagParser
	isThinking := false
	var thinkStartTime time.Time
	var thinkingDuration float64

	sendStart := func() {
		if isThinking {
			return
		}
		log.Println("Entering thinking mode")
		isThinking = true
		thinkStartTime = time.Now()
		_ = client.writeJSON(WSResponse{
			Type:    "thinking_start",
			Content: "",
		})
	}

	sendEnd := func() {
		if !isThinking {
			return
		}
		log.Println("Exiting thinking mode")
		isThinking = false
		if !thinkStartTime.IsZero() {
			thinkingDuration = time.Since(thinkStartTime).Seconds()
		}
		_ = client.writeJSON(WSResponse{
			Type:    "thinking_end",
			Content: thinking.String(),
		})
	}

	appendThinking := func(piece string) {
		if piece == "" {
			return
		}
		sendStart()
		thinking.WriteString(piece)
		_ = client.writeJSON(WSResponse{
			Type:    "thinking_chunk",
			Content: piece,
		})
	}

	appendContent := func(piece string) {
		if piece == "" {
			return
		}
		sendEnd()
		fullResponse.WriteString(piece)
		_ = client.writeJSON(WSResponse{
			Type:    "response_chunk",
			Content: piece,
		})
	}

	applyParsed := func(parsed ollama.ParseResult) {
		if parsed.EnterThink {
			sendStart()
		}
		appendThinking(parsed.Thinking)
		if parsed.ExitThink {
			sendEnd()
		}
		appendContent(parsed.Content)
	}

	log.Println("Starting to process Ollama stream")
	decoder := json.NewDecoder(resp.Body)
	for {
		var chatResp ollama.ChatResponse
		if err := decoder.Decode(&chatResp); err != nil {
			if err == io.EOF {
				break
			}
			if ctx.Err() != nil {
				log.Printf("Generation cancelled during stream: %v", ctx.Err())
				sendEnd()
				return
			}
			log.Printf("Error decoding response chunk: %v", err)
			break
		}

		if chatResp.Error != "" {
			log.Printf("Ollama stream error: %s", chatResp.Error)
			sendEnd()
			sendError(client, chatResp.Error)
			return // defer still sends done
		}

		if thinkPiece := chatResp.Message.ThinkingText(); thinkPiece != "" {
			appendThinking(thinkPiece)
		}

		if contentPiece := chatResp.Message.Content; contentPiece != "" {
			applyParsed(tagParser.Feed(contentPiece))
		}

		if chatResp.Done {
			log.Printf("Full response so far: %s", fullResponse.String())
			log.Println("Received done signal from Ollama")
			break
		}
	}

	applyParsed(tagParser.Flush())
	sendEnd()

	finalResponse := fullResponse.String()
	thinkingText := thinking.String()
	log.Println("Stream complete, saving response")
	if strings.TrimSpace(finalResponse) != "" || strings.TrimSpace(thinkingText) != "" {
		err := database.AddMessageWithThinking(
			client.currentConvoID,
			"assistant",
			finalResponse,
			finalResponse,
			pointerString(thinkingText),
			&thinkingDuration,
		)
		if err != nil {
			log.Printf("Error saving response: %v", err)
			sendError(client, "Failed to save response")
			// still fall through so defer sendDone runs
			return
		}
		if err := database.UpdateConversation(client.currentConvoID); err != nil {
			log.Printf("Error updating conversation timestamp: %v", err)
		}
		log.Printf("Response saved successfully for conversation: %s", client.currentConvoID)
	} else {
		log.Printf("Warning: Empty response received for conversation: %s", client.currentConvoID)
	}

	log.Printf("Response generation complete for conversation: %s", client.currentConvoID)
}

func pointerString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (c *Client) beginGeneration() (context.Context, bool) {
	c.genMu.Lock()
	defer c.genMu.Unlock()
	if c.generating {
		return nil, false
	}
	parent := c.connCtx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	c.genCancel = cancel
	c.generating = true
	return ctx, true
}

func (c *Client) endGeneration() {
	c.genMu.Lock()
	defer c.genMu.Unlock()
	if c.genCancel != nil {
		c.genCancel()
		c.genCancel = nil
	}
	c.generating = false
}

func sendError(client *Client, message string) {
	log.Printf("Sending error to client: %s", message)
	_ = client.writeJSON(WSResponse{
		Type:    "error",
		Content: message,
	})
}
