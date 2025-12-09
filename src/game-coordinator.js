import { ChessComClient } from './chesscom-client.js';
import { UCIEngine } from './uci-engine.js';
import { Chess } from 'chess.js';

/**
 * GameCoordinator orchestrates games between the UCI engine and chess.com
 */
export class GameCoordinator {
  constructor(enginePath, options = {}) {
    this.enginePath = enginePath;
    this.options = {
      headless: options.headless !== false,
      threads: options.threads || 8,
      moveTime: options.moveTime || 60000, // 60 seconds
      increment: options.increment || 1000, // 1 second
      ...options
    };

    this.client = null;
    this.engine = null;
    this.chess = null;
    this.ourColor = null;
    this.moveHistory = [];
    this.gameActive = false;
  }

  /**
   * Initialize the coordinator
   */
  async initialize() {
    console.log('=== Wilted Chess.com Client ===\n');

    // Create chess.com client
    this.client = new ChessComClient({ headless: this.options.headless });

    // Create engine
    this.engine = new UCIEngine(this.enginePath, {
      threads: this.options.threads,
      moveTime: this.options.moveTime,
      increment: this.options.increment
    });

    // Create chess.js instance for move validation
    this.chess = new Chess();

    console.log('Starting engine...');
    await this.engine.start();

    console.log('\nLaunching browser...');
    await this.client.launch();

    console.log('\n✓ System ready!');
  }

  /**
   * Play a single game
   */
  async playGame() {
    try {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📋 Instructions:');
      console.log('1. In the browser window, navigate to a bot');
      console.log('2. Start a game (select color and click Play)');
      console.log('3. The engine will take over from here!');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      console.log('Waiting for game to start...');

      // Wait for game to start and detect our color
      this.ourColor = await this.client.waitForGame();
      console.log(`\n♟️  Playing as: ${this.ourColor.toUpperCase()}\n`);

      // Reset game state
      this.chess.reset();
      this.moveHistory = [];
      this.gameActive = true;

      // Initialize engine for new game
      await this.engine.newGame();

      // Start game loop
      if (this.ourColor === 'white') {
        await this.makeEngineMove();
      } else {
        await this.waitForOpponentAndRespond();
      }

      // Main game loop
      while (this.gameActive) {
        await this.waitForOpponentAndRespond();
      }

      console.log('\n🏁 Game Over!');
      await this.printGameSummary();

    } catch (error) {
      console.error('\n❌ Error during game:', error);
      this.gameActive = false;
    }
  }

  /**
   * Wait for opponent move and respond with engine move
   */
  async waitForOpponentAndRespond() {
    // Check if game is over
    if (await this.client.isGameOver()) {
      this.gameActive = false;
      return;
    }

    console.log('⏳ Waiting for opponent...');

    try {
      // Wait for opponent's move
      await this.client.waitForOpponentMove(120000);

      // Detect the move that was made
      const opponentMove = await this.detectLastMove();

      if (!opponentMove) {
        console.log('⚠️  Could not detect opponent move, game may be over');
        this.gameActive = false;
        return;
      }

      console.log(`Opponent played: ${opponentMove}`);

      // Update our game state
      this.chess.move(opponentMove);
      this.moveHistory.push(opponentMove);

      // Check if game is over
      if (this.chess.isGameOver()) {
        this.gameActive = false;
        return;
      }

      // Make our move
      await this.makeEngineMove();

    } catch (error) {
      console.log('⚠️  Timeout or error waiting for opponent');
      this.gameActive = false;
    }
  }

  /**
   * Get move from engine and execute it
   */
  async makeEngineMove() {
    console.log('\n🤔 Engine thinking...');

    // Set position for engine
    this.engine.setPosition('startpos', this.moveHistory);

    // Calculate time control
    const timeControl = this.calculateTimeControl();

    // Get best move from engine
    let result;
    if (timeControl) {
      result = await this.engine.go(
        timeControl.wtime,
        timeControl.btime,
        timeControl.winc,
        timeControl.binc
      );
    } else {
      result = await this.engine.goMovetime(this.options.moveTime);
    }

    const engineMove = result.move;

    if (!engineMove || engineMove === '(none)') {
      console.log('⚠️  Engine returned no move, game may be over');
      this.gameActive = false;
      return;
    }

    console.log(`\n➤ Playing: ${engineMove}`);

    // Validate move
    const move = this.chess.move(engineMove, { sloppy: true });
    if (!move) {
      console.error(`❌ Invalid move from engine: ${engineMove}`);
      this.gameActive = false;
      return;
    }

    // Execute move on chess.com
    const success = await this.client.makeMove(engineMove);

    if (!success) {
      console.error('❌ Failed to execute move on chess.com');
      this.gameActive = false;
      return;
    }

    this.moveHistory.push(engineMove);
    console.log(`✓ Move executed (${this.moveHistory.length}. ${engineMove})\n`);

    // Check if we checkmated
    if (this.chess.isGameOver()) {
      this.gameActive = false;
    }
  }

  /**
   * Detect the last move that was made on the board
   * This is a simplified version - in production you'd compare board states
   */
  async detectLastMove() {
    // Get current FEN from chess.com
    const currentFEN = await this.client.getBoardState();

    // Parse the position part of FEN (before the space)
    const fenPosition = currentFEN.split(' ')[0];

    // Try to find legal move that results in this position
    const legalMoves = this.chess.moves({ verbose: true });

    for (const move of legalMoves) {
      const testChess = new Chess(this.chess.fen());
      testChess.move(move);

      const testFenPosition = testChess.fen().split(' ')[0];

      if (testFenPosition === fenPosition) {
        return move.from + move.to + (move.promotion || '');
      }
    }

    // If we can't detect it, return null
    return null;
  }

  /**
   * Calculate time control for engine
   */
  calculateTimeControl() {
    // For now, use fixed time control
    // In a real implementation, you'd track actual time remaining
    const baseTime = this.options.moveTime * 10; // Give engine a "time bank"

    return {
      wtime: baseTime,
      btime: baseTime,
      winc: this.options.increment,
      binc: this.options.increment
    };
  }

  /**
   * Print game summary
   */
  async printGameSummary() {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('GAME SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (this.chess.isCheckmate()) {
      const winner = this.chess.turn() === 'w' ? 'Black' : 'White';
      console.log(`Result: ${winner} wins by checkmate!`);
    } else if (this.chess.isDraw()) {
      console.log('Result: Draw');
      if (this.chess.isStalemate()) console.log('Reason: Stalemate');
      if (this.chess.isThreefoldRepetition()) console.log('Reason: Threefold repetition');
      if (this.chess.isInsufficientMaterial()) console.log('Reason: Insufficient material');
    }

    console.log(`\nTotal moves: ${this.moveHistory.length}`);
    console.log(`\nMove history: ${this.moveHistory.join(' ')}`);

    // Generate PGN
    console.log('\nPGN:');
    console.log(this.chess.pgn());

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }

  /**
   * Shutdown the coordinator
   */
  async shutdown() {
    console.log('\nShutting down...');

    if (this.engine) {
      await this.engine.quit();
    }

    if (this.client) {
      await this.client.close();
    }

    console.log('Goodbye!');
  }

  /**
   * Run multiple games in sequence
   */
  async playMultipleGames(count = 1) {
    await this.initialize();

    for (let i = 1; i <= count; i++) {
      console.log(`\n\n${'='.repeat(50)}`);
      console.log(`GAME ${i} of ${count}`);
      console.log('='.repeat(50));

      await this.playGame();

      if (i < count) {
        console.log('\nPreparing for next game...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    await this.shutdown();
  }
}
