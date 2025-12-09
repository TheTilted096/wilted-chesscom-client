# Wilted Chess.com Client

A client to run with the Wilted-Chess-Engine on chess.com for experimenting with bots. **This is for testing against chess.com bots only, not for cheating against human players.**

## Overview

This client automates the process of relaying moves between your chess engine and chess.com using browser automation (Puppeteer). It allows you to test your engine against chess.com's computer opponents.

## Architecture

The system consists of three main components:

1. **ChessComClient** - Browser automation layer that interacts with chess.com
2. **UCIEngine** - Bridge to communicate with your chess engine via UCI protocol
3. **GameCoordinator** - Orchestrates the game flow between engine and browser

## Prerequisites

- Node.js (v16 or higher)
- C++ compiler (g++ or clang)
- Make
- Git

## Quick Setup

Run the automated setup script:

```bash
chmod +x setup.sh
./setup.sh
```

This will:
1. Install Node.js dependencies
2. Clone Wilted-Chess-Engine
3. Download the neural network file
4. Build the engine
5. Create configuration file

## Manual Installation

If you prefer manual setup:

```bash
# 1. Install dependencies
npm install

# 2. Clone and build your engine
git clone https://github.com/TheTilted096/Wilted-Chess-Engine.git
cd Wilted-Chess-Engine
make
cd ..

# 3. Download neural network
wget https://github.com/TheTilted096/test-repo/raw/main/wilted-net-1-3.bin

# 4. Create config.json (copy from config.example.json)
cp config.example.json config.json
# Edit config.json to point to your engine binary
```

## Configuration

Edit `config.json` to customize settings:

```json
{
  "enginePath": "/path/to/Wilted-Chess-Engine/bin/wilted",
  "threads": 8,
  "moveTime": 60000,
  "increment": 1000,
  "headless": false,
  "gamesCount": 1
}
```

**Configuration Options:**
- `enginePath` - Path to your compiled engine binary
- `threads` - Number of threads for engine to use
- `moveTime` - Time per move in milliseconds (60000 = 60 seconds)
- `increment` - Time increment in milliseconds (1000 = 1 second)
- `headless` - Run browser in headless mode (true/false)
- `gamesCount` - Number of games to play in sequence

## Usage

### Full Automation Mode

Start the automated game player:

```bash
npm start
```

Or play multiple games:

```bash
npm start 5  # Play 5 games
```

The system will:
1. Launch a browser and navigate to chess.com
2. Wait for you to start a game against a bot
3. Automatically play the entire game using your engine
4. Display move-by-move commentary
5. Show game summary and PGN when finished

### Manual Move Testing

Test the browser automation without the engine:

```bash
npm run test
```

This launches a browser where you manually enter moves:

1. Browser opens at https://www.chess.com/play/computer
2. Start a game against a bot
3. Enter moves in UCI format (e.g., `e2e4`, `g1f3`, `e7e8q`)
4. Type `fen` to see current position
5. Type `quit` to exit

### Automated Game Example

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     WILTED CHESS.COM CLIENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Engine: /home/user/Wilted-Chess-Engine/bin/wilted
Threads: 8
Time per move: 60s
Increment: 1s
Games to play: 1
Headless mode: No
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

=== Wilted Chess.com Client ===

Starting engine...
→ uci
← Wilted Chess Engine v1.0
← uciok
✓ UCI protocol initialized
✓ Engine is ready

Launching browser...
Navigating to chess.com...
Ready to play!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Instructions:
1. In the browser window, navigate to a bot
2. Start a game (select color and click Play)
3. The engine will take over from here!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Waiting for game to start...
♟️  Playing as: WHITE

🤔 Engine thinking...
→ position startpos
→ go movetime 60000
← info depth 1 score cp 50
← info depth 2 score cp 45
...
← bestmove e2e4

➤ Playing: e2e4
✓ Move executed (1. e2e4)

⏳ Waiting for opponent...
Opponent moved. Current position: ...

