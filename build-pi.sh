#!/bin/bash
set -e

echo "Building Tiny Ollama Chat for Raspberry Pi 2 (linux/arm GOARM=7)..."

if [ -d "build-pi" ]; then
    echo "Clearing previous Pi build..."
    rm -rf build-pi/*
else
    echo "Creating build-pi directory..."
    mkdir -p build-pi
fi

echo "Building client..."
cd client
npm install
npm run build
cd ..

echo "Copying client build to build-pi/static..."
mkdir -p build-pi/static
cp -r client/dist/* build-pi/static/

echo "Cross-compiling server for linux/arm (ARMv7, 32-bit)..."
cd server
go mod download
CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -ldflags="-s -w" -o ../build-pi/tiny-ollama-chat ./cmd/server/main.go
cd ..

echo "Pi 2 build complete: build-pi/tiny-ollama-chat"
echo ""
echo "Copy the entire build-pi/ folder to the Raspberry Pi, then:"
echo "  cd build-pi"
echo "  chmod +x tiny-ollama-chat"
echo "  ./tiny-ollama-chat -ollama-url=http://<ollama-host>:11434"
