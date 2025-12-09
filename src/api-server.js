#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-core';
import { Chess } from 'chess.js';
import { UCIEngine } from './uci-engine.js';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

/**
 * API Server for chess.com move automation
 * Connects to existing Chrome instance and provides REST API for move execution
 */

const app = express();
const PORT = 3000;

// Load configuration
let config = {};
try {
  config = JSON.parse(readFileSync('./config-api.json', 'utf8'));
} catch (error) {
  console.warn('Warning: Could not load config-api.json, using defaults');
  config = {
    engine: {
      path: './engine',
      threads: 1,
      nodes: 1000000
    }
  };
}

// Middleware
app.use(cors());
app.use(express.json());

// State
let browser = null;
let page = null;
let connected = false;
let gameActive = false;
let chess = new Chess();
let moveHistory = []; // Track moves in UCI format (e2e4, e7e5, etc.)

// Engine state
let engine = null;
let engineEnabled = false;

// Autoplay state
let autoplayEnabled = false;
let autoplayColor = 'white'; // 'white' or 'black'
let autoplayInterval = null;
let autoplayBusy = false; // Prevent concurrent autoplay actions
let engineConfig = {
  nodes: config.engine?.nodes || 1000000,
  threads: config.engine?.threads || 1,
  selectedEngine: null // Currently selected engine name
};

const ENGINES_DIR = './engines';

/**
 * Discover available chess engines in the engines directory
 */
function discoverEngines() {
  try {
    const files = readdirSync(ENGINES_DIR);
    const engines = [];

    for (const file of files) {
      const fullPath = join(ENGINES_DIR, file);
      try {
        const stats = statSync(fullPath);

        // Check if it's a file and executable
        if (stats.isFile() && file !== '.gitkeep') {
          // On Unix, check if executable bit is set
          const isExecutable = process.platform === 'win32' || (stats.mode & 0o111) !== 0;

          engines.push({
            name: file,
            path: fullPath,
            size: stats.size,
            executable: isExecutable,
            modified: stats.mtime
          });
        }
      } catch (err) {
        console.warn(`Could not stat ${fullPath}:`, err.message);
      }
    }

    return engines;
  } catch (error) {
    console.warn('Could not read engines directory:', error.message);
    return [];
  }
}

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
 * Detect whose turn it is
 * Returns 'white', 'black', or null if unable to determine
 */
async function detectTurn() {
  if (!page) return null;

  try {
    const turnInfo = await page.evaluate(() => {
      // Method 1: Check for highlighted squares or move indicators
      const board = document.querySelector('.board');
      if (!board) return { method: 'none', turn: null };

      // Method 2: Look for turn indicator text
      const turnText = document.querySelector('.turn-indicator, .player-turn, [class*="turn"]');
      if (turnText && turnText.textContent) {
        const text = turnText.textContent.toLowerCase();
        if (text.includes('white') || text.includes('you') && !board.classList.contains('flipped')) {
          return { method: 'text', turn: 'white' };
        }
        if (text.includes('black') || text.includes('you') && board.classList.contains('flipped')) {
          return { method: 'text', turn: 'black' };
        }
      }

      // Method 3: Check if board is flipped and look for active player
      const isFlipped = board.classList.contains('flipped');

      // Method 4: Look for clock that's ticking or highlighted player
      const whiteClock = document.querySelector('.clock-white, [class*="clock"][class*="white"], .player-component.player-bottom .clock, .clock.player-bottom');
      const blackClock = document.querySelector('.clock-black, [class*="clock"][class*="black"], .player-component.player-top .clock, .clock.player-top');

      // Active clock might have a specific class
      if (whiteClock?.classList.contains('clock-active') || whiteClock?.classList.contains('running')) {
        return { method: 'clock', turn: 'white' };
      }
      if (blackClock?.classList.contains('clock-active') || blackClock?.classList.contains('running')) {
        return { method: 'clock', turn: 'black' };
      }

      // Return board flip status as fallback info
      return { method: 'flip', turn: null, isFlipped };
    });

    // If we couldn't detect from DOM, use move history
    if (!turnInfo.turn) {
      // Even number of moves = white's turn, odd = black's turn
      const turn = moveHistory.length % 2 === 0 ? 'white' : 'black';
      return turn;
    }

    return turnInfo.turn;
  } catch (error) {
    console.error('Error detecting turn:', error.message);
    // Fallback to move history
    return moveHistory.length % 2 === 0 ? 'white' : 'black';
  }
}

