# Wilted Chess.com Client - API Mode

**New Architecture:** Connect to your existing Chrome profile via API

This version uses Chrome's remote debugging protocol to connect to your already-logged-in browser, exposing a REST API that accepts UCI moves and executes them on chess.com.

## Why This Approach?

✅ **Works with your Chrome profile** - Use your existing logged-in session
✅ **Access to premium bots** - No need to log in separately
✅ **Organization-friendly** - Works within managed browser profiles
✅ **Clean API** - Simple REST endpoints for move automation
✅ **No separate browser** - Uses your existing Chrome window

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
                                  │ Chrome DevTools Protocol
                                  ▼
                         ┌──────────────────┐
                         │  Chrome Browser  │
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

```bash
npm install
```

### Step 2: Start Chrome with Remote Debugging

**Option A: Use the helper script (Recommended)**
```bash
./start-chrome.sh
```

**Option B: Manual start**

Linux:
```bash
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/google-chrome/Default"
```

macOS:
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome/Default"
```

Windows:
```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%USERPROFILE%\AppData\Local\Google\Chrome\User Data\Default"
```

**Note:** Adjust `--user-data-dir` to point to YOUR Chrome profile path.

### Step 3: Navigate to Chess.com

1. In the Chrome window that just opened, go to https://www.chess.com
2. Log in (if not already logged in)
3. Navigate to https://www.chess.com/play/computer
4. Start a game against a bot

### Step 4: Start the API Server

In a new terminal:
```bash
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
```bash
npm test
```

Or use curl:
```bash
# Make a move
curl -X POST http://localhost:3000/move \
  -H "Content-Type: application/json" \
  -d '{"move": "e2e4"}'

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

## Integrating with Your Engine

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

**Problem:** API server can't find Chrome
**Solution:**
1. Make sure Chrome is running with `--remote-debugging-port=9222`
2. Check that chrome is on port 9222: `curl http://localhost:9222/json`
3. Restart Chrome with the correct flags

### "No chess.com tab found"

**Problem:** No chess.com page is open
**Solution:**
1. Navigate to https://www.chess.com in the Chrome window
2. Restart the API server (it will re-scan for tabs)

### Moves not executing

**Problem:** Clicks not registering on the board
**Solution:**
1. Make sure the game is active (not in analysis mode)
2. Check that it's your turn
3. Verify the move is legal
4. Check console output for errors

### Chrome profile issues

**Problem:** Can't access your existing profile
**Solution:**
1. Close all Chrome windows first
2. Find your profile path:
   - Linux: `~/.config/google-chrome/Default` or `Profile 1`, `Profile 2`, etc.
   - macOS: `~/Library/Application Support/Google/Chrome/Default`
   - Windows: `%USERPROFILE%\AppData\Local\Google\Chrome\User Data\Default`
3. Use the exact path in `--user-data-dir`

### Port already in use

**Problem:** Port 9222 or 3000 already in use
**Solution:**
```bash
# Find process using port 9222
lsof -i :9222
# Kill it
kill -9 <PID>

# Or change the port in api-server.js (line 9)
```

## Finding Your Chrome Profile

### Linux
```bash
ls ~/.config/google-chrome/
# Look for: Default, Profile 1, Profile 2, etc.
```

### macOS
```bash
ls ~/Library/Application\ Support/Google/Chrome/
# Look for: Default, Profile 1, Profile 2, etc.
```

### Windows
```cmd
dir "%USERPROFILE%\AppData\Local\Google\Chrome\User Data"
REM Look for: Default, Profile 1, Profile 2, etc.
```

To identify which profile:
1. Open Chrome normally
2. Go to `chrome://version/`
3. Look at "Profile Path"

## Advanced Usage

### Using with Multiple Profiles

If you have multiple Chrome profiles:

```bash
# List profiles
ls ~/.config/google-chrome/

# Start with specific profile
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/google-chrome/Profile 2"
```

### Running Headless

You can run Chrome in headless mode (no UI):

```bash
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="/tmp/chrome-profile" \
  --headless=new
```

**Note:** You'll need to handle login differently in headless mode.

### Debugging

To see what tabs are available:
```bash
curl http://localhost:9222/json
```

To see API server logs:
```bash
npm start
# Watch the console output for errors
```

## Security Considerations

⚠️ **Important Security Notes:**

1. **Local Network Only:** The API server runs on localhost (127.0.0.1) and should NOT be exposed to the internet
2. **Chrome Debugging Port:** Port 9222 gives full control of your browser. Don't expose it publicly.
3. **Same Machine:** Both Chrome and the API server should run on the same machine
4. **Firewall:** If using a firewall, only allow localhost connections to ports 9222 and 3000

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
- Check `config.json` for customization options
- Read the main README.md for the old Puppeteer-based approach

## License

MIT - Use for testing against bots only, not for cheating!
