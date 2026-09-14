package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/fatih/color"

	"ollama-tiny-chat/server/internal/api"
	"ollama-tiny-chat/server/internal/config"
	"ollama-tiny-chat/server/internal/database"
	"ollama-tiny-chat/server/internal/ws"

	"github.com/gorilla/mux"
)

func main() {
	// Display welcome banner
	fmt.Println()
	fmt.Println(color.GreenString("🤖 Tiny Ollama Chat"))
	fmt.Println(color.GreenString("────────────────────"))
	fmt.Println()

	// Initialize configuration
	config.ParseFlags()

	// Validate configuration
	if err := config.Validate(); err != nil {
		log.Fatalf("Invalid configuration: %v", err)
	}

	// Initialize database
	if err := database.InitDB(); err != nil {
		log.Fatal("Failed to initialize database:", err)
	}

	// Display configuration
	log.Printf("Configuration: %s", config.String())

	workingDir, err := os.Getwd()
	if err != nil {
		log.Fatal("Failed to get working directory:", err)
	}

	staticDir := filepath.Join(workingDir, "./static")
	fmt.Println("Serving static files from:", staticDir)

	// Create router
	r := mux.NewRouter()

	// Register API routes
	apiRouter := r.PathPrefix("/api").Subrouter()
	api.RegisterRoutes(apiRouter)

	// WebSocket endpoint
	r.HandleFunc("/ws", ws.HandleWebSocket)

	// Serve static files and assets
	fs := http.FileServer(http.Dir(staticDir))

	// SPA handler that checks if file exists first
	spaHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip API and WebSocket paths
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/ws" {
			http.NotFound(w, r)
			return
		}

		// Check if requested file exists in static directory
		requestedFile := filepath.Join(staticDir, r.URL.Path)
		_, err := os.Stat(requestedFile)

		// If file exists or it's the root path, let the file server handle it
		if err == nil || r.URL.Path == "/" {
			fmt.Println("Serving static file:", r.URL.Path)
			fs.ServeHTTP(w, r)
			return
		}

		// Otherwise serve index.html for client-side routing
		fmt.Println("Serving index.html for:", r.URL.Path)
		http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
	})

	r.PathPrefix("/").Handler(spaHandler)

	// Start server with configured port
	serverAddr := config.GetServerAddress()

	// Print startup banner
	fmt.Println()
	fmt.Println(color.GreenString("🚀 Server started successfully!"))
	fmt.Println(color.GreenString("────────────────────────────────────"))
	fmt.Printf("%s %s\n", color.YellowString("🌐 Local:"), color.CyanString("http://localhost%s", serverAddr))
	fmt.Printf("%s %s\n", color.YellowString("📁 Ollama:"), color.CyanString(config.Get().OllamaURL))
	fmt.Println(color.GreenString("────────────────────────────────────"))
	fmt.Println()

	if err := http.ListenAndServe(serverAddr, r); err != nil {
		log.Fatal("Server failed to start:", err)
	}
}
