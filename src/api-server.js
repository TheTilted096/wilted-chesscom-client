#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-core';
import { Chess } from 'chess.js';

/**
 * API Server for chess.com move automation
 * Connects to existing Chrome instance and provides REST API for move execution
 */

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// State
let browser = null;
let page = null;
let connected = false;
let gameActive = false;
let chess = new Chess();

/**
 * Connect to existing Edge instance
 */
async function connectToEdge(debuggerUrl = 'http://localhost:9223') {
  try {
    console.log(`Connecting to Edge at ${debuggerUrl}...`);

    browser = await puppeteer.connect({
      browserURL: debuggerUrl,
      defaultViewport: null
    });

    const pages = await browser.pages();

    // Find chess.com tab
    page = pages.find(p => p.url().includes('chess.com'));

    if (!page) {
      console.log('No chess.com tab found. Please open chess.com in your browser.');
      console.log('Available pages:');
      pages.forEach((p, i) => console.log(`  ${i}: ${p.url()}`));
      return false;
    }

    console.log(`✓ Connected to chess.com tab: ${page.url()}`);
    connected = true;

    // Check if game is active
    await checkGameStatus();

    return true;
  } catch (error) {
    console.error('Failed to connect to Edge:', error.message);
    console.error('\nMake sure Edge is running with remote debugging enabled:');
    console.error('  msedge.exe --remote-debugging-port=9223');
    return false;
  }
}

/**
 * Check if a game is currently active
 */
async function checkGameStatus() {
  if (!page) return false;

  try {
    gameActive = await page.evaluate(() => {
      const board = document.querySelector('.board');
      const gameOver = document.querySelector('.game-over-modal, .game-over-text');
      return board && !gameOver;
    });

    return gameActive;
  } catch (error) {
    console.error('Error checking game status:', error.message);
    return false;
  }
}

/**
 * Get current board state as FEN
 */
async function getBoardState() {
  if (!page) throw new Error('Not connected to browser');

  try {
    const fen = await page.evaluate(() => {
      // Try to get FEN from chess.com's internal state
      try {
        // Chess.com stores game data in various places
        console.log('Checking window.gameSetup:', window.gameSetup);
        console.log('Checking window.chessGame:', window.chessGame);

        if (window.gameSetup?.fen) return window.gameSetup.fen;
        if (window.chessGame?.getFEN) return window.chessGame.getFEN();

        // Fallback: parse from DOM
        const pieces = document.querySelectorAll('.piece');
        console.log('Found pieces:', pieces.length);
        if (pieces.length === 0) return null;

        const board = Array(8).fill(null).map(() => Array(8).fill(null));

        pieces.forEach(piece => {
          // The square class is on the piece element itself, not the parent
          const classList = Array.from(piece.classList);

          // Find square class (e.g., square-11, square-88)
          const squareClass = classList.find(c => c.match(/square-\d\d/));
          if (!squareClass) return;

          const match = squareClass.match(/square-(\d)(\d)/);
          if (!match) return;

          const file = parseInt(match[1]) - 1; // 1-8 -> 0-7
          const rank = 8 - parseInt(match[2]); // 1-8 -> 7-0

          // Parse piece type and color from the 2-character piece code
          let pieceChar = '';

          // White pieces
          if (classList.includes('wp')) pieceChar = 'P';
          else if (classList.includes('wn')) pieceChar = 'N';
          else if (classList.includes('wb')) pieceChar = 'B';
          else if (classList.includes('wr')) pieceChar = 'R';
          else if (classList.includes('wq')) pieceChar = 'Q';
          else if (classList.includes('wk')) pieceChar = 'K';
          // Black pieces
          else if (classList.includes('bp')) pieceChar = 'p';
          else if (classList.includes('bn')) pieceChar = 'n';
          else if (classList.includes('bb')) pieceChar = 'b';
          else if (classList.includes('br')) pieceChar = 'r';
          else if (classList.includes('bq')) pieceChar = 'q';
          else if (classList.includes('bk')) pieceChar = 'k';

          if (pieceChar && rank >= 0 && rank < 8 && file >= 0 && file < 8) {
            board[rank][file] = pieceChar;
          }
        });

        // Convert to FEN
        let fen = '';
        for (let rank = 0; rank < 8; rank++) {
          let empty = 0;
          for (let file = 0; file < 8; file++) {
            if (board[rank][file] === null) {
              empty++;
            } else {
              if (empty > 0) {
                fen += empty;
                empty = 0;
              }
              fen += board[rank][file];
            }
          }
          if (empty > 0) fen += empty;
          if (rank < 7) fen += '/';
        }

        // Detect turn by checking which side can move
        const isFlipped = document.querySelector('.board')?.classList.contains('flipped');
        const turn = 'w'; // Simplified - would need more logic to detect actual turn

        return `${fen} ${turn} KQkq - 0 1`;
      } catch (err) {
        console.error('Error parsing board:', err);
        return null;
      }
    });

    return fen;
  } catch (error) {
    console.error('Error getting board state:', error.message);
    throw error;
  }
}

