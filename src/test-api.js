#!/usr/bin/env node

import readline from 'readline';

/**
 * Simple test script to manually send moves to the API
 */

const API_URL = 'http://localhost:3000';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function apiRequest(method, endpoint, body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_URL}${endpoint}`, options);
  return await response.json();
}

async function checkStatus() {
  try {
    const status = await apiRequest('GET', '/status');
    console.log('\n📊 Status:', status);
    return status.gameActive;
  } catch (error) {
    console.log('❌ Error:', error.message);
    console.log('\nIs the API server running? Start it with: npm start');
    return false;
  }
}

async function getBoard() {
  try {
    const board = await apiRequest('GET', '/board');
    console.log('\n♟️  Board State:');
    console.log('   FEN:', board.fen);
    console.log('   Game Active:', board.gameActive);
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function makeMove(move) {
  try {
    console.log(`\n➤ Sending move: ${move}`);
    const result = await apiRequest('POST', '/move', { move });

    if (result.success) {
      console.log('✓ Move executed successfully');
    } else {
      console.log('❌ Move failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Chess.com API - Manual Test Client');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // Check if server is running
  const gameActive = await checkStatus();

  if (!gameActive) {
    console.log('\n⚠️  Make sure:');
    console.log('  1. API server is running (npm start)');
    console.log('  2. Edge is open with debugging enabled (port 9223)');
    console.log('  3. You have a chess.com game open');
    console.log('\nPress Ctrl+C to exit');
    process.exit(1);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Commands:');
  console.log('  <move>  - Send UCI move (e.g., e2e4, g1f3)');
  console.log('  board   - Show current board state');
  console.log('  status  - Check connection status');
  console.log('  quit    - Exit');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // Interactive loop
  const prompt = () => {
    rl.question('Command: ', async (input) => {
      const cmd = input.trim().toLowerCase();

      if (cmd === 'quit' || cmd === 'exit') {
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
      } else if (cmd === 'board') {
        await getBoard();
      } else if (cmd === 'status') {
        await checkStatus();
      } else if (cmd === '') {
        // Skip empty input
      } else {
        // Assume it's a move
        const uciPattern = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
        if (uciPattern.test(cmd)) {
          await makeMove(cmd);
        } else {
          console.log('❌ Invalid command or move format');
          console.log('   UCI format: e2e4, g1f3, e7e8q');
        }
      }

      prompt();
    });
  };

  prompt();
}

main();
