# Wilted Chess.com Client - API Mode

**New Architecture:** Connect to your existing Edge profile via API

This version uses Edge's remote debugging protocol to connect to your already-logged-in browser, exposing a REST API that accepts UCI moves and executes them on chess.com.

## Why This Approach?

✅ **Works with your Edge profile** - Use your existing logged-in session
✅ **Access to premium bots** - No need to log in separately
✅ **Organization-friendly** - Works within managed browser profiles
✅ **Clean API** - Simple REST endpoints for move automation
✅ **No separate browser** - Uses your existing Edge window

## Architecture

```
┌─────────────────┐
│  Your Engine    │
│  (UCI)          │
└────────┬────────┘
         │ UCI moves
         ▼
┌─────────────────┐      ┌──────────────────┐
│  Engine Bridge  │─────▶│   API Server     │
│  (optional)     │ HTTP │  (localhost:3000)│
└─────────────────┘      └────────┬─────────┘
                                  │ Edge DevTools Protocol
                                  ▼
                         ┌──────────────────┐
                         │  Edge Browser    │
                         │  (your profile)  │
                         │                  │
                         │  ┌─────────────┐ │
                         │  │ chess.com   │ │
                         │  │   (game)    │ │
                         │  └─────────────┘ │
                         └──────────────────┘
```

## Quick Start

### Step 1: Install Dependencies

```powershell
npm install
```

### Step 2: Start Edge with Remote Debugging

**Option A: Use the helper script (Recommended)**
```powershell
.\start-edge.ps1
```

**Option B: Manual start**
```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9223 `
  --user-data-dir="$env:LOCALAPPDATA\Microsoft\Edge\User Data"
