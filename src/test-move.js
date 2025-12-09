import { ChessComClient } from './chesscom-client.js';
import readline from 'readline';

/**
 * Test script to manually send moves to chess.com via terminal
 * Usage: npm run test
 * Then enter moves in UCI format (e.g., e2e4, g1f3, etc.)
 */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function main() {
  console.log('=== Wilted Chess.com Client - Manual Move Test ===\n');

  const client = new ChessComClient({ headless: false });

  try {
    // Launch browser and navigate to chess.com
    await client.launch();

    console.log('\n📋 Instructions:');
    console.log('1. In the browser window, start a game against a bot');
    console.log('2. Wait for the game to begin');
    console.log('3. Come back here and press Enter when ready\n');

    await waitForEnter();

    // Detect our color
    const ourColor = await client.waitForGame();
    console.log(`\n♟️  You are playing as: ${ourColor.toUpperCase()}\n`);

    // Get initial board state
    const initialFEN = await client.getBoardState();
    console.log(`Initial position: ${initialFEN}\n`);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Enter moves in UCI format (e.g., e2e4, g1f3)');
    console.log('Type "quit" to exit');
    console.log('Type "fen" to show current board state');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // If we're black, wait for white's first move
    if (ourColor === 'black') {
      console.log('⏳ Waiting for opponent to move...');
      await client.waitForOpponentMove();
      const fen = await client.getBoardState();
      console.log(`Opponent moved. Current position: ${fen}\n`);
    }

    // Start interactive move input
    await interactiveMoveLoop(client);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
    rl.close();
  }
}

function waitForEnter() {
  return new Promise((resolve) => {
    rl.question('Press Enter when game is ready...', () => {
      resolve();
    });
  });
}

async function interactiveMoveLoop(client) {
  while (true) {
    // Check if game is over
    if (await client.isGameOver()) {
      console.log('\n🏁 Game Over!');
      break;
    }

    // Get move from user
    const move = await new Promise((resolve) => {
      rl.question('Your move (UCI format): ', (answer) => {
        resolve(answer.trim().toLowerCase());
      });
    });

    // Handle special commands
    if (move === 'quit' || move === 'exit') {
      console.log('Exiting...');
      break;
    }

    if (move === 'fen') {
      const fen = await client.getBoardState();
      console.log(`Current FEN: ${fen}\n`);
      continue;
    }

    // Validate move format
    if (!isValidUCIMove(move)) {
      console.log('❌ Invalid move format. Use UCI notation (e.g., e2e4, g1f3)\n');
      continue;
    }

    // Make the move
    console.log(`\n➤ Making move: ${move}`);
    const success = await client.makeMove(move);

    if (!success) {
      console.log('❌ Failed to make move. Try again.\n');
      continue;
    }

    console.log('✓ Move executed\n');

    // Wait for opponent to respond
    console.log('⏳ Waiting for opponent...');
    try {
      await client.waitForOpponentMove(120000); // 2 minute timeout
      const fen = await client.getBoardState();
      console.log(`Opponent moved. Current position: ${fen}\n`);
    } catch (error) {
      console.log('⚠️  Timeout or game ended\n');
      break;
    }
  }
}

function isValidUCIMove(move) {
  // Basic UCI move validation: e2e4, e7e8q (with promotion)
  const uciPattern = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
  return uciPattern.test(move);
}

// Run the test
main().catch(console.error);
