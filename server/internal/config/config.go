package config

import (
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fatih/color"
)

// Config holds the application configuration
type Config struct {
	// Server configuration
	ServerPort int

	// Ollama configuration
	OllamaURL string

	// Database configuration
	DBPath string
}

// Default configuration values
const (
	DefaultServerPort = 8080
	DefaultOllamaURL  = "http://localhost:11434"
	DefaultDBPath     = "chat.db"
)

var (
	instance *Config
	once     sync.Once
)

// Get returns the singleton instance of the configuration
func Get() *Config {
	once.Do(func() {
		instance = &Config{
			ServerPort: DefaultServerPort,
			OllamaURL:  DefaultOllamaURL,
			DBPath:     DefaultDBPath,
		}
	})
	return instance
}

// ParseFlags parses command line flags and updates the config
func ParseFlags() {
	cfg := Get()

	// Add a custom usage message
	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "%s\n\n", color.GreenString("🤖 Tiny Ollama Chat - A lightweight UI for Ollama models"))
		fmt.Fprintf(flag.CommandLine.Output(), "%s\n", color.YellowString("Usage:"))
		fmt.Fprintf(flag.CommandLine.Output(), "  %s [options]\n\n", os.Args[0])
		fmt.Fprintf(flag.CommandLine.Output(), "%s\n", color.YellowString("Options:"))
		flag.PrintDefaults()
		fmt.Fprintf(flag.CommandLine.Output(), "\n%s\n", color.YellowString("Examples:"))
		fmt.Fprintf(flag.CommandLine.Output(), "  Run with default settings:\n    %s\n\n", os.Args[0])
		fmt.Fprintf(flag.CommandLine.Output(), "  Run on a different port:\n    %s -port=9000\n\n", os.Args[0])
		fmt.Fprintf(flag.CommandLine.Output(), "  Connect to Ollama on a different machine:\n    %s -ollama-url=http://192.168.1.100:11434\n\n", os.Args[0])
	}

	// Define command line flags
	serverPort := flag.Int("port", DefaultServerPort, "Port for the server to listen on")
	ollamaURL := flag.String("ollama-url", DefaultOllamaURL, "URL for the Ollama API")
	dbPath := flag.String("db-path", DefaultDBPath, "Path to the SQLite database file")

	// Parse flags
	flag.Parse()

	// Apply parsed values
	cfg.ServerPort = *serverPort
	cfg.OllamaURL = *ollamaURL
	cfg.DBPath = *dbPath

	// Validate and normalize the URL
	if !strings.HasPrefix(cfg.OllamaURL, "http://") && !strings.HasPrefix(cfg.OllamaURL, "https://") {
		cfg.OllamaURL = "http://" + cfg.OllamaURL
	}
}

// Validate checks if the configuration is valid
func Validate() error {
	cfg := Get()

	// Validate port
	if cfg.ServerPort < 1 || cfg.ServerPort > 65535 {
		return fmt.Errorf("invalid port number: %d (must be between 1 and 65535)", cfg.ServerPort)
	}

	// Validate Ollama URL format
	parsedURL, err := url.Parse(cfg.OllamaURL)
	if err != nil {
		return fmt.Errorf("invalid Ollama URL: %w", err)
	}
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return fmt.Errorf("unsupported URL scheme: %s (must be http or https)", parsedURL.Scheme)
	}

	// Check if Ollama is accessible
	fmt.Printf("Checking Ollama connection at %s... ", cfg.OllamaURL)
	client := &http.Client{
		Timeout: 5 * time.Second,
	}
	
	resp, err := client.Get(cfg.OllamaURL + "/api/tags")
	if err != nil {
		fmt.Println(color.YellowString("Not reachable yet (will retry per request once Ollama is online)"))
		return nil
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		fmt.Println(color.YellowString("Unexpected response from Ollama"))
		return nil
	}
	
	fmt.Println(color.GreenString("Connected"))
	return nil
}

// GetServerAddress returns the address for the HTTP server to listen on
func GetServerAddress() string {
	return ":" + strconv.Itoa(Get().ServerPort)
}

// String returns a string representation of the configuration
func String() string {
	cfg := Get()
	return fmt.Sprintf("Server port: %s, Ollama URL: %s, DB Path: %s", 
		color.YellowString("%d", cfg.ServerPort), 
		color.YellowString("%s", cfg.OllamaURL),
		color.YellowString("%s", cfg.DBPath))
}
