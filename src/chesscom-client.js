import puppeteer from 'puppeteer';

/**
 * ChessComClient handles browser automation for chess.com
 */
export class ChessComClient {
  constructor(options = {}) {
    this.browser = null;
    this.page = null;
    this.headless = options.headless !== false; // Default to headless
    this.currentFEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  }

  /**
   * Launch browser and navigate to chess.com
   */
  async launch() {
    console.log('Launching browser...');
    this.browser = await puppeteer.launch({
      headless: this.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security'
      ]
    });

    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 800 });

    console.log('Navigating to chess.com...');
    await this.page.goto('https://www.chess.com/play/computer', {
      waitUntil: 'networkidle2'
    });

    console.log('Ready to play!');
  }

  /**
   * Wait for game to start and detect if we're playing white or black
   */
  async waitForGame() {
    console.log('Waiting for game to start...');

    // Wait for the board to be present
    await this.page.waitForSelector('.board', { timeout: 60000 });

    // Wait a bit for the game to fully initialize
    await this.page.waitForTimeout(2000);

    // Detect our color by checking board orientation
    const isFlipped = await this.page.evaluate(() => {
      const board = document.querySelector('.board');
      return board?.classList.contains('flipped') || false;
    });

    const ourColor = isFlipped ? 'black' : 'white';
    console.log(`We are playing as: ${ourColor}`);

    return ourColor;
  }

  /**
   * Get current board state as FEN
   */
  async getBoardState() {
    try {
      // Extract board state from the DOM
      const fen = await this.page.evaluate(() => {
        // Chess.com stores game data in window object
        const gameData = window.gameSetup || window.chessGame;
        if (gameData && gameData.fen) {
          return gameData.fen;
        }

        // Fallback: try to read from visible board
        const pieces = document.querySelectorAll('.piece');
        if (pieces.length === 0) return null;

        // Build FEN from piece positions
        const board = Array(8).fill(null).map(() => Array(8).fill(null));

        pieces.forEach(piece => {
          const square = piece.parentElement;
          const squareClass = square.className;
          const match = squareClass.match(/square-(\d)(\d)/);
          if (match) {
            const file = parseInt(match[1]) - 1;
            const rank = 8 - parseInt(match[2]);
            const pieceClass = piece.className;

            // Parse piece type and color
            let pieceChar = '';
            if (pieceClass.includes('wp')) pieceChar = 'P';
            else if (pieceClass.includes('wn')) pieceChar = 'N';
            else if (pieceClass.includes('wb')) pieceChar = 'B';
            else if (pieceClass.includes('wr')) pieceChar = 'R';
            else if (pieceClass.includes('wq')) pieceChar = 'Q';
            else if (pieceClass.includes('wk')) pieceChar = 'K';
            else if (pieceClass.includes('bp')) pieceChar = 'p';
            else if (pieceClass.includes('bn')) pieceChar = 'n';
            else if (pieceClass.includes('bb')) pieceChar = 'b';
            else if (pieceClass.includes('br')) pieceChar = 'r';
            else if (pieceClass.includes('bq')) pieceChar = 'q';
            else if (pieceClass.includes('bk')) pieceChar = 'k';

            if (pieceChar && rank >= 0 && rank < 8 && file >= 0 && file < 8) {
              board[rank][file] = pieceChar;
            }
          }
        });

        // Convert board to FEN
        let fen = '';
        for (let rank = 0; rank < 8; rank++) {
          let emptyCount = 0;
          for (let file = 0; file < 8; file++) {
            if (board[rank][file] === null) {
              emptyCount++;
            } else {
              if (emptyCount > 0) {
                fen += emptyCount;
                emptyCount = 0;
              }
              fen += board[rank][file];
            }
          }
          if (emptyCount > 0) fen += emptyCount;
          if (rank < 7) fen += '/';
        }

        return fen + ' w KQkq - 0 1'; // Simplified, doesn't track turn/castling
      });

      if (fen) {
        this.currentFEN = fen;
        return fen;
      }

      return this.currentFEN;
    } catch (error) {
      console.error('Error getting board state:', error);
      return this.currentFEN;
    }
  }

  /**
   * Make a move on the board (in UCI format, e.g., "e2e4")
   */
  async makeMove(uciMove) {
    console.log(`Making move: ${uciMove}`);

    try {
      const from = uciMove.substring(0, 2);
      const to = uciMove.substring(2, 4);
      const promotion = uciMove.length > 4 ? uciMove[4] : null;

      // Convert algebraic notation to board coordinates
      const fromFile = from.charCodeAt(0) - 97 + 1; // a=1, b=2, etc.
      const fromRank = parseInt(from[1]);
      const toFile = to.charCodeAt(0) - 97 + 1;
      const toRank = parseInt(to[1]);

      console.log(`Moving from ${from} (${fromFile},${fromRank}) to ${to} (${toFile},${toRank})`);

      // Check if board is flipped
      const isFlipped = await this.page.evaluate(() => {
        const board = document.querySelector('.board');
        return board?.classList.contains('flipped') || false;
      });

      // Make the move by clicking and dragging
      const moved = await this.page.evaluate(({ fromFile, fromRank, toFile, toRank, isFlipped, promotion }) => {
        // Find the source square
        const fromSquareClass = isFlipped
          ? `.square-${9 - fromFile}${9 - fromRank}`
          : `.square-${fromFile}${fromRank}`;
        const fromSquare = document.querySelector(fromSquareClass);

        // Find the destination square
        const toSquareClass = isFlipped
          ? `.square-${9 - toFile}${9 - toRank}`
          : `.square-${toFile}${toRank}`;
        const toSquare = document.querySelector(toSquareClass);

        if (!fromSquare || !toSquare) {
          console.error('Could not find squares:', fromSquareClass, toSquareClass);
          return false;
        }

        // Simulate drag and drop
        const piece = fromSquare.querySelector('.piece');
        if (!piece) {
          console.error('No piece found on source square');
          return false;
        }

        // Method 1: Try clicking from and to squares
        fromSquare.click();
        setTimeout(() => toSquare.click(), 50);

        return true;
      }, { fromFile, fromRank, toFile, toRank, isFlipped, promotion });

      if (!moved) {
        throw new Error('Failed to execute move in browser');
      }

      // Wait for the move to be processed
      await this.page.waitForTimeout(500);

      // Handle promotion if needed
      if (promotion) {
        await this.handlePromotion(promotion);
      }

      console.log('Move executed successfully');
      return true;

    } catch (error) {
      console.error('Error making move:', error);
      return false;
    }
  }

  /**
   * Handle pawn promotion
   */
  async handlePromotion(piece) {
    const pieceMap = {
      'q': 'queen',
      'r': 'rook',
      'b': 'bishop',
      'n': 'knight'
    };

    const pieceName = pieceMap[piece.toLowerCase()];
    if (!pieceName) return;

    // Wait for promotion dialog
    await this.page.waitForTimeout(500);

    // Click on the promotion piece
    await this.page.evaluate((pieceName) => {
      const promotionPiece = document.querySelector(`.promotion-piece.${pieceName}`);
      if (promotionPiece) promotionPiece.click();
    }, pieceName);
  }

  /**
   * Wait for opponent's move
   */
  async waitForOpponentMove(timeout = 60000) {
    console.log('Waiting for opponent move...');

    const startTime = Date.now();
    let lastFEN = await this.getBoardState();

    while (Date.now() - startTime < timeout) {
      await this.page.waitForTimeout(500);
      const currentFEN = await this.getBoardState();

      if (currentFEN !== lastFEN) {
        console.log('Opponent moved!');
        return currentFEN;
      }
    }

    throw new Error('Timeout waiting for opponent move');
  }

  /**
   * Check if game is over
   */
  async isGameOver() {
    return await this.page.evaluate(() => {
      // Check for game over modal or message
      const gameOverModal = document.querySelector('.game-over-modal');
      const gameOverText = document.querySelector('.game-over-text');
      return !!(gameOverModal || gameOverText);
    });
  }

  /**
   * Close browser
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log('Browser closed');
    }
  }
}
