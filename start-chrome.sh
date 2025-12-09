#!/bin/bash

# Helper script to start Chrome with remote debugging enabled
# This allows the API server to connect to your existing Chrome profile

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Chrome Remote Debugging Launcher"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Default port
PORT=9222

# Detect OS and set Chrome path
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    CHROME_PATHS=(
        "/usr/bin/google-chrome"
        "/usr/bin/google-chrome-stable"
        "/usr/bin/chromium-browser"
        "/usr/bin/chromium"
    )
elif [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    CHROME_PATHS=(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
    )
else
    echo "Unsupported OS: $OSTYPE"
    exit 1
fi

# Find Chrome
CHROME_PATH=""
for path in "${CHROME_PATHS[@]}"; do
    if [ -f "$path" ]; then
        CHROME_PATH="$path"
        break
    fi
done

if [ -z "$CHROME_PATH" ]; then
    echo "❌ Chrome not found. Please install Google Chrome."
    exit 1
fi

echo "✓ Found Chrome: $CHROME_PATH"
echo ""

# Get user profile directory
if [ -n "$1" ]; then
    USER_DATA_DIR="$1"
    echo "Using custom profile: $USER_DATA_DIR"
else
    # Use default profile
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        USER_DATA_DIR="$HOME/.config/google-chrome/Default"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        USER_DATA_DIR="$HOME/Library/Application Support/Google/Chrome/Default"
    fi
    echo "Using default profile: $USER_DATA_DIR"
fi

echo ""
echo "Starting Chrome with remote debugging on port $PORT..."
echo ""
echo "⚠️  IMPORTANT:"
echo "  - This will start a new Chrome window"
echo "  - Log in to chess.com if not already logged in"
echo "  - Navigate to a game"
echo "  - Then start the API server with: npm start"
echo ""

# Start Chrome
"$CHROME_PATH" \
    --remote-debugging-port=$PORT \
    --user-data-dir="$USER_DATA_DIR" \
    --no-first-run \
    --no-default-browser-check \
    "https://www.chess.com/play/computer" &

CHROME_PID=$!

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ Chrome started (PID: $CHROME_PID)"
echo "✓ Remote debugging: http://localhost:$PORT"
echo ""
echo "Next steps:"
echo "  1. Wait for Chrome to fully load"
echo "  2. Log in to chess.com (if needed)"
echo "  3. In another terminal, run: npm start"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Press Ctrl+C to stop Chrome"
echo ""

# Wait for Chrome process
wait $CHROME_PID