```

**Note:** Adjust `--user-data-dir` to point to YOUR Edge profile path if needed.

### Step 3: Navigate to Chess.com

1. In the Edge window that just opened, go to https://www.chess.com
2. Log in (if not already logged in)
3. Navigate to https://www.chess.com/play/computer
4. Start a game against a bot

### Step 4: Start the API Server

In a new terminal:
```powershell
npm start
```

You should see:
```
✓ API Server running on http://localhost:3000
✓ Connected to chess.com tab
✓ Ready!
```

### Step 5: Test the API

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

## API Reference

### POST /move
Execute a move on the board.

**Request:**
```json
{
  "move": "e2e4"
}
```

**Response:**
```json
{
  "success": true,
  "move": "e2e4",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

**Move Format:** UCI notation
- Normal move: `e2e4`, `g1f3`
- Castling: `e1g1` (kingside), `e1c1` (queenside)
- Promotion: `e7e8q` (queen), `e7e8r` (rook), `e7e8b` (bishop), `e7e8n` (knight)

### GET /board
Get current board state as FEN.

**Response:**
```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  "gameActive": true,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### GET /status
Check connection and game status.

**Response:**
```json
{
  "connected": true,
  "gameActive": true,
  "pageUrl": "https://www.chess.com/play/computer",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### GET /health
Simple health check.

**Response:**
```json
{
  "status": "ok",
  "connected": true,
  "gameActive": true,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Built-in Chess Engine Integration

The API server now includes built-in support for UCI chess engines! You can drop multiple engine executables into the `engines/` folder and select/switch between them at runtime.

### Quick Setup

1. **Create engines directory** (if not exists):
   ```powershell
   mkdir engines
   ```

2. **Add your chess engines**:
   ```powershell
   # Example: Copy Stockfish
   copy C:\path\to\stockfish.exe engines\stockfish.exe

   # Example: Copy your custom engine
   copy C:\path\to\wilted.exe engines\wilted.exe
   ```

3. **Start the server** and the API will auto-discover all engines!

### Configuration

Edit `config-api.json` to set default engine settings:

```json
{
  "engine": {
    "threads": 1,
    "nodes": 1000000
  }
}
```

- `threads`: Number of CPU threads for the engine to use
- `nodes`: Default node limit for engine searches (higher = stronger but slower)

**Note:** Engine path is no longer needed! Just drop executables in `engines/` folder.

### GET /engine/list
List all available engines discovered in the `engines/` folder.

**Response:**
```json
{
  "success": true,
  "engines": [
    {
      "name": "stockfish",
      "path": "./engines/stockfish",
      "size": 15728640,
      "executable": true,
      "modified": "2024-01-15T10:00:00.000Z"
    },
    {
      "name": "wilted",
      "path": "./engines/wilted",
      "size": 8388608,
      "executable": true,
      "modified": "2024-01-15T09:30:00.000Z"
    }
  ],
  "count": 2,
  "enginesDir": "./engines"
}
```

### POST /engine/enable
Start a chess engine. If no engine is specified, automatically selects the first available engine.

**Request (optional):**
```json
{
  "engine": "stockfish"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Engine enabled",
  "engineEnabled": true,
  "selectedEngine": "stockfish",
  "config": {
    "threads": 1,
    "nodes": 1000000
  }
}
```

### POST /engine/disable
Stop the chess engine.

**Response:**
```json
{
  "success": true,
  "message": "Engine disabled",
  "engineEnabled": false,
  "stoppedEngine": "stockfish"
}
```

### POST /engine/switch
Switch to a different engine at runtime (stops current engine and starts new one).

**Request:**
```json
{
  "engine": "wilted"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Engine switched successfully",
  "previousEngine": "stockfish",
  "currentEngine": "wilted",
  "engineEnabled": true,
  "config": {
    "nodes": 1000000,
    "threads": 1,
    "selectedEngine": "wilted"
  }
}
```

### POST /engine/config
Update engine configuration (nodes, threads). The engine will be restarted with new settings if it's currently running.

**Request:**
```json
{
  "nodes": 2000000,
  "threads": 4
}
```

**Response:**
```json
{
  "success": true,
  "message": "Engine configuration updated",
  "config": {
    "threads": 4,
    "nodes": 2000000,
    "selectedEngine": "stockfish"
  },
  "engineEnabled": true
}
```

### GET /engine/status
Get current engine status, configuration, and list of available engines.

**Response:**
```json
{
  "engineEnabled": true,
  "engineReady": true,
  "thinking": false,
  "selectedEngine": "stockfish",
  "config": {
    "threads": 1,
    "nodes": 1000000
  },
  "availableEngines": [
    {
      "name": "stockfish",
      "executable": true,
      "size": 15728640
    },
    {
      "name": "wilted",
      "executable": true,
      "size": 8388608
    }
  ]
}
```

### GET /engine/suggest
Get the engine's suggested move for the current board position.

**Response:**
```json
{
  "success": true,
  "move": "e2e4",
  "ponder": "e7e5",
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "nodes": 1000000,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

- `move`: Best move in UCI format
- `ponder`: Suggested move to ponder on (opponent's expected response)
- `fen`: Current board position
- `nodes`: Number of nodes searched

### Example: Engine-Assisted Play

```powershell
# 1. List available engines
curl http://localhost:3000/engine/list
# Returns: {"engines": [{"name": "stockfish", ...}, {"name": "wilted", ...}]}

# 2. Start an engine (auto-selects first available)
curl -X POST http://localhost:3000/engine/enable

# Or select a specific engine
curl -X POST http://localhost:3000/engine/enable -H "Content-Type: application/json" -d '{"engine":"stockfish"}'

# 3. Get engine's suggested move
curl http://localhost:3000/engine/suggest
# Returns: {"move": "e2e4", ...}

# 4. Execute the move
curl -X POST http://localhost:3000/move -H "Content-Type: application/json" -d '{"move":"e2e4"}'

# 5. Switch to a different engine
curl -X POST http://localhost:3000/engine/switch -H "Content-Type: application/json" -d '{"engine":"wilted"}'

# 6. Configure engine for deeper search
curl -X POST http://localhost:3000/engine/config -H "Content-Type: application/json" -d '{"nodes":5000000,"threads":8}'

# 7. Get next suggestion with new settings
curl http://localhost:3000/engine/suggest
```

### UCI Engine Requirements

Your chess engine must support the Universal Chess Interface (UCI) protocol. Popular UCI engines include:

- **Stockfish** - World's strongest open-source engine
- **Komodo** - Strong commercial engine
- **Leela Chess Zero** - Neural network-based engine
- **Custom engines** - Any engine following UCI protocol

The engine executable should respond to standard UCI commands:
- `uci` - Initialize UCI mode
- `isready` - Check if ready
- `position` - Set board position
- `go nodes X` - Search with node limit
- `quit` - Shut down

For reference on UCI protocol, see: https://gist.github.com/DOBRO/2592c6dad754ba67e6dcaec8c90165bf

## Integrating with Your Engine (Advanced)

Create a simple bridge script that:
1. Starts your UCI engine
2. Reads the board state from the API
3. Sends position to engine
4. Gets engine's best move
5. Sends move to API

Example (see `src/engine-bridge.js` for full implementation):

```javascript
// Get current board
const board = await fetch('http://localhost:3000/board').then(r => r.json());

// Send to engine (pseudocode)
engine.position(board.fen);
const bestMove = await engine.go();

// Execute move
await fetch('http://localhost:3000/move', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ move: bestMove })
});
```

## Troubleshooting

### "Not connected to browser"

**Problem:** API server can't find Edge
**Solution:**
1. Make sure Edge is running with `--remote-debugging-port=9223`
2. Check that Edge is on port 9223: `curl http://localhost:9223/json`
3. Restart Edge with the correct flags or use the start-edge.ps1 script

### "No chess.com tab found"

**Problem:** No chess.com page is open
**Solution:**
1. Navigate to https://www.chess.com in the Edge window
2. Restart the API server (it will re-scan for tabs)

### Moves not executing

**Problem:** Clicks not registering on the board
**Solution:**
1. Make sure the game is active (not in analysis mode)
2. Check that it's your turn
3. Verify the move is legal
4. Check console output for errors

### Edge profile issues

**Problem:** Can't access your existing profile
**Solution:**
1. Close all Edge windows first
2. Find your profile path: `%LOCALAPPDATA%\Microsoft\Edge\User Data\Default`
   - Or check for `Profile 1`, `Profile 2`, etc.
3. Use the exact path in `--user-data-dir`

### Port already in use

**Problem:** Port 9223 or 3000 already in use
**Solution:**
```powershell
# Find process using port 9223
netstat -ano | findstr :9223

# Kill it (replace PID with actual process ID)
taskkill /PID <PID> /F

# Or change the port in config-api.json
```

## Finding Your Edge Profile

List available profiles:
```cmd
dir "%LOCALAPPDATA%\Microsoft\Edge\User Data"
REM Look for: Default, Profile 1, Profile 2, etc.
```

To identify which profile you're currently using:
1. Open Edge normally
2. Go to `edge://version/`
3. Look at "Profile Path"

## Advanced Usage

### Using with Multiple Profiles

If you have multiple Edge profiles:

```powershell
# List profiles
dir "$env:LOCALAPPDATA\Microsoft\Edge\User Data"

# Start with specific profile
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9223 `
  --user-data-dir="$env:LOCALAPPDATA\Microsoft\Edge\User Data\Profile 2"
```

### Running Headless

You can run Edge in headless mode (no UI):

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9223 `
  --user-data-dir="$env:TEMP\edge-profile" `
  --headless=new
```

**Note:** You'll need to handle login differently in headless mode.

### Debugging

To see what tabs are available:
```powershell
curl http://localhost:9223/json
```

To see API server logs:
```powershell
npm start
# Watch the console output for errors
```

## Security Considerations

⚠️ **Important Security Notes:**

1. **Local Network Only:** The API server runs on localhost (127.0.0.1) and should NOT be exposed to the internet
2. **Edge Debugging Port:** Port 9223 gives full control of your browser. Don't expose it publicly.
3. **Same Machine:** Both Edge and the API server should run on the same machine
4. **Firewall:** If using a firewall, only allow localhost connections to ports 9223 and 3000

## Comparison with Old Approach

| Feature | New (API Mode) | Old (Puppeteer) |
|---------|----------------|-----------------|
| Uses existing profile | ✅ Yes | ❌ No |
| Works with premium accounts | ✅ Yes | ❌ No |
| Organization-friendly | ✅ Yes | ⚠️ Maybe |
| Setup complexity | ⭐⭐ Medium | ⭐ Easy |
| Resource usage | ⭐⭐⭐ Low | ⭐⭐ Medium |
| Flexibility | ⭐⭐⭐ High | ⭐⭐ Medium |

## What's Next?

- See `src/engine-bridge.js` for full UCI engine integration
- Check `config-api.json` for customization options

## License

MIT - Use for testing against bots only, not for cheating!