/**
 * Check if it's our turn based on autoplay color setting
 */
async function isOurTurn() {
  const currentTurn = await detectTurn();
  return currentTurn === autoplayColor;
}

/**
 * Internal function to sync position with board (detect opponent moves)
 * Returns object with sync details: { synced, positionsMatch, detectedMove, currentFen, expectedFen }
 */
async function syncPositionInternal() {
  if (!connected || !page) {
    return { synced: false, error: 'Not connected' };
  }

  try {
    // Get current board state from browser
    const currentFen = await getBoardState();
    if (!currentFen) {
      return { synced: false, error: 'Could not read board state' };
    }

    // Get expected position from move history
    const expectedChess = new Chess();
    for (const move of moveHistory) {
      const from = move.substring(0, 2);
      const to = move.substring(2, 4);
      const promotion = move.length > 4 ? move[4] : undefined;
      try {
        expectedChess.move({ from, to, promotion });
      } catch (err) {
        console.error(`   ✗ Invalid move in history: ${move}`);
      }
    }

    const expectedFen = expectedChess.fen();

    // Compare positions (only the board part, ignore turn/castling/etc)
    const currentBoard = currentFen.split(' ')[0];
    const expectedBoard = expectedFen.split(' ')[0];

    if (currentBoard === expectedBoard) {
      // Positions match - no opponent move detected
      return {
        synced: true,
        positionsMatch: true,
        currentFen,
        expectedFen
      };
    }

    // Positions don't match - try to find the move
    const possibleMoves = expectedChess.moves({ verbose: true });
    let detectedMove = null;

    for (const move of possibleMoves) {
      const testChess = new Chess(expectedFen);
      testChess.move(move);
      const testBoard = testChess.fen().split(' ')[0];

      if (testBoard === currentBoard) {
        // Found the move!
        detectedMove = move.from + move.to + (move.promotion || '');
        break;
      }
    }

    if (detectedMove) {
      console.log(`   🔄 Detected opponent move: ${detectedMove}`);
      moveHistory.push(detectedMove);

      // Update chess instance
      chess.load(currentFen);

      return {
        synced: true,
        positionsMatch: false,
        detectedMove,
        currentFen,
        expectedFen
      };
    }

    // Could not sync
    console.warn('   ⚠ Could not sync position - positions too different');
    return {
      synced: false,
      error: 'Could not detect opponent move - positions too different',
      currentFen,
      expectedFen
    };
  } catch (error) {
    console.error('Error syncing position:', error.message);
    return {
      synced: false,
      error: error.message
    };
  }
}

/**
 * Autoplay loop - checks if it's our turn and plays engine move
 */
