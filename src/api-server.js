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
let startingFen = null; // If game started from custom position, store the FEN here

// Engine state
let engine = null;
let engineEnabled = false;

// Autoplay state
let autoplayEnabled = false;
let autoplayColor = 'white'; // 'white' or 'black'
let autoplayInterval = null;
let autoplayBusy = false; // Prevent concurrent autoplay actions
let engineConfig = {
  mode: config.engine?.mode || 'nodes', // 'nodes' or 'time'
  nodes: config.engine?.nodes || 1000000,
  threads: config.engine?.threads || 1,
  timeControl: {
    base: config.engine?.timeControl?.base || 60000,
    increment: config.engine?.timeControl?.increment || 1000,
    threads: config.engine?.timeControl?.threads || 8
  },
  selectedEngine: null // Currently selected engine name
};

// Time tracking for time control mode
let timeTracking = {
  whiteTime: engineConfig.timeControl.base,
  blackTime: engineConfig.timeControl.base,
  increment: engineConfig.timeControl.increment
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

        // Check if it's a file
        if (stats.isFile() && file !== '.gitkeep') {
          engines.push({
            name: file,
            path: fullPath,
            size: stats.size,
            executable: true,
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
 * Combined function to check game status and detect turn in a single DOM query
 * This reduces page.evaluate() overhead by combining multiple checks
 */
async function checkGameStatusAndTurn() {
  if (!page) return { isActive: false, turn: null };

  try {
    const result = await page.evaluate(() => {
      // Check if game is active
      const board = document.querySelector('.board');
      const gameOver = document.querySelector('.game-over-modal, .game-over-text');
      const isActive = board && !gameOver;

      if (!isActive) return { isActive: false, turn: null };

      // Detect turn while we're already in the page context
      // Method 1: Look for turn indicator text
      const turnText = document.querySelector('.turn-indicator, .player-turn, [class*="turn"]');
      if (turnText && turnText.textContent) {
        const text = turnText.textContent.toLowerCase();
        if (text.includes('white') || text.includes('you') && !board.classList.contains('flipped')) {
          return { isActive: true, turn: 'white' };
        }
        if (text.includes('black') || text.includes('you') && board.classList.contains('flipped')) {
          return { isActive: true, turn: 'black' };
        }
      }

      // Method 2: Check active clock
      const whiteClock = document.querySelector('.clock-white, [class*="clock"][class*="white"], .player-component.player-bottom .clock, .clock.player-bottom');
      const blackClock = document.querySelector('.clock-black, [class*="clock"][class*="black"], .player-component.player-top .clock, .clock.player-top');

      if (whiteClock?.classList.contains('clock-active') || whiteClock?.classList.contains('running')) {
        return { isActive: true, turn: 'white' };
      }
      if (blackClock?.classList.contains('clock-active') || blackClock?.classList.contains('running')) {
        return { isActive: true, turn: 'black' };
      }

      // Return board flip status as fallback info
      return { isActive: true, turn: null, isFlipped: board.classList.contains('flipped') };
    });

    gameActive = result.isActive;
    return result;
  } catch (error) {
    console.error('Error checking game status and turn:', error.message);
    return { isActive: false, turn: null };
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
 * Convert SAN move to UCI format
 * e.g., "e4" -> "e2e4", "Nf3" -> "g1f3"
 */
function sanToUci(sanMove, position) {
  try {
    const testChess = new Chess(position);
    const move = testChess.move(sanMove);

    if (!move) {
      return null;
    }

    return move.from + move.to + (move.promotion || '');
  } catch (err) {
    return null;
  }
}

/**
 * Extract move history from chess.com's game state
 * Returns array of moves in UCI format, or null if not found
 */
async function extractMoveHistoryFromChessCom() {
  if (!page) return null;

  try {
    const moveData = await page.evaluate(() => {
      // Try to extract moves from chess.com's internal game state
      try {
        const debug = {
          windowKeys: Object.keys(window).filter(k => k.toLowerCase().includes('chess') || k.toLowerCase().includes('game')),
          hasChessGame: !!window.chessGame,
          hasGameSetup: !!window.gameSetup,
          chessGameMethods: window.chessGame ? Object.keys(window.chessGame).slice(0, 20) : [],
          gameSetupKeys: window.gameSetup ? Object.keys(window.gameSetup) : []
        };

        console.log('Debug info:', debug);

        // Method 1: Try chessGame.getHistory()
        if (window.chessGame && typeof window.chessGame.getHistory === 'function') {
          try {
            const history = window.chessGame.getHistory();
            console.log('Found move history via chessGame.getHistory():', history);
            if (history && history.length > 0) {
              return { method: 'chessGame.getHistory', moves: history, format: 'unknown' };
            }
          } catch (e) {
            console.log('chessGame.getHistory() failed:', e);
          }
        }

        // Method 2: Try chessGame.getMoves() or similar
        if (window.chessGame) {
          const possibleMethods = ['getMoves', 'moves', 'getGame', 'history', 'pgn'];
          for (const method of possibleMethods) {
            if (typeof window.chessGame[method] === 'function') {
              try {
                const result = window.chessGame[method]();
                console.log(`Found via chessGame.${method}():`, result);
                if (result && (Array.isArray(result) || typeof result === 'string')) {
                  return { method: `chessGame.${method}`, moves: result, format: 'unknown' };
                }
              } catch (e) {
                // Ignore
              }
            }
          }
        }

        // Method 3: Check gameSetup
        if (window.gameSetup && window.gameSetup.moves) {
          console.log('Found move history via gameSetup.moves:', window.gameSetup.moves);
          return { method: 'gameSetup', moves: window.gameSetup.moves, format: 'unknown' };
        }

        // Method 4: Parse from move list in DOM (look for SAN notation)
        const moveSelectors = [
          '.move',
          '.node',
          '[class*="move"]',
          '[class*="node"]',
          '[data-whole-move-number]',
          '.vertical-move-list .move',
          '.move-text'
        ];

        for (const selector of moveSelectors) {
          const moveElements = document.querySelectorAll(selector);
          if (moveElements.length > 0) {
            const moves = Array.from(moveElements)
              .map(el => el.textContent.trim())
              .filter(text => text && text.length > 0 && text.length < 10) // SAN moves are typically short
              .filter(text => /^[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQ])?[+#]?$|^O-O(-O)?[+#]?$/.test(text)); // SAN pattern

            if (moves.length > 0) {
              console.log(`Found ${moves.length} moves from DOM (${selector}):`, moves.slice(0, 10));
              return { method: 'dom', moves, format: 'san' };
            }
          }
        }

        console.log('No move history found');
        return { method: 'none', moves: null, debug };
      } catch (err) {
        console.error('Error extracting move history:', err);
        return { method: 'error', moves: null, error: err.message };
      }
    });

    console.log('   → Move extraction result:', moveData.method);

    if (!moveData || !moveData.moves) {
      console.log('   ⚠ Could not extract move history from chess.com');
      if (moveData?.debug) {
        console.log('   → Debug info:', JSON.stringify(moveData.debug, null, 2));
      }
      return null;
    }

    let moves = moveData.moves;

    // If we got a string (like PGN), try to parse it
    if (typeof moves === 'string') {
      // Extract moves from PGN-like string
      moves = moves.match(/[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQ])?[+#]?|O-O(-O)?[+#]?/g) || [];
    }

    // Convert SAN to UCI if needed
    if (moveData.format === 'san' || !moves[0]?.match(/^[a-h][1-8][a-h][1-8][qrbn]?$/)) {
      console.log('   → Converting SAN to UCI...');
      const uciMoves = [];
      let position = new Chess().fen();

      for (const sanMove of moves) {
        const uciMove = sanToUci(sanMove, position);
        if (uciMove) {
          uciMoves.push(uciMove);
          // Update position for next conversion
          const tempChess = new Chess(position);
          tempChess.move(sanMove);
          position = tempChess.fen();
        } else {
          console.warn(`   ⚠ Could not convert SAN move: ${sanMove}`);
          break;
        }
      }

      if (uciMoves.length > 0) {
        console.log(`   ✓ Converted ${uciMoves.length} SAN moves to UCI`);
        return uciMoves;
      }
    }

    // Already in UCI format
    if (Array.isArray(moves) && moves.length > 0) {
      console.log(`   ✓ Extracted ${moves.length} moves from chess.com (${moveData.method})`);
      return moves;
    }

    console.log('   ⚠ Could not extract or convert move history');
    return null;
  } catch (error) {
    console.error('Error extracting move history:', error.message);
    return null;
  }
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

    // Check if move history is empty (starting from unknown position)
    if (moveHistory.length === 0) {
      console.log('   ℹ Move history is empty - attempting to extract from chess.com...');

      // Try to extract move history from chess.com
      const extractedMoves = await extractMoveHistoryFromChessCom();

      if (extractedMoves && extractedMoves.length > 0) {
        // Validate and use extracted moves
        const validMoves = [];
        const testChess = new Chess();

        for (const move of extractedMoves) {
          const from = move.substring(0, 2);
          const to = move.substring(2, 4);
          const promotion = move.length > 4 ? move[4] : undefined;

          try {
            testChess.move({ from, to, promotion });
            validMoves.push(move);
          } catch (err) {
            console.warn(`   ⚠ Invalid extracted move: ${move}`);
            break; // Stop at first invalid move
          }
        }

        if (validMoves.length > 0) {
          moveHistory = [...validMoves];
          chess.load(testChess.fen());

          console.log(`   ✓ Synced position with ${validMoves.length} extracted moves`);
          console.log(`   → Move history: ${moveHistory.join(' ')}`);

          return {
            synced: true,
            positionsMatch: true,
            extractedMoves: true,
            moveCount: validMoves.length,
            currentFen,
            expectedFen: testChess.fen()
          };
        }
      }

      // Couldn't extract moves - check if at starting position
      const currentBoard = currentFen.split(' ')[0];
      const startBoard = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

      if (currentBoard === startBoard) {
        console.log('   ✓ At starting position - no moves to sync');
        startingFen = null; // Regular starting position
        return {
          synced: true,
          positionsMatch: true,
          currentFen,
          expectedFen: new Chess().fen(),
          fromStartingPosition: true
        };
      }

      // Custom starting position - store the FEN and treat as synced
      console.log('   ℹ Custom starting position detected');
      console.log(`   → FEN: ${currentFen}`);
      console.log('   → Setting as starting position with no move history');

      startingFen = currentFen;
      moveHistory = [];
      chess.load(currentFen);

      return {
        synced: true,
        positionsMatch: true,
        customStartingPosition: true,
        currentFen,
        expectedFen: currentFen,
        message: 'Custom starting position detected and set'
      };
    }

    // Get expected position from move history
    const expectedChess = startingFen ? new Chess(startingFen) : new Chess();
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

    // Could not sync - try extracting full history as fallback
    console.log('   ⚠ Positions diverged - attempting full re-sync...');
    const extractedMoves = await extractMoveHistoryFromChessCom();

    if (extractedMoves && extractedMoves.length > 0) {
      const validMoves = [];
      const testChess = new Chess();

      for (const move of extractedMoves) {
        const from = move.substring(0, 2);
        const to = move.substring(2, 4);
        const promotion = move.length > 4 ? move[4] : undefined;

        try {
          testChess.move({ from, to, promotion });
          validMoves.push(move);
        } catch (err) {
          break;
        }
      }

      if (validMoves.length > 0) {
        moveHistory = [...validMoves];
        chess.load(testChess.fen());

        console.log(`   ✓ Re-synced with ${validMoves.length} extracted moves`);

        return {
          synced: true,
          positionsMatch: false,
          reSynced: true,
          moveCount: validMoves.length,
          currentFen,
          expectedFen: testChess.fen()
        };
      }
    }

    // Could not sync
    console.warn('   ✗ Could not sync position - positions too different');
    return {
      synced: false,
      error: 'Could not detect opponent move - positions too different',
      currentFen,
      expectedFen,
      suggestion: 'Use POST /reset to start fresh, or POST /position to manually set the move history'
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

    // Combined check: game status and turn detection in a single DOM query
    const gameState = await checkGameStatusAndTurn();

    if (!gameState.isActive) {
      console.log('⏸️  Game ended - autoplay paused');
      return;
    }

    // SYNC POSITION FIRST - detect opponent moves
    await syncPositionInternal();

    // Determine whose turn it is (use move history as fallback if DOM detection failed)
    const currentTurn = gameState.turn || (moveHistory.length % 2 === 0 ? 'white' : 'black');
    const ourTurn = currentTurn === autoplayColor;

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
    if (startingFen) {
      // If we have no moves yet, get and use the current FEN (with correct turn indicator)
      if (moveHistory.length === 0) {
        const currentFen = await getBoardState();
        console.log(`   → Using current FEN (no moves played yet): ${currentFen}`);
        engine.setPosition(currentFen, []);
      } else {
        console.log(`   → Using custom starting FEN + ${moveHistory.length} moves: ${startingFen}`);
        engine.setPosition(startingFen, moveHistory);
      }
    } else {
      engine.setPosition('startpos', moveHistory);
    }

    // Get best move based on mode
    let result;
    let bestMove;

    if (engineConfig.mode === 'nodes') {
      console.log(`   Calculating (${engineConfig.nodes} nodes, 1 thread)...`);
      result = await engine.goNodes(engineConfig.nodes);
      bestMove = result.move;
    } else {
      // Time control mode
      console.log(`   Calculating (time control: ${timeTracking.whiteTime}ms + ${timeTracking.increment}ms, ${engineConfig.timeControl.threads} threads)...`);
      result = await engine.go(
        timeTracking.whiteTime,
        timeTracking.blackTime,
        timeTracking.increment,
        timeTracking.increment
      );
      bestMove = result.move;
      const timeUsed = result.timeUsed;

      // Update time tracking
      if (autoplayColor === 'white') {
        timeTracking.whiteTime = timeTracking.whiteTime - timeUsed + timeTracking.increment;
        console.log(`   ⏱️  White time used: ${timeUsed}ms, remaining: ${timeTracking.whiteTime}ms`);
      } else {
        timeTracking.blackTime = timeTracking.blackTime - timeUsed + timeTracking.increment;
        console.log(`   ⏱️  Black time used: ${timeUsed}ms, remaining: ${timeTracking.blackTime}ms`);
      }
    }

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
async function startAutoplay() {
  if (autoplayInterval) {
    clearInterval(autoplayInterval);
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 AUTOPLAY ENABLED');
  console.log(`   Playing as: ${autoplayColor}`);
  console.log('   Using event-driven detection + fallback polling...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  autoplayEnabled = true;

  // Set up event-driven move detection using MutationObserver
  try {
    // Expose a function that the browser can call when moves are detected
    await page.exposeFunction('onChessBoardChange', async () => {
      if (!autoplayEnabled || autoplayBusy) return;
      console.log('   🔔 Board change detected (event-driven)');
      await autoplayLoop();
    });

    // Inject MutationObserver into the page
    await page.evaluate(() => {
      // Clean up any existing observer
      if (window.__chessObserver) {
        window.__chessObserver.disconnect();
        delete window.__chessObserver;
      }

      let debounceTimer = null;
      const observer = new MutationObserver(() => {
        // Debounce: wait 20ms for all related mutations to complete
        // Short delay prevents duplicate triggers while maintaining responsiveness
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (window.onChessBoardChange) {
            window.onChessBoardChange().catch(() => {
              // Ignore errors - might be called after cleanup
            });
          }
        }, 20);
      });

      // Watch for changes to the chess board and move list
      const board = document.querySelector('.board');
      const moveList = document.querySelector('.move-list, .vertical-move-list');

      // Puzzle-specific elements that might update
      const puzzleContainer = document.querySelector('.puzzle-layout, [class*="puzzle"]');
      const movesContainer = document.querySelector('.moves, .move-list, [class*="moves"]');

      let observerActive = false;

      if (board) {
        observer.observe(board, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style']
        });
        observerActive = true;
        console.log('MutationObserver: watching board element');
      }

      if (moveList) {
        observer.observe(moveList, {
          childList: true,
          subtree: true
        });
        observerActive = true;
        console.log('MutationObserver: watching move list element');
      }

      // Watch puzzle-specific containers
      if (puzzleContainer) {
        observer.observe(puzzleContainer, {
          childList: true,
          subtree: true
        });
        observerActive = true;
        console.log('MutationObserver: watching puzzle container');
      }

      if (movesContainer && movesContainer !== moveList) {
        observer.observe(movesContainer, {
          childList: true,
          subtree: true
        });
        observerActive = true;
        console.log('MutationObserver: watching moves container');
      }

      if (observerActive) {
        console.log('MutationObserver: successfully initialized');
        window.__chessObserver = observer;
      } else {
        console.warn('MutationObserver: no elements found to watch');
      }
    });

    console.log('   ✓ Event-driven detection enabled');
  } catch (error) {
    console.warn(`   ⚠ Could not set up event-driven detection: ${error.message}`);
    console.log('   → Falling back to polling-only mode');
  }

  // Fallback polling at 300ms intervals (in case MutationObserver misses something)
  // Faster than the old 2s fallback to ensure responsive puzzle opponent moves
  autoplayInterval = setInterval(autoplayLoop, 300);

  // Run immediately
  autoplayLoop();
}

/**
 * Stop autoplay monitoring
 */
async function stopAutoplay() {
  if (autoplayInterval) {
    clearInterval(autoplayInterval);
    autoplayInterval = null;
  }

  autoplayEnabled = false;

  // Clean up MutationObserver
  try {
    if (page) {
      await page.evaluate(() => {
        if (window.__chessObserver) {
          window.__chessObserver.disconnect();
          delete window.__chessObserver;
          console.log('MutationObserver: disconnected and cleaned up');
        }
      });
    }
  } catch (error) {
    // Ignore errors during cleanup
  }

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
    // Pass context about whether we have reliable move history
    // Only use move count if we started from standard position
    const hasCustomStart = !!startingFen;
    const fen = await page.evaluate(({ moveCount, hasCustomStart }) => {
      // Try to get FEN from chess.com's internal state
      try {
        // Chess.com stores game data in various places
        console.log('Checking window.gameSetup:', window.gameSetup);
        console.log('Checking window.chessGame:', window.chessGame);

        // Try multiple sources for the complete FEN (including castling rights and turn)
        // Priority 1: chessGame.getFEN() - most reliable for complete FEN
        if (window.chessGame?.getFEN) {
          const fen = window.chessGame.getFEN();
          console.log('Got FEN from chessGame.getFEN():', fen);
          return fen;
        }

        // Priority 2: Try to access game instance from global scope
        if (typeof window.game !== 'undefined' && window.game?.getFEN) {
          const fen = window.game.getFEN();
          console.log('Got FEN from window.game.getFEN():', fen);
          return fen;
        }

        // Priority 3: gameSetup.fen - used for puzzles and from-position games
        if (window.gameSetup?.fen) {
          const fen = window.gameSetup.fen;
          console.log('Got FEN from gameSetup.fen:', fen);
          return fen;
        }

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

        // Detect whose turn it is
        let turn = 'w'; // Default to white
        let turnDetectionMethod = 'default';

        // Method 1: Use move count ONLY if we started from standard position
        // This is reliable when we know the full game from the regular start
        if (!hasCustomStart && moveCount !== null && moveCount >= 0) {
          // Even number of moves = white's turn, odd = black's turn
          turn = (moveCount % 2 === 0) ? 'w' : 'b';
          turnDetectionMethod = 'move-count';
        } else {
          // Method 2: Check which player's clock is running (most reliable indicator)
          // Look for various clock selector patterns
          const clockSelectors = [
            '.clock-player-turn', // Generic active clock
            '.clock.player-turn', // Alternative pattern
            '[class*="clock"][class*="turn"]', // Any clock with "turn" in class
            '.clock-component.active', // Active clock component
            '.user-tagline-username.active', // Active player indicator
          ];

          for (const selector of clockSelectors) {
            const activeClock = document.querySelector(selector);
            if (activeClock) {
              const clockClasses = Array.from(activeClock.classList).join(' ');
              const clockParentClasses = activeClock.parentElement ? Array.from(activeClock.parentElement.classList).join(' ') : '';
              const allClasses = clockClasses + ' ' + clockParentClasses;

              console.log('Found active clock with classes:', allClasses);

              // Check if it's black's clock
              if (allClasses.includes('black') || allClasses.includes('top') || allClasses.includes('opponent')) {
                turn = 'b';
                turnDetectionMethod = 'clock-' + selector;
                break;
              } else if (allClasses.includes('white') || allClasses.includes('bottom') || allClasses.includes('player')) {
                turn = 'w';
                turnDetectionMethod = 'clock-' + selector;
                break;
              }
            }
          }

          // Method 3: Check board flipped state and active side
          if (turnDetectionMethod === 'default') {
            const boardElement = document.querySelector('.board');
            if (boardElement) {
              const isFlipped = boardElement.classList.contains('flipped');
              console.log('Board flipped:', isFlipped);

              // In puzzles, the player to move is usually at the bottom
              // If board is flipped, black is at bottom
              // Check for any "to-move" or "turn" indicators
              const moveIndicators = document.querySelectorAll('[class*="to-move"], [class*="turn"], [class*="active"]');
              for (const indicator of moveIndicators) {
                const indicatorClasses = Array.from(indicator.classList).join(' ');
                console.log('Found move indicator:', indicatorClasses);

                if (indicatorClasses.includes('black')) {
                  turn = 'b';
                  turnDetectionMethod = 'move-indicator-black';
                  break;
                } else if (indicatorClasses.includes('white')) {
                  turn = 'w';
                  turnDetectionMethod = 'move-indicator-white';
                  break;
                }
              }
            }
          }

          // Method 4: Check for puzzle-specific indicators
          if (turnDetectionMethod === 'default') {
            // Puzzles often have text like "Black to move" or indicators
            const bodyText = document.body.innerText.toLowerCase();
            if (bodyText.includes('black to move') || bodyText.includes('black to play')) {
              turn = 'b';
              turnDetectionMethod = 'puzzle-text-black';
            } else if (bodyText.includes('white to move') || bodyText.includes('white to play')) {
              turn = 'w';
              turnDetectionMethod = 'puzzle-text-white';
            }
          }

          // Method 5: Try to find the last move highlight to determine who moved last
          if (turnDetectionMethod === 'default') {
            const highlightedSquares = document.querySelectorAll('[class*="highlight"]');
            if (highlightedSquares.length >= 2) {
              // Check what piece color is on the highlighted destination square
              const destSquare = highlightedSquares[highlightedSquares.length - 1];
              const pieceOnDest = destSquare.querySelector('.piece');
              if (pieceOnDest) {
                const pieceClasses = Array.from(pieceOnDest.classList).join(' ');
                // If last move was white piece, it's black's turn now
                if (pieceClasses.includes('wp') || pieceClasses.includes('wn') || pieceClasses.includes('wb') ||
                    pieceClasses.includes('wr') || pieceClasses.includes('wq') || pieceClasses.includes('wk')) {
                  turn = 'b';
                  turnDetectionMethod = 'last-move-white';
                } else if (pieceClasses.includes('bp') || pieceClasses.includes('bn') || pieceClasses.includes('bb') ||
                           pieceClasses.includes('br') || pieceClasses.includes('bq') || pieceClasses.includes('bk')) {
                  turn = 'w';
                  turnDetectionMethod = 'last-move-black';
                }
              }
            }
          }
        }

        // Try to infer castling rights from piece positions
        // This is an approximation - we can only detect if castling MIGHT be possible
        let castling = '';

        // Check if white king and rooks are on starting squares
        const whiteKingOnStart = board[7][4] === 'K'; // e1
        const whiteKingsideRookOnStart = board[7][7] === 'R'; // h1
        const whiteQueensideRookOnStart = board[7][0] === 'R'; // a1

        if (whiteKingOnStart && whiteKingsideRookOnStart) castling += 'K';
        if (whiteKingOnStart && whiteQueensideRookOnStart) castling += 'Q';

        // Check if black king and rooks are on starting squares
        const blackKingOnStart = board[0][4] === 'k'; // e8
        const blackKingsideRookOnStart = board[0][7] === 'r'; // h8
        const blackQueensideRookOnStart = board[0][0] === 'r'; // a8

        if (blackKingOnStart && blackKingsideRookOnStart) castling += 'k';
        if (blackKingOnStart && blackQueensideRookOnStart) castling += 'q';

        if (castling === '') castling = '-';

        console.log(`Detected turn: ${turn} (method: ${turnDetectionMethod}, moveCount: ${moveCount}, hasCustomStart: ${hasCustomStart})`);
        console.log(`Inferred castling rights: ${castling}`);
        return `${fen} ${turn} ${castling} - 0 1`;
      } catch (err) {
        console.error('Error parsing board:', err);
        return null;
      }
    }, { moveCount: moveHistory.length, hasCustomStart });

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

      // Square classes represent actual chess squares (don't change with flip)
      const fromSquareClass = `square-${fromFile}${fromRank}`;

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

    // Use Puppeteer's mouse API to perform drag-and-drop (faster animation)
    console.log(`  → Moving to piece at (${coords.fromX}, ${coords.fromY})`);
    await page.mouse.move(coords.fromX, coords.fromY);
    console.log('  → Mouse down');
    await page.mouse.down();
    await page.waitForTimeout(50); // Reduced from 100ms
    console.log(`  → Dragging to (${coords.toX}, ${coords.toY})`);
    await page.mouse.move(coords.toX, coords.toY, { steps: 5 }); // Reduced from 10 steps
    await page.waitForTimeout(50); // Reduced from 100ms
    console.log('  → Mouse up');
    await page.mouse.up();

    // Handle promotion if needed (click destination square again)
    if (promotion) {
      console.log(`  → Handling promotion to ${promotion}...`);
      await page.waitForTimeout(100); // Wait for promotion dialog to appear

      // Simply click the destination square again (promotes to queen by default)
      console.log(`  → Clicking destination square again at (${coords.toX}, ${coords.toY})`);
      await page.mouse.click(coords.toX, coords.toY);
      console.log('  ✓ Promotion piece selected');

      await page.waitForTimeout(150);
    }

    // Wait for move to be processed
    await page.waitForTimeout(200); // Reduced from 300ms

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
    const hadCustomStart = startingFen !== null;
    moveHistory = [];
    startingFen = null;
    chess.reset();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔄 Position reset');
    console.log(`   Cleared ${previousMoveCount} moves from history`);
    if (hadCustomStart) {
      console.log('   ✓ Custom starting position cleared');
    }

    // Reset time tracking for time control mode
    if (engineConfig.mode === 'time') {
      timeTracking.whiteTime = engineConfig.timeControl.base;
      timeTracking.blackTime = engineConfig.timeControl.base;
      timeTracking.increment = engineConfig.timeControl.increment;
      console.log('   ✓ Time tracking reset');
    }

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
      timeTrackingReset: engineConfig.mode === 'time',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set move history manually
app.post('/position', async (req, res) => {
  try {
    const { moves, fen } = req.body;

    // Validate moves array
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

    // Set starting FEN if provided
    if (fen) {
      try {
        const testChess = new Chess(fen);
        startingFen = fen;
        chess = testChess;
      } catch (err) {
        return res.status(400).json({
          error: 'Invalid FEN string',
          fen
        });
      }
    } else {
      startingFen = null;
      chess.reset();
    }

    // Apply moves
    moveHistory = [...moves];
    for (const move of moveHistory) {
      const from = move.substring(0, 2);
      const to = move.substring(2, 4);
      const promotion = move.length > 4 ? move[4] : undefined;
      try {
        chess.move({ from, to, promotion });
      } catch (err) {
        return res.status(400).json({
          error: `Invalid move in sequence: ${move}`,
          moveHistory: moves
        });
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📍 Position set manually');
    if (startingFen) {
      console.log(`   Starting FEN: ${startingFen}`);
    } else {
      console.log('   Starting from regular starting position');
    }
    console.log(`   Moves: ${moveHistory.join(' ') || 'none'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    res.json({
      success: true,
      message: 'Position set',
      startingFen: startingFen || 'startpos',
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

    // Check if we're in a puzzle
    const puzzleInfo = await page.evaluate(() => {
      const isPuzzle = window.location.href.includes('/puzzles') ||
                       window.location.href.includes('/puzzle/') ||
                       document.querySelector('.puzzle-layout, [class*="puzzle"]') !== null;

      if (!isPuzzle) return { isPuzzle: false };

      // In puzzles, detect which side is to move (the side the user plays)
      // Check the board state to determine whose turn it is
      const board = document.querySelector('.board');
      if (!board) return { isPuzzle, sideToMove: null };

      // Look for puzzle indicators - try multiple selectors
      const puzzleSelectors = [
        '.puzzle-header',
        '[class*="puzzle"][class*="header"]',
        '.puzzle-title',
        '[class*="puzzle"][class*="title"]',
        '[class*="puzzle"] h1',
        '[class*="puzzle"] h2',
        '[class*="puzzle-info"]',
        '.daily-puzzle-header'
      ];

      let headerText = '';
      for (const selector of puzzleSelectors) {
        const element = document.querySelector(selector);
        if (element?.textContent) {
          headerText = element.textContent.toLowerCase();
          if (headerText.includes('to play') || headerText.includes('to move')) {
            break; // Found relevant text
          }
        }
      }

      // Also check meta description or puzzle data
      if (!headerText) {
        const metaDescription = document.querySelector('meta[name="description"]');
        if (metaDescription?.content) {
          headerText = metaDescription.content.toLowerCase();
        }
      }

      // Detect color from header text - multiple patterns
      const blackPatterns = ['black to', 'black to play', 'black to move', 'black plays', 'black wins'];
      const whitePatterns = ['white to', 'white to play', 'white to move', 'white plays', 'white wins'];

      for (const pattern of blackPatterns) {
        if (headerText.includes(pattern)) {
          return { isPuzzle: true, sideToMove: 'black' };
        }
      }

      for (const pattern of whitePatterns) {
        if (headerText.includes(pattern)) {
          return { isPuzzle: true, sideToMove: 'white' };
        }
      }

      // Fallback: use DOM indicators or assume it's the side to move
      return { isPuzzle: true, sideToMove: null };
    });

    // Auto-sync position before starting
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔄 Auto-syncing position before enabling autoplay...');

    // In puzzles, wait briefly for any automated setup moves to complete
    if (puzzleInfo.isPuzzle) {
      console.log('   🧩 Puzzle detected - waiting for position to stabilize...');
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const syncResult = await syncPositionInternal();

    if (syncResult.synced) {
      if (syncResult.extractedMoves) {
        console.log(`   ✓ Extracted ${syncResult.moveCount} moves from chess.com`);
      } else if (syncResult.detectedMove) {
        console.log(`   ✓ Detected opponent move: ${syncResult.detectedMove}`);
      } else {
        console.log('   ✓ Position already in sync');
      }
      console.log(`   → Current position: ${moveHistory.length} moves played`);
      console.log(`   → Move history: ${moveHistory.join(' ') || 'none (starting position)'}`);
    } else if (syncResult.needsManualSync) {
      console.log('   ⚠ Could not auto-sync position');
      console.log('   → Please use "sync" or "position" command to set the position first');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      return res.status(400).json({
        success: false,
        error: 'Could not sync position',
        suggestion: syncResult.suggestion,
        needsManualSync: true
      });
    }

    // Set color based on puzzle or user input
    if (puzzleInfo.isPuzzle) {
      // In puzzles, auto-detect the playing color (side to move)
      let sideToMove = puzzleInfo.sideToMove;

      // If header detection failed, use FEN's turn indicator as fallback
      if (!sideToMove && syncResult.currentFen) {
        // FEN format: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        //                                                          ^
        //                                                      turn indicator
        const fenParts = syncResult.currentFen.split(' ');
        const turnIndicator = fenParts[1]; // 'w' or 'b'
        sideToMove = turnIndicator === 'w' ? 'white' : 'black';
        console.log(`   → FEN turn indicator: ${turnIndicator} (${sideToMove})`);
      }

      // Final fallback (should rarely be needed)
      if (!sideToMove) {
        sideToMove = moveHistory.length % 2 === 0 ? 'white' : 'black';
        console.log(`   → Using move count fallback: ${sideToMove}`);
      }

      autoplayColor = sideToMove;
      console.log(`   🧩 Puzzle detected! Auto-detected playing as: ${autoplayColor}`);
    } else {
      // In regular games, use specified color (default to white)
      autoplayColor = color || 'white';
    }

    // Start autoplay
    await startAutoplay();

    res.json({
      success: true,
      message: 'Autoplay enabled',
      color: autoplayColor,
      isPuzzle: puzzleInfo.isPuzzle,
      moveCount: moveHistory.length,
      moveHistory: moveHistory.length > 0 ? moveHistory : undefined,
      synced: syncResult.synced,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disable autoplay
app.post('/autoplay/disable', async (req, res) => {
  try {
    await stopAutoplay();

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
      if (result.extractedMoves) {
        console.log(`   ✓ Extracted ${result.moveCount} moves from chess.com`);
        console.log(`   → Move history: ${moveHistory.join(' ')}`);
      } else if (result.positionsMatch) {
        console.log('   ✓ Positions match - no opponent move detected');
      } else if (result.detectedMove) {
        console.log(`   ✓ Detected opponent move: ${result.detectedMove}`);
        console.log(`   ✓ Move history updated (${moveHistory.length} moves)`);
      } else if (result.reSynced) {
        console.log(`   ✓ Re-synced with ${result.moveCount} moves`);
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      res.json({
        success: true,
        synced: true,
        positionsMatch: result.positionsMatch,
        detectedMove: result.detectedMove,
        extractedMoves: result.extractedMoves,
        reSynced: result.reSynced,
        moveHistory,
        moveCount: moveHistory.length
      });
    } else {
      console.log('   ✗ Could not sync position');
      if (result.suggestion) {
        console.log(`   → ${result.suggestion}`);
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      res.json({
        success: false,
        synced: false,
        error: result.error,
        currentFen: result.currentFen,
        expectedFen: result.expectedFen,
        needsManualSync: result.needsManualSync,
        suggestion: result.suggestion
      });
    }
  } catch (error) {
    console.error('❌ Error syncing position:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to extract moves from chess.com
app.get('/extract-moves', async (req, res) => {
  try {
    if (!connected) {
      return res.status(400).json({ error: 'Not connected to browser' });
    }

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 Extracting move history from chess.com...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const moves = await extractMoveHistoryFromChessCom();

    if (moves && moves.length > 0) {
      console.log(`✓ Extracted ${moves.length} moves`);
      console.log(`→ Moves: ${moves.join(' ')}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      res.json({
        success: true,
        moves,
        moveCount: moves.length,
        movesString: moves.join(' ')
      });
    } else {
      console.log('⚠ Could not extract moves');
      console.log('→ This means chess.com doesn\'t expose move data in a readable format');
      console.log('→ You can manually set the position using the "position" command');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      res.json({
        success: false,
        moves: null,
        message: 'Could not extract move history from chess.com',
        suggestion: 'Use the "position" command to manually set the move history. Example: position e2e4 e7e5 g1f3'
      });
    }
  } catch (error) {
    console.error('❌ Error extracting moves:', error);
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
    console.log(`   Mode: ${engineConfig.mode}`);
    if (engineConfig.mode === 'nodes') {
      console.log(`   Node limit: ${engineConfig.nodes}`);
      console.log(`   Threads: 1 (fixed for nodes mode)`);
    } else {
      console.log(`   Time control: ${engineConfig.timeControl.base}ms + ${engineConfig.timeControl.increment}ms`);
      console.log(`   Threads: ${engineConfig.timeControl.threads}`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Create and start engine with appropriate thread count
    const threads = engineConfig.mode === 'nodes' ? 1 : engineConfig.timeControl.threads;
    engine = new UCIEngine(enginePath, { threads });

    await engine.start();
    engineEnabled = true;
    engineConfig.selectedEngine = selectedEngineName;

    console.log('✓ Engine enabled and ready');
    console.log(`ℹ Engine debug log: ${engine.debugLogPath}`);
    console.log('  (Open in a second terminal with: Get-Content engine-debug.log -Wait -Tail 50)');

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
    console.log(`   Node limit: ${engineConfig.nodes}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Start new engine
    engine = new UCIEngine(newEngine.path);

    await engine.start();
    engineEnabled = true;
    engineConfig.selectedEngine = newEngineName;

    console.log('✓ Engine switch completed');
    console.log(`ℹ Engine debug log: ${engine.debugLogPath}`);

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
    const { mode, nodes, threads, timeControl } = req.body;

    // Update mode if provided
    if (mode !== undefined) {
      if (mode !== 'nodes' && mode !== 'time') {
        return res.status(400).json({
          success: false,
          error: 'Mode must be "nodes" or "time"'
        });
      }
      engineConfig.mode = mode;
      console.log(`✓ Mode updated: ${engineConfig.mode}`);

      // Update threads based on mode
      if (engineEnabled && engine) {
        const newThreads = mode === 'nodes' ? 1 : engineConfig.timeControl.threads;
        await engine.setThreads(newThreads);
      }
    }

    // Update nodes if provided (for nodes mode)
    if (nodes !== undefined) {
      engineConfig.nodes = parseInt(nodes);
      console.log(`✓ Node limit updated: ${engineConfig.nodes}`);
    }

    // Update time control settings if provided
    if (timeControl !== undefined) {
      if (timeControl.base !== undefined) {
        engineConfig.timeControl.base = parseInt(timeControl.base);
        timeTracking.whiteTime = engineConfig.timeControl.base;
        timeTracking.blackTime = engineConfig.timeControl.base;
        console.log(`✓ Time control base updated: ${engineConfig.timeControl.base}ms`);
      }
      if (timeControl.increment !== undefined) {
        engineConfig.timeControl.increment = parseInt(timeControl.increment);
        timeTracking.increment = engineConfig.timeControl.increment;
        console.log(`✓ Time control increment updated: ${engineConfig.timeControl.increment}ms`);
      }
      if (timeControl.threads !== undefined) {
        engineConfig.timeControl.threads = parseInt(timeControl.threads);
        console.log(`✓ Time control threads updated: ${engineConfig.timeControl.threads}`);

        // If in time mode and engine is running, update threads
        if (engineConfig.mode === 'time' && engineEnabled && engine) {
          await engine.setThreads(engineConfig.timeControl.threads);
        }
      }
    }

    res.json({
      success: true,
      message: 'Engine configuration updated',
      config: {
        mode: engineConfig.mode,
        nodes: engineConfig.nodes,
        threads: engineConfig.mode === 'nodes' ? 1 : engineConfig.timeControl.threads,
        timeControl: engineConfig.timeControl,
        selectedEngine: engineConfig.selectedEngine
      },
      engineEnabled: engineEnabled
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
      mode: engineConfig.mode,
      nodes: engineConfig.nodes,
      threads: engineConfig.mode === 'nodes' ? 1 : engineConfig.timeControl.threads,
      timeControl: engineConfig.timeControl
    },
    timeTracking: engineConfig.mode === 'time' ? {
      whiteTime: timeTracking.whiteTime,
      blackTime: timeTracking.blackTime,
      increment: timeTracking.increment
    } : undefined,
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

    // Sync position with chess.com board first
    console.log('   Syncing position with board...');
    let syncResult = await syncPositionInternal();

    // If sync fails, try resetting and syncing again
    if (!syncResult.synced) {
      console.warn('   ⚠ Initial sync failed, attempting reset and retry...');

      // Reset position
      moveHistory = [];
      startingFen = null;
      chess.reset();
      console.log('   → Position reset');

      // Try syncing again
      console.log('   → Retrying sync...');
      syncResult = await syncPositionInternal();

      if (!syncResult.synced) {
        return res.status(400).json({
          error: 'Failed to sync position with board after reset',
          details: syncResult.error || syncResult.message,
          attempted: 'reset and retry'
        });
      }
      console.log('   ✓ Position synced after reset');
    } else {
      console.log('   ✓ Position synced');
    }

    // Get current board state
    const fen = await getBoardState();
    if (!fen) {
      return res.status(400).json({
        error: 'Could not read board state'
      });
    }

    console.log(`   Position: ${fen}`);
    console.log(`   Move history (${moveHistory.length} moves):`, moveHistory.join(' '));
    if (startingFen) {
      console.log(`   Starting FEN: ${startingFen}`);
    }

    // Set position for engine using move history
    if (startingFen) {
      // If we have no moves yet, use the current FEN directly (with correct turn indicator)
      // Otherwise use the starting FEN + move history
      if (moveHistory.length === 0) {
        console.log(`   → Using current FEN (no moves played yet): ${fen}`);
        engine.setPosition(fen, []);
      } else {
        console.log(`   → Using starting FEN + ${moveHistory.length} moves`);
        engine.setPosition(startingFen, moveHistory);
      }
    } else {
      engine.setPosition('startpos', moveHistory);
    }

    // Get best move based on mode
    let result;
    if (engineConfig.mode === 'nodes') {
      console.log(`   Searching with ${engineConfig.nodes} nodes (1 thread)...`);
      result = await engine.goNodes(engineConfig.nodes);
    } else {
      // Time control mode
      console.log(`   Searching with time control: ${timeTracking.whiteTime}ms + ${timeTracking.increment}ms (${engineConfig.timeControl.threads} threads)...`);
      result = await engine.go(
        timeTracking.whiteTime,
        timeTracking.blackTime,
        timeTracking.increment,
        timeTracking.increment
      );

      if (result.timeUsed) {
        console.log(`   ⏱️  Time used: ${result.timeUsed}ms`);
      }
    }

    console.log(`✓ Engine suggests: ${result.move}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const responseData = {
      success: true,
      move: result.move,
      ponder: result.ponder,
      fen,
      moveHistory,
      mode: engineConfig.mode,
      timestamp: new Date().toISOString()
    };

    if (engineConfig.mode === 'nodes') {
      responseData.nodes = engineConfig.nodes;
    } else {
      responseData.timeUsed = result.timeUsed;
      responseData.timeControl = {
        whiteTime: timeTracking.whiteTime,
        blackTime: timeTracking.blackTime,
        increment: timeTracking.increment
      };
    }

    res.json(responseData);
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
      console.log('         Body: { "nodes": 1000000 }');
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
      await stopAutoplay();
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