/**
 * Execute a move on the board
 */
async function executeMove(uciMove) {
  if (!page) throw new Error('Not connected to browser');

  const from = uciMove.substring(0, 2);
  const to = uciMove.substring(2, 4);
  const promotion = uciMove.length > 4 ? uciMove[4] : null;

  console.log(`Executing move: ${uciMove} (${from} -> ${to}${promotion ? ' =' + promotion : ''})`);

  try {
    console.log('  → Getting board coordinates...');

    // Get the coordinates in browser context
    const coords = await page.evaluate(({ from, to }) => {
      // Convert algebraic to coordinates
      const fromFile = from.charCodeAt(0) - 96; // a=1, b=2, etc.
      const fromRank = parseInt(from[1]);
      const toFile = to.charCodeAt(0) - 96;
      const toRank = parseInt(to[1]);

      console.log(`  → Converting ${from} to coordinates:`, { fromFile, fromRank });
      console.log(`  → Converting ${to} to coordinates:`, { toFile, toRank });

      // Check if board is flipped
      const board = document.querySelector('.board');
      const isFlipped = board?.classList.contains('flipped') || false;
      console.log('  → Board flipped:', isFlipped);

      // Calculate square classes
      const fromSquareClass = isFlipped
        ? `square-${9 - fromFile}${9 - fromRank}`
        : `square-${fromFile}${fromRank}`;

      console.log('  → Looking for piece with class:', fromSquareClass);

      // Find the piece with the from square class
      const fromPiece = document.querySelector(`.piece.${fromSquareClass}`);

      if (!fromPiece) {
        console.error('  ✗ No piece found!');
        console.log('  → Available pieces:', Array.from(document.querySelectorAll('.piece')).map(p => p.className));
        return {
          success: false,
          error: `No piece found on ${from} (looking for class: ${fromSquareClass})`
        };
      }

      console.log('  ✓ Found piece:', fromPiece.className);

      // Calculate pixel coordinates for the destination
      const boardRect = board.getBoundingClientRect();
      const squareSize = boardRect.width / 8;

      // Calculate which square to click (accounting for board flip)
      const toFileIdx = isFlipped ? (8 - toFile) : (toFile - 1);
      const toRankIdx = isFlipped ? (toRank - 1) : (8 - toRank);

      const toX = boardRect.left + (toFileIdx * squareSize) + (squareSize / 2);
      const toY = boardRect.top + (toRankIdx * squareSize) + (squareSize / 2);

      // Get the piece's position
      const pieceRect = fromPiece.getBoundingClientRect();
      const fromX = pieceRect.left + pieceRect.width / 2;
      const fromY = pieceRect.top + pieceRect.height / 2;

      return {
        success: true,
        fromX,
        fromY,
        toX,
        toY
      };
    }, { from, to });

    if (!coords.success) {
      console.error('  ✗ Failed to get coordinates:', coords.error);
      throw new Error(coords.error || 'Failed to find piece');
    }

    console.log('  ✓ Coordinates calculated:', coords);
    console.log('  → Performing drag-and-drop...');

    // Use Puppeteer's mouse API to perform drag-and-drop
    console.log(`  → Moving to piece at (${coords.fromX}, ${coords.fromY})`);
    await page.mouse.move(coords.fromX, coords.fromY);
    console.log('  → Mouse down');
    await page.mouse.down();
    await page.waitForTimeout(100);
    console.log(`  → Dragging to (${coords.toX}, ${coords.toY})`);
    await page.mouse.move(coords.toX, coords.toY, { steps: 10 });
    await page.waitForTimeout(100);
    console.log('  → Mouse up');
    await page.mouse.up();

    // Handle promotion if needed
    if (promotion) {
      await page.waitForTimeout(200);
      await page.evaluate((promo) => {
        const pieceMap = {
          'q': 'queen',
          'r': 'rook',
          'b': 'bishop',
          'n': 'knight'
        };
        const pieceName = pieceMap[promo.toLowerCase()];
        if (pieceName) {
          const promotionPiece = document.querySelector(
            `.promotion-piece.${pieceName}, .promotion-${pieceName}`
          );
          if (promotionPiece) promotionPiece.click();
        }
      }, promotion);
    }

    // Wait for move to be processed
    await page.waitForTimeout(300);

    console.log('✓ Move executed successfully');
    return { success: true, move: uciMove };

  } catch (error) {
    console.error('Error executing move:', error.message);
    throw error;
  }
}

/**
 * API Routes
 */

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected,
    gameActive,
    timestamp: new Date().toISOString()
  });
});

// Connect to browser
app.post('/connect', async (req, res) => {
  const { debuggerUrl } = req.body;
  const success = await connectToEdge(debuggerUrl || 'http://localhost:9223');

  res.json({
    success,
    connected,
    message: success ? 'Connected to Edge' : 'Failed to connect'
  });
});

