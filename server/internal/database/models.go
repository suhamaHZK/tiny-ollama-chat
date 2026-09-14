package database

import (
	"time"
)

type Conversation struct {
    ID        string    `gorm:"primaryKey"`
    Title     string    `gorm:"not null"`
    Model     string    `gorm:"not null"`
    CreatedAt time.Time `gorm:"default:CURRENT_TIMESTAMP"`
    UpdatedAt time.Time `gorm:"default:CURRENT_TIMESTAMP"`
    Messages  []Message `gorm:"foreignKey:ConversationID"`
}

type Message struct {
    ID             string    `gorm:"primaryKey"`
    ConversationID string    `gorm:"not null;index"`
    Role           string    `gorm:"not null"` // "user" or "assistant"
    Content        string    `gorm:"not null"` // full message text
    RawContent     string    `gorm:"not null"` // message without extra formatting
    Thinking       *string   // optional for Ollama thinking tags
    ThinkingTime   *float64  // optional, time spent in thinking (seconds)
    CreatedAt      time.Time `gorm:"default:CURRENT_TIMESTAMP"`
}

// Constants for role types
const (
    RoleUser      = "user"
    RoleAssistant = "assistant"
)
