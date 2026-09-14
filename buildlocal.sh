#!/bin/bash
set -e

echo "🚀 Building Tiny Ollama Chat..."

# Create or clear build directory
if [ -d "build" ]; then
    echo "🧹 Clearing previous build..."
    rm -rf build/*
else
    echo "📁 Creating build directory..."
    mkdir -p build
fi

# Build client
echo "📦 Building client..."
cd client
npm install
npm run build
cd ..

# Copy client build to build/static
echo "📂 Copying client build to build/static..."
mkdir -p build/static
cp -r client/dist/* build/static/

# Build server
echo "📦 Building server..."
cd server
go mod download
go build -o ../build/tiny-ollama-chat ./cmd/server/main.go
cd ..

echo "✅ Build complete!"
echo ""

# Function to print a highlighted box
print_highlighted_box() {
    local text="$1"
    local width=80
    local line="━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    echo -e "\033[1;33m┏${line:0:$width}┓\033[0m"
    
    echo "$text" | while IFS= read -r line_text; do
        printf "\033[1;33m┃ \033[1;37m%-$(($width-1))s\033[1;33m┃\033[0m\n" "$line_text"
    done
    
    echo -e "\033[1;33m┗${line:0:$width}┛\033[0m"
}

# Print highlighted usage instructions
print_highlighted_box "HOW TO USE TINY OLLAMA CHAT
----------------------------

1. Change to the build directory:
   cd build

2. Run the application:
   ./tiny-ollama-chat

OPTIONAL FLAGS:
   -port=8080              Set server port (default: 8080)
   -ollama-url=URL         Set Ollama API URL (default: http://localhost:11434)
   -db-path=PATH           Set database path (default: chat.db)

EXAMPLE:
   ./tiny-ollama-chat -port=9000 -ollama-url=http://192.168.1.100:11434"