async function autoplayLoop() {
  // Skip if already processing
  if (autoplayBusy) {
    return;
  }

  try {
    autoplayBusy = true;

    // Check if game is still active
    const isActive = await checkGameStatus();
    if (!isActive) {
      console.log('⏸️  Game ended - autoplay paused');
      return;
    }

    // SYNC POSITION FIRST - detect opponent moves
    await syncPositionInternal();

    // Check if it's our turn
    const ourTurn = await isOurTurn();
    const currentTurn = await detectTurn();

    if (!ourTurn) {
      // Not our turn, just wait
      return;
    }

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🤖 AUTOPLAY - It\'s our turn!');
    console.log(`   Playing as: ${autoplayColor}`);
    console.log(`   Current turn: ${currentTurn}`);
    console.log(`   Move history: ${moveHistory.join(' ')}`);

    // Check if engine is ready
    if (!engineEnabled || !engine || !engine.isReady()) {
      console.log('❌ Engine not enabled or not ready');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      return;
    }

    // Set position for engine
    console.log('   Setting position...');
    engine.setPosition('startpos', moveHistory);

    // Get best move
    console.log(`   Calculating (${engineConfig.nodes} nodes)...`);
    const result = await engine.goNodes(engineConfig.nodes);
    const bestMove = result.move;

    console.log(`   ✓ Engine suggests: ${bestMove}`);

    // Execute the move
    console.log('   Executing move on board...');
    await executeMove(bestMove);

    // Track the move
    moveHistory.push(bestMove);
    console.log(`   ✓ Move completed! Total moves: ${moveHistory.length}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

  } catch (error) {
    console.error('❌ Autoplay error:', error.message);
  } finally {
    autoplayBusy = false;
  }
}

/**
 * Start autoplay monitoring
 */
function startAutoplay() {
  if (autoplayInterval) {
    clearInterval(autoplayInterval);
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 AUTOPLAY ENABLED');
  console.log(`   Playing as: ${autoplayColor}`);
  console.log(`   Checking every 2 seconds...`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  autoplayEnabled = true;

  // Check every 2 seconds
  autoplayInterval = setInterval(autoplayLoop, 2000);

  // Run immediately
  autoplayLoop();
}

/**
 * Stop autoplay monitoring
 */
function stopAutoplay() {
  if (autoplayInterval) {
    clearInterval(autoplayInterval);
    autoplayInterval = null;
  }

  autoplayEnabled = false;

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⏹️  AUTOPLAY DISABLED');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
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
      moveHistory,
      moveCount: moveHistory.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset move history (for new games)
app.post('/reset', async (req, res) => {
  try {
    const previousMoveCount = moveHistory.length;
    moveHistory = [];
    chess.reset();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔄 Position reset');
    console.log(`   Cleared ${previousMoveCount} moves from history`);

    // Send ucinewgame to engine if it's enabled
    if (engineEnabled && engine && engine.isReady()) {
      console.log('   Sending ucinewgame to engine...');
      await engine.newGame();
      console.log('   ✓ Engine reset for new game');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    res.json({
      success: true,
      message: 'Move history reset',
      previousMoveCount,
      engineReset: engineEnabled && engine && engine.isReady(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set move history manually
app.post('/position', async (req, res) => {
  try {
    const { moves } = req.body;

    if (!Array.isArray(moves)) {
      return res.status(400).json({
        error: 'Moves must be an array of UCI moves (e.g., ["e2e4", "e7e5"])'
      });
    }

    // Validate each move is in UCI format
    const uciPattern = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
    const invalidMoves = moves.filter(m => !uciPattern.test(m));

    if (invalidMoves.length > 0) {
      return res.status(400).json({
        error: 'Invalid UCI move format',
        invalidMoves
      });
    }

    moveHistory = [...moves];

    // Update chess.js instance to match
    chess.reset();
    for (const move of moveHistory) {
      const from = move.substring(0, 2);
      const to = move.substring(2, 4);
      const promotion = move.length > 4 ? move[4] : undefined;
      chess.move({ from, to, promotion });
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📍 Position set manually');
    console.log(`   Moves: ${moveHistory.join(' ')}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    res.json({
      success: true,
      message: 'Position set',
      moveHistory,
      moveCount: moveHistory.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Enable autoplay
app.post('/autoplay/enable', async (req, res) => {
  try {
    const { color } = req.body;

    if (!connected) {
      return res.status(400).json({ error: 'Not connected to browser' });
    }

    if (!engineEnabled || !engine || !engine.isReady()) {
      return res.status(400).json({ error: 'Engine not enabled. Use /engine/enable first' });
    }

    // Validate color
    if (color && color !== 'white' && color !== 'black') {
      return res.status(400).json({ error: 'Color must be "white" or "black"' });
    }

    // Set color (default to white)
    if (color) {
      autoplayColor = color;
    }

    // Start autoplay
    startAutoplay();

    res.json({
      success: true,
      message: 'Autoplay enabled',
      color: autoplayColor,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disable autoplay
app.post('/autoplay/disable', async (req, res) => {
  try {
    stopAutoplay();

    res.json({
      success: true,
      message: 'Autoplay disabled',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get autoplay status
app.get('/autoplay/status', async (req, res) => {
  try {
    const currentTurn = await detectTurn();
    const ourTurn = await isOurTurn();

    res.json({
      enabled: autoplayEnabled,
      color: autoplayColor,
      busy: autoplayBusy,
      currentTurn,
      ourTurn,
      gameActive,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sync position with board (detect opponent moves)
app.post('/sync', async (req, res) => {
  try {
    if (!connected) {
      return res.status(400).json({ error: 'Not connected to browser' });
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔄 Syncing position with board...');

    const result = await syncPositionInternal();

    if (result.synced) {
      if (result.positionsMatch) {
        console.log('   ✓ Positions match - no opponent move detected');
      } else {
        console.log(`   ✓ Detected opponent move: ${result.detectedMove}`);
        console.log(`   ✓ Move history updated (${moveHistory.length} moves)`);
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      res.json({
        success: true,
        synced: true,
        positionsMatch: result.positionsMatch,
        detectedMove: result.detectedMove,
        moveHistory,
        moveCount: moveHistory.length
      });
    } else {
      console.log('   ✗ Could not determine opponent move');
      console.log('   → You may need to manually set the position');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      res.json({
        success: false,
        synced: false,
        error: result.error,
        currentFen: result.currentFen,
        expectedFen: result.expectedFen,
        suggestion: 'Use POST /position to manually set the move history'
      });
    }
  } catch (error) {
    console.error('❌ Error syncing position:', error);
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

    // Track the move in history for engine
    moveHistory.push(move);
    console.log('✓ Move added to history. Total moves:', moveHistory.length);

    res.json({
      success: true,
      move,
      result,
      moveHistory: moveHistory.length,
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
 * Engine Control Endpoints
 */

// List available engines
app.get('/engine/list', (req, res) => {
  const engines = discoverEngines();

  res.json({
    success: true,
    engines,
    count: engines.length,
    enginesDir: ENGINES_DIR
  });
});

// Enable engine
app.post('/engine/enable', async (req, res) => {
  try {
    const { engine: engineName } = req.body;

    if (engineEnabled && engine) {
      return res.json({
        success: true,
        message: 'Engine already enabled',
        engineEnabled: true,
        selectedEngine: engineConfig.selectedEngine
      });
    }

    // If no engine specified, try to use the first available one
    let enginePath;
    let selectedEngineName;

    if (engineName) {
      // User specified an engine
      const availableEngines = discoverEngines();
      const selectedEngine = availableEngines.find(e => e.name === engineName);

      if (!selectedEngine) {
        return res.status(400).json({
          success: false,
          error: `Engine "${engineName}" not found. Use GET /engine/list to see available engines.`,
          availableEngines: availableEngines.map(e => e.name)
        });
      }

      if (!selectedEngine.executable) {
        return res.status(400).json({
          success: false,
          error: `Engine "${engineName}" is not executable. Please make it executable: chmod +x engines/${engineName}`
        });
      }

      enginePath = selectedEngine.path;
      selectedEngineName = engineName;
    } else {
      // Auto-select first available engine
      const availableEngines = discoverEngines();
      const executableEngines = availableEngines.filter(e => e.executable);

      if (executableEngines.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No executable engines found in engines/ directory. Please add a UCI chess engine.',
          availableEngines: availableEngines.map(e => e.name)
        });
      }

      enginePath = executableEngines[0].path;
      selectedEngineName = executableEngines[0].name;
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🤖 Starting chess engine...');
    console.log(`   Engine: ${selectedEngineName}`);
    console.log(`   Path: ${enginePath}`);
    console.log(`   Threads: ${engineConfig.threads}`);
    console.log(`   Node limit: ${engineConfig.nodes}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Create and start engine
    engine = new UCIEngine(enginePath, {
      threads: engineConfig.threads
    });

    await engine.start();
    engineEnabled = true;
    engineConfig.selectedEngine = selectedEngineName;

    console.log('✓ Engine enabled and ready');

    res.json({
      success: true,
      message: 'Engine enabled',
      engineEnabled: true,
      selectedEngine: selectedEngineName,
      config: engineConfig
    });
  } catch (error) {
    console.error('❌ Failed to enable engine:', error.message);
    engineEnabled = false;
    engine = null;
    engineConfig.selectedEngine = null;
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to start engine. Make sure the engine executable exists and is compatible with UCI protocol.'
    });
  }
});

// Disable engine
app.post('/engine/disable', async (req, res) => {
  try {
    if (!engineEnabled || !engine) {
      return res.json({
        success: true,
        message: 'Engine already disabled',
        engineEnabled: false
      });
    }

    console.log('🤖 Stopping chess engine...');

    const stoppedEngine = engineConfig.selectedEngine;
    await engine.quit();
    engine = null;
    engineEnabled = false;
    engineConfig.selectedEngine = null;

    console.log('✓ Engine disabled');

    res.json({
      success: true,
      message: 'Engine disabled',
      engineEnabled: false,
      stoppedEngine
    });
  } catch (error) {
    console.error('❌ Failed to disable engine:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Switch to a different engine
app.post('/engine/switch', async (req, res) => {
  try {
    const { engine: newEngineName } = req.body;

    if (!newEngineName) {
      return res.status(400).json({
        success: false,
        error: 'Engine name required. Provide { "engine": "engine-name" }'
      });
    }

    // Check if the new engine exists
    const availableEngines = discoverEngines();
    const newEngine = availableEngines.find(e => e.name === newEngineName);

    if (!newEngine) {
      return res.status(400).json({
        success: false,
        error: `Engine "${newEngineName}" not found`,
        availableEngines: availableEngines.map(e => e.name)
      });
    }

    if (!newEngine.executable) {
      return res.status(400).json({
        success: false,
        error: `Engine "${newEngineName}" is not executable. Please make it executable: chmod +x engines/${newEngineName}`
      });
    }

    const previousEngine = engineConfig.selectedEngine;

    // Stop current engine if running
    if (engineEnabled && engine) {
      console.log(`Stopping current engine: ${previousEngine}...`);
      await engine.quit();
      engine = null;
      engineEnabled = false;
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔄 Switching chess engine...');
    console.log(`   From: ${previousEngine || 'none'}`);
    console.log(`   To: ${newEngineName}`);
    console.log(`   Threads: ${engineConfig.threads}`);
    console.log(`   Node limit: ${engineConfig.nodes}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Start new engine
    engine = new UCIEngine(newEngine.path, {
      threads: engineConfig.threads
    });

    await engine.start();
    engineEnabled = true;
    engineConfig.selectedEngine = newEngineName;

    console.log('✓ Engine switch completed');

    res.json({
      success: true,
      message: 'Engine switched successfully',
      previousEngine: previousEngine || 'none',
      currentEngine: newEngineName,
      engineEnabled: true,
      config: engineConfig
    });
  } catch (error) {
    console.error('❌ Failed to switch engine:', error.message);
    engineEnabled = false;
    engine = null;
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Configure engine
app.post('/engine/config', async (req, res) => {
  try {
    const { nodes, threads } = req.body;

    const wasEnabled = engineEnabled;
    const currentEngine = engineConfig.selectedEngine;

    // If engine is running, stop it first
    if (engineEnabled && engine) {
      console.log('Stopping engine to apply new configuration...');
      await engine.quit();
      engine = null;
      engineEnabled = false;
    }

    // Update configuration
    if (nodes !== undefined) {
      engineConfig.nodes = parseInt(nodes);
      console.log(`✓ Node limit updated: ${engineConfig.nodes}`);
    }
    if (threads !== undefined) {
      engineConfig.threads = parseInt(threads);
      console.log(`✓ Threads updated: ${engineConfig.threads}`);
    }

    // Restart engine if it was running
    if (wasEnabled && currentEngine) {
      console.log('Restarting engine with new configuration...');
      const availableEngines = discoverEngines();
      const engineInfo = availableEngines.find(e => e.name === currentEngine);

      if (!engineInfo) {
        return res.status(400).json({
          success: false,
          error: `Previously selected engine "${currentEngine}" no longer available`
        });
      }

      engine = new UCIEngine(engineInfo.path, {
        threads: engineConfig.threads
      });
      await engine.start();
      engineEnabled = true;
      engineConfig.selectedEngine = currentEngine;
      console.log('✓ Engine restarted with new configuration');
    }

    res.json({
      success: true,
      message: 'Engine configuration updated',
      config: {
        nodes: engineConfig.nodes,
        threads: engineConfig.threads,
        selectedEngine: engineConfig.selectedEngine
      },
      engineEnabled
    });
  } catch (error) {
    console.error('❌ Failed to configure engine:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get engine status
app.get('/engine/status', (req, res) => {
  const availableEngines = discoverEngines();

  res.json({
    engineEnabled,
    engineReady: engine ? engine.isReady() : false,
    thinking: engine ? engine.thinking : false,
    selectedEngine: engineConfig.selectedEngine,
    config: {
      nodes: engineConfig.nodes,
      threads: engineConfig.threads
    },
    availableEngines: availableEngines.map(e => ({
      name: e.name,
      executable: e.executable,
      size: e.size
    }))
  });
});

// Get engine move suggestion
app.get('/engine/suggest', async (req, res) => {
  try {
    if (!engineEnabled || !engine) {
      return res.status(400).json({
        error: 'Engine not enabled. Call POST /engine/enable first.'
      });
    }

    if (!connected) {
      return res.status(400).json({
        error: 'Not connected to browser'
      });
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🤖 Getting engine suggestion...');

    // Get current board state
    const fen = await getBoardState();
    if (!fen) {
      return res.status(400).json({
        error: 'Could not read board state'
      });
    }

    console.log(`   Position: ${fen}`);
    console.log(`   Move history (${moveHistory.length} moves):`, moveHistory.join(' '));

    // Set position for engine using move history
    engine.setPosition('startpos', moveHistory);

    // Get best move using node limit
    console.log(`   Searching with ${engineConfig.nodes} nodes...`);
    const result = await engine.goNodes(engineConfig.nodes);

    console.log(`✓ Engine suggests: ${result.move}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    res.json({
      success: true,
      move: result.move,
      ponder: result.ponder,
      fen,
      moveHistory,
      nodes: engineConfig.nodes,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error getting engine suggestion:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
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
      console.log('  BROWSER CONTROL:');
      console.log(`    POST http://localhost:${PORT}/move`);
      console.log('         Body: { "move": "e2e4" }');
      console.log(`    GET  http://localhost:${PORT}/board`);
      console.log('         Returns current FEN position and move history');
      console.log(`    GET  http://localhost:${PORT}/status`);
      console.log('         Returns connection and game status');
      console.log(`    POST http://localhost:${PORT}/sync`);
      console.log('         Detect opponent moves and sync position');
      console.log(`    POST http://localhost:${PORT}/reset`);
      console.log('         Reset move history (for new games)');
      console.log(`    POST http://localhost:${PORT}/position`);
      console.log('         Body: { "moves": ["e2e4", "e7e5"] }');
      console.log('');
      console.log('  ENGINE CONTROL:');
      console.log(`    GET  http://localhost:${PORT}/engine/list`);
      console.log('         List all available engines in engines/ folder');
      console.log(`    POST http://localhost:${PORT}/engine/enable`);
      console.log('         Body: { "engine": "engine-name" } (optional, auto-selects first)');
      console.log(`    POST http://localhost:${PORT}/engine/disable`);
      console.log('         Disable chess engine');
      console.log(`    POST http://localhost:${PORT}/engine/switch`);
      console.log('         Body: { "engine": "engine-name" }');
      console.log(`    POST http://localhost:${PORT}/engine/config`);
      console.log('         Body: { "nodes": 1000000, "threads": 1 }');
      console.log(`    GET  http://localhost:${PORT}/engine/status`);
      console.log('         Returns engine status and available engines');
      console.log(`    GET  http://localhost:${PORT}/engine/suggest`);
      console.log('         Get engine move suggestion for current position');
      console.log('');
      console.log('  AUTOPLAY (Automatic Engine Play):');
      console.log(`    POST http://localhost:${PORT}/autoplay/enable`);
      console.log('         Body: { "color": "white" } or { "color": "black" }');
      console.log('         Automatically plays moves when it\'s your turn');
      console.log(`    POST http://localhost:${PORT}/autoplay/disable`);
      console.log('         Stop autoplay');
      console.log(`    GET  http://localhost:${PORT}/autoplay/status`);
      console.log('         Returns autoplay status and current turn info');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
    }
  }, 2000);

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n\nShutting down...');

    // Stop autoplay if running
    if (autoplayEnabled) {
      console.log('Stopping autoplay...');
      stopAutoplay();
    }

    // Stop engine if running
    if (engine) {
      console.log('Stopping engine...');
      await engine.quit();
    }

    // Disconnect browser
    if (browser) await browser.disconnect();

    process.exit(0);
  });
}

start();
