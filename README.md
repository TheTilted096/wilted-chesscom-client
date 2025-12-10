# Wilted Chess.com Client

A Windows client to connect the Wilted-Chess-Engine to chess.com for testing against bots. **This is for testing against chess.com bots only, not for cheating against human players.**

## Overview

This client uses Microsoft Edge's remote debugging protocol to control your already-logged-in browser via a REST API. Perfect for:
- Using your chess.com membership and premium bots
- Working within organization-managed browser profiles
- Keeping your existing login session

**For detailed API documentation, see [README-API.md](./README-API.md)**

## Prerequisites

- Windows 10/11
- Node.js (v16 or higher)
- Microsoft Edge browser

## Quick Start

### 1. Install Dependencies

```powershell
npm install
```

### 2. Start Edge with Remote Debugging

```powershell
.\start-edge.ps1
```

This script will:
- Close any existing Edge processes
- Launch Edge with debugging enabled on port 9223
- Use your default Edge profile

### 3. Navigate to Chess.com

1. In the Edge window that opened, go to https://www.chess.com
2. Log in (if not already logged in)
3. Navigate to https://www.chess.com/play/computer
4. Start a game against a bot

### 4. Start the API Server

In a new terminal:
```powershell
npm start
```

You should see:
```
API Server running on http://localhost:3000
Connected to chess.com tab
Ready!
```

### 5. Test the Connection

In another terminal:
```powershell
npm test
```

Or use curl:
```powershell
# Make a move
curl -X POST http://localhost:3000/move -H "Content-Type: application/json" -d '{"move":"e2e4"}'

# Get board state
curl http://localhost:3000/board

# Check status
curl http://localhost:3000/status
```

## Configuration

Edit `config-api.json` to customize settings.

**Configuration Options:**
- `apiServer.port` - API server port (default: 3000)
- `edge.debugPort` - Edge debugging port (default: 9223)
- `engine.mode` - Search mode: "nodes" or "time"
- `engine.nodes` - Number of nodes to search (when mode is "nodes")
- `engine.threads` - Number of threads for engine to use

## API Endpoints

The API server exposes several endpoints:

### Core Endpoints
- `GET /health` - Server health check
- `POST /connect` - Connect to Edge instance
- `GET /board` - Get current FEN and move history
- `POST /move` - Execute a move (UCI format)
- `POST /sync` - Detect opponent moves and sync position

### Engine Management
- `GET /engine/list` - List available engines in engines/ folder
- `POST /engine/enable` - Start a chess engine
- `POST /engine/disable` - Stop the engine
- `POST /engine/config` - Configure engine settings
- `GET /engine/suggest` - Get engine move suggestion

### Autoplay
- `POST /autoplay/enable` - Start automatic engine play
- `POST /autoplay/disable` - Stop automatic play
- `GET /autoplay/status` - Check autoplay status

See [README-API.md](./README-API.md) for detailed API documentation.

## Project Structure

```
wilted-chesscom-client/
├── src/
│   ├── api-server.js          # Main API server
│   ├── uci-engine.js          # UCI protocol handler
│   └── test-api.js            # API testing tool
├── engines/                   # Place engine executables here
├── config-api.json            # API configuration
├── start-edge.ps1             # Edge launcher script
├── package.json               # Node.js dependencies
└── README.md                  # This file
```

## Troubleshooting

### Edge Won't Start
Make sure Edge is installed in the default location. The script checks:
- `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- `C:\Program Files\Microsoft\Edge\Application\msedge.exe`

### Can't Connect to Edge
- Ensure Edge was started with the `start-edge.ps1` script
- Check that port 9223 is not blocked by firewall
- Verify Edge is running with: `netstat -an | findstr 9223`

### API Server Won't Start
- Check if port 3000 is already in use
- Try changing the port in `config-api.json`

### Moves Not Executing
- Make sure you're on the correct chess.com page
- Verify the game has started
- Check that you're using UCI format (e.g., "e2e4")

## Features

- REST API for move execution
- Full UCI protocol support
- Automatic engine integration
- Multiple engine support
- Auto-play mode
- Board state extraction
- Move history tracking

## Limitations

- Windows only
- Requires Microsoft Edge
- Board detection depends on chess.com's DOM structure
- Works best with computer opponents (bots)