🤔 Engine thinking...
...
```

## Alternative Approaches for Move Relay

### 1. Browser Automation (Current Implementation) ✅

**How it works:**
- Uses Puppeteer to control a real browser
- Detects board state from DOM elements
- Simulates clicks to make moves
- Waits for opponent moves by polling DOM

**Pros:**
- Legitimate browser interaction
- Most maintainable and reliable
- Works with chess.com's current UI

**Cons:**
- Requires browser process (can run headless)
- Slightly slower than direct API
- Needs adjustment if chess.com changes UI

**Best for:** Production use, reliability, ethical compliance

### 2. WebSocket Protocol Reverse Engineering ⚠️

**How it would work:**
- Intercept chess.com's WebSocket messages
- Parse their protocol format
- Send moves directly via WebSocket
- No browser needed

**Pros:**
- Faster response time
- Lower resource usage
- No browser overhead

**Cons:**
- Violates chess.com Terms of Service
- Fragile - breaks when protocol changes
- Difficult to maintain
- May trigger anti-bot detection

**Best for:** Not recommended - TOS violation

### 3. Browser Extension 🔧

**How it would work:**
- Chrome/Firefox extension injected into chess.com page
- Extension communicates with local server via native messaging
- Server runs your engine and sends moves to extension

**Pros:**
- Clean integration with browser
- Can access page context directly
- Persistent across sessions

**Cons:**
- More complex setup
- Requires user to manually navigate and start games
- Extension installation needed

**Best for:** Personal use with manual game setup

## Recommendation

**For your use case (testing against bots), the current browser automation approach is ideal because:**

1. It's ethical and compliant with testing against computer opponents
2. It's maintainable and won't easily break
3. It provides visibility (you can watch the games)
4. It can run headless for automation

## Troubleshooting

### Engine Not Found
```
❌ Engine not found at: /path/to/engine
```
**Solution:** Update `enginePath` in config.json to point to your compiled engine binary.

### Engine Not Responding
```
Timeout waiting for: uciok
```
**Solution:** Your engine may not support UCI protocol yet. Ensure it responds to UCI commands:
```bash
echo "uci" | /path/to/your/engine
# Should output "uciok"
```

### Browser Issues
If the browser doesn't detect moves correctly:
- Try running in non-headless mode (`"headless": false` in config.json)
- Check if chess.com updated their UI
- Ensure you're playing on https://www.chess.com/play/computer

### Move Detection Fails
If opponent moves aren't detected:
- The board state parser may need updates
- Check console output for DOM errors
- Try different bots (some may have different timing)

### Build Errors
If `make` fails:
```bash
# Install build tools
sudo apt-get install build-essential  # Ubuntu/Debian
sudo dnf install make gcc-c++         # Fedora
xcode-select --install                # macOS
```

## Project Structure

```
wilted-chesscom-client/
├── src/
│   ├── chesscom-client.js    # Browser automation
│   ├── uci-engine.js          # UCI protocol handler
│   ├── game-coordinator.js    # Game orchestration
│   ├── index.js               # Main entry point
│   └── test-move.js           # Manual testing tool
├── config.json                # Configuration (create from example)
├── config.example.json        # Example configuration
├── setup.sh                   # Automated setup script
├── package.json               # Node.js dependencies
└── README.md                  # This file
```

## Features

- ✅ Browser automation via Puppeteer
- ✅ Full UCI protocol support
- ✅ Automatic move detection
- ✅ Time control management (60+1)
- ✅ Multi-threading support (configurable)
- ✅ PGN export
- ✅ Multiple game automation
- ✅ Headless mode support
- ✅ Move-by-move commentary

## Limitations

- Requires manual game start (click "Play" on chess.com)
- Board detection depends on chess.com's current DOM structure
- May need adjustments if chess.com updates their UI
- Works best with computer opponents (bots)

## Future Enhancements

- [ ] Automatic game starting
- [ ] Opening book support
- [ ] Endgame tablebase integration
- [ ] Game analysis and statistics
- [ ] Support for other chess platforms
- [ ] Better time management
- [ ] Resignation threshold

## Technical Details

### UCI Format
Moves are specified in UCI (Universal Chess Interface) format:
- Normal move: `e2e4` (from square to square)
- Promotion: `e7e8q` (includes promoted piece: q/r/b/n)

### Board Detection
The client reads the DOM to extract:
- Piece positions
- Current turn
- Game state (ongoing/finished)

### Move Execution
Moves are made by:
1. Finding source square element
2. Finding destination square element
3. Simulating click on source
4. Simulating click on destination
5. Handling promotion dialog if needed
