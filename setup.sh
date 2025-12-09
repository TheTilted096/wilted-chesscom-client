#!/bin/bash

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Wilted Chess.com Client - Setup Script"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: Please run this script from the wilted-chesscom-client directory${NC}"
    exit 1
fi

# Step 1: Install Node.js dependencies
echo -e "${GREEN}[1/5] Installing Node.js dependencies...${NC}"
npm install
echo ""

# Step 2: Clone or update Wilted-Chess-Engine
echo -e "${GREEN}[2/5] Setting up Wilted-Chess-Engine...${NC}"
if [ ! -d "Wilted-Chess-Engine" ]; then
    echo "Cloning Wilted-Chess-Engine repository..."
    git clone https://github.com/TheTilted096/Wilted-Chess-Engine.git
else
    echo "Wilted-Chess-Engine already exists, pulling latest changes..."
    cd Wilted-Chess-Engine
    git pull
    cd ..
fi
echo ""

# Step 3: Download neural network file
echo -e "${GREEN}[3/5] Downloading neural network...${NC}"
if [ ! -f "wilted-net-1-3.bin" ]; then
    echo "Downloading wilted-net-1-3.bin from test-repo..."

    # Try with curl
    if command -v curl &> /dev/null; then
        curl -L -o wilted-net-1-3.bin https://github.com/TheTilted096/test-repo/raw/main/wilted-net-1-3.bin
    # Try with wget
    elif command -v wget &> /dev/null; then
        wget -O wilted-net-1-3.bin https://github.com/TheTilted096/test-repo/raw/main/wilted-net-1-3.bin
    else
        echo -e "${YELLOW}Warning: Neither curl nor wget found. Please manually download:${NC}"
        echo "  https://github.com/TheTilted096/test-repo/raw/main/wilted-net-1-3.bin"
        echo "  Save it as: wilted-net-1-3.bin in this directory"
    fi
else
    echo "Neural network file already exists."
fi
echo ""

# Step 4: Build the engine
echo -e "${GREEN}[4/5] Building Wilted-Chess-Engine...${NC}"
cd Wilted-Chess-Engine

# Check if make is available
if ! command -v make &> /dev/null; then
    echo -e "${RED}Error: 'make' command not found. Please install build tools:${NC}"
    echo "  Ubuntu/Debian: sudo apt-get install build-essential"
    echo "  Fedora: sudo dnf install make gcc-c++"
    echo "  macOS: xcode-select --install"
    exit 1
fi

# Check if g++ is available
if ! command -v g++ &> /dev/null; then
    echo -e "${RED}Error: 'g++' compiler not found. Please install:${NC}"
    echo "  Ubuntu/Debian: sudo apt-get install g++"
    echo "  Fedora: sudo dnf install gcc-c++"
    echo "  macOS: xcode-select --install"
    exit 1
fi

# Build the engine
echo "Running make..."
make clean 2>/dev/null || true
make

# Find the binary
if [ -f "bin/wilted" ]; then
    ENGINE_PATH="$(pwd)/bin/wilted"
elif [ -f "wilted" ]; then
    ENGINE_PATH="$(pwd)/wilted"
elif [ -f "build/wilted" ]; then
    ENGINE_PATH="$(pwd)/build/wilted"
else
    echo -e "${RED}Error: Could not find compiled engine binary${NC}"
    echo "Please check the Makefile and build output"
    exit 1
fi

cd ..

echo -e "${GREEN}Engine built successfully: ${ENGINE_PATH}${NC}"
echo ""

# Step 5: Create configuration file
echo -e "${GREEN}[5/5] Creating configuration file...${NC}"

if [ -f "config.json" ]; then
    echo -e "${YELLOW}config.json already exists. Backing up to config.json.backup${NC}"
    cp config.json config.json.backup
fi

# Get absolute paths
ENGINE_ABS_PATH="$(cd "$(dirname "$ENGINE_PATH")" && pwd)/$(basename "$ENGINE_PATH")"
NET_ABS_PATH="$(pwd)/wilted-net-1-3.bin"

cat > config.json <<EOF
{
  "enginePath": "${ENGINE_ABS_PATH}",
  "networkPath": "${NET_ABS_PATH}",
  "threads": 8,
  "moveTime": 60000,
  "increment": 1000,
  "headless": false,
  "gamesCount": 1
}
EOF

echo "Configuration file created: config.json"
echo ""

# Verify engine works
echo -e "${GREEN}Testing engine...${NC}"
if "${ENGINE_ABS_PATH}" <<< "quit" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Engine is working!${NC}"
else
    echo -e "${YELLOW}Warning: Could not verify engine. It may not support UCI protocol yet.${NC}"
fi
echo ""

# Print next steps
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}Setup complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo ""
echo "1. Test manual move input:"
echo -e "   ${YELLOW}npm run test${NC}"
echo ""
echo "2. Run full automation:"
echo -e "   ${YELLOW}npm start${NC}"
echo ""
echo "Configuration can be modified in: config.json"
echo ""
echo -e "${GREEN}Happy testing!${NC}"
echo ""
