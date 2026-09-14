package database

import (
	"fmt"
	"os"
	"path/filepath"

	"ollama-tiny-chat/server/internal/config"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

var db *gorm.DB

func InitDB() error {
	var err error

	// Get database path from config
	dbPath := config.Get().DBPath

	// Ensure database directory exists
	dbDir := filepath.Dir(dbPath)
	if dbDir != "." {
		if err := os.MkdirAll(dbDir, 0755); err != nil {
			return fmt.Errorf("failed to create database directory: %w", err)
		}
	}

	db, err = gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}

	if err := db.AutoMigrate(&Conversation{}, &Message{}); err != nil {
		return fmt.Errorf("failed to migrate database: %w", err)
	}

	return nil
}

func CreateConversation(title, model string) (string, error) {
	convoID := uuid.New().String()
	convo := Conversation{
		ID:    convoID,
		Title: title,
		Model: model,
	}

	if err := db.Create(&convo).Error; err != nil {
		return "", fmt.Errorf("failed to create conversation: %w", err)
	}

	return convoID, nil
}

func AddMessage(convoID, role, content string) error {
	message := Message{
		ID:             uuid.New().String(),
		ConversationID: convoID,
		Role:           role,
		Content:        content,
		RawContent:     content,
	}

	if err := db.Create(&message).Error; err != nil {
		return fmt.Errorf("failed to add message: %w", err)
	}

	return nil
}

func GetMessagesByConversationID(convoID string) ([]Message, error) {
	var messages []Message
	if err := db.Where("conversation_id = ?", convoID).Order("created_at asc").Find(&messages).Error; err != nil {
		return nil, fmt.Errorf("failed to get messages: %w", err)
	}
	return messages, nil
}

func GetConversationByID(convoID string) (*Conversation, error) {
	var convo Conversation
	if err := db.Preload("Messages").First(&convo, "id = ?", convoID).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get conversation: %w", err)
	}
	return &convo, nil
}

func ListConversations() ([]Conversation, error) {
	var convos []Conversation
	if err := db.Order("updated_at desc").Find(&convos).Error; err != nil {
		return nil, fmt.Errorf("failed to list conversations: %w", err)
	}
	return convos, nil
}

func UpdateConversation(convoID string) error {
	if err := db.Model(&Conversation{}).Where("id = ?", convoID).Update("updated_at", gorm.Expr("CURRENT_TIMESTAMP")).Error; err != nil {
		return fmt.Errorf("failed to update conversation: %w", err)
	}
	return nil
}

func DeleteConversation(convoID string) error {
	tx := db.Begin()
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	if err := tx.Where("conversation_id = ?", convoID).Delete(&Message{}).Error; err != nil {
		tx.Rollback()
		return fmt.Errorf("failed to delete messages: %w", err)
	}

	if err := tx.Delete(&Conversation{}, "id = ?", convoID).Error; err != nil {
		tx.Rollback()
		return fmt.Errorf("failed to delete conversation: %w", err)
	}

	return tx.Commit().Error
}

func AddMessageWithThinking(convoID, role, content, rawContent string, thinking *string, thinkingTime *float64) error {
	message := Message{
		ID:             uuid.New().String(),
		ConversationID: convoID,
		Role:           role,
		Content:        content,
		RawContent:     rawContent,
		Thinking:       thinking,
		ThinkingTime:   thinkingTime,
	}

	if err := db.Create(&message).Error; err != nil {
		return fmt.Errorf("failed to add message with thinking: %w", err)
	}

	return nil
}