// Get board state
app.get('/board', async (req, res) => {
  try {
    if (!connected) {
      return res.status(400).json({ error: 'Not connected to browser' });
    }

    const fen = await getBoardState();
    const active = await checkGameStatus();

    res.json({
      fen,
      gameActive: active,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Make a move
app.post('/move', async (req, res) => {
  try {
    const { move } = req.body;

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📨 Received move request:', move);

    if (!move) {
      console.log('❌ No move provided in request body');
      return res.status(400).json({ error: 'Move required (UCI format, e.g., e2e4)' });
    }

    if (!connected) {
      console.log('❌ Not connected to browser');
      return res.status(400).json({ error: 'Not connected to browser' });
    }

    if (!page) {
      console.log('❌ No page object available');
      return res.status(400).json({ error: 'No page object available' });
    }

    // Validate UCI format
    const uciPattern = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
    if (!uciPattern.test(move)) {
      console.log('❌ Invalid UCI move format:', move);
      return res.status(400).json({ error: 'Invalid UCI move format' });
    }

    console.log('✓ Starting move execution...');
    const result = await executeMove(move);
    console.log('✓ Move execution completed:', result);

    res.json({
      success: true,
      move,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error in /move endpoint:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Get game status
app.get('/status', async (req, res) => {
  try {
    if (!connected) {
      return res.status(400).json({ error: 'Not connected to browser' });
    }

    const active = await checkGameStatus();

    res.json({
      connected,
      gameActive: active,
      pageUrl: page ? page.url() : null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to inspect page structure
app.get('/debug', async (req, res) => {
  try {
    if (!connected) {
      return res.status(400).json({ error: 'Not connected to browser' });
    }

    const debugInfo = await page.evaluate(() => {
      return {
        hasGameSetup: !!window.gameSetup,
        hasChessGame: !!window.chessGame,
        gameSetupKeys: window.gameSetup ? Object.keys(window.gameSetup) : [],
        chessGameKeys: window.chessGame ? Object.keys(window.chessGame) : [],
        pieceCount: document.querySelectorAll('.piece').length,
        altPieceCount: document.querySelectorAll('[class*="piece"]').length,
        boardExists: !!document.querySelector('.board'),
        boardClasses: document.querySelector('.board')?.className || 'no board found',
        sampleSquareClasses: Array.from(document.querySelectorAll('[class*="square"]')).slice(0, 10).map(el => el.className),
        allClassesWithPiece: Array.from(new Set(
          Array.from(document.querySelectorAll('[class*="piece"]'))
            .map(el => Array.from(el.classList).join(' '))
        )).slice(0, 10),
        // Check for e4 square specifically
        e4Exists: !!document.querySelector('.square-54'),
        e4Classes: document.querySelector('.square-54')?.className || 'not found',
        // Check all square-54 elements
        allSquare54: Array.from(document.querySelectorAll('[class*="square-54"]')).map(el => ({
          tag: el.tagName,
          classes: el.className,
          parent: el.parentElement?.className
        })),
        // Check board structure
        boardChildren: Array.from(document.querySelector('.board')?.children || []).map(el => ({
          tag: el.tagName,
          classes: String(el.className).substring(0, 50)
        }))
      };
    });

    res.json(debugInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disconnect
app.post('/disconnect', async (req, res) => {
  if (browser) {
    await browser.disconnect();
    browser = null;
    page = null;
    connected = false;
    gameActive = false;
  }

  res.json({ success: true, message: 'Disconnected' });
});

/**
 * Start server
 */
async function start() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Wilted Chess.com API Server');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // Start Express server
  app.listen(PORT, () => {
    console.log(`✓ API Server running on http://localhost:${PORT}`);
    console.log('');
    console.log('STEP 1: Start Edge with remote debugging:');
    console.log('  Use the start-edge.ps1 script OR run manually:');
    console.log('  msedge.exe --remote-debugging-port=9223 --user-data-dir="path/to/profile"');
    console.log('');
    console.log('STEP 2: Navigate to chess.com and start a game');
    console.log('');
    console.log('STEP 3: Auto-connect to Edge...');
    console.log('');
  });

  // Auto-connect to Edge
  setTimeout(async () => {
    await connectToEdge();

    if (connected) {
      console.log('');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('✓ Ready! API Endpoints:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`  POST http://localhost:${PORT}/move`);
      console.log('       Body: { "move": "e2e4" }');
      console.log('');
      console.log(`  GET  http://localhost:${PORT}/board`);
      console.log('       Returns current FEN position');
      console.log('');
      console.log(`  GET  http://localhost:${PORT}/status`);
      console.log('       Returns connection and game status');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
    }
  }, 2000);

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n\nShutting down...');
    if (browser) await browser.disconnect();
    process.exit(0);
  });
}

start();
