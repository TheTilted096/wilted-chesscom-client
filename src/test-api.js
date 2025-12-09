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

async function listEngines() {
  try {
    const result = await apiRequest('GET', '/engine/list');
    console.log('\n🎮 Available Engines:');

    if (result.engines.length === 0) {
      console.log('   No engines found in engines/ folder');
      console.log('   Add engines with: cp /path/to/engine engines/');
    } else {
      result.engines.forEach((eng, idx) => {
        const status = eng.executable ? '✓' : '✗ (not executable)';
        const size = (eng.size / 1024 / 1024).toFixed(2) + ' MB';
        console.log(`   ${idx + 1}. ${eng.name} ${status} (${size})`);
      });
    }
    console.log(`   Total: ${result.count} engine(s)`);
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function enableEngine(engineName = null) {
  try {
    const body = engineName ? { engine: engineName } : {};
    console.log(engineName ? `\n🤖 Enabling engine: ${engineName}` : '\n🤖 Enabling engine (auto-select)...');
    const result = await apiRequest('POST', '/engine/enable', body);

    if (result.success) {
      console.log(`✓ Engine enabled: ${result.selectedEngine}`);
      console.log(`   Nodes: ${result.config.nodes}`);
      console.log(`   Threads: ${result.config.threads}`);
    } else {
      console.log('❌ Failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function disableEngine() {
  try {
    console.log('\n🤖 Disabling engine...');
    const result = await apiRequest('POST', '/engine/disable');

    if (result.success) {
      console.log('✓ Engine disabled');
      if (result.stoppedEngine) {
        console.log(`   Stopped: ${result.stoppedEngine}`);
      }
    } else {
      console.log('❌ Failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function switchEngine(engineName) {
  try {
    console.log(`\n🔄 Switching to engine: ${engineName}`);
    const result = await apiRequest('POST', '/engine/switch', { engine: engineName });

    if (result.success) {
      console.log('✓ Engine switched');
      console.log(`   From: ${result.previousEngine}`);
      console.log(`   To: ${result.currentEngine}`);
    } else {
      console.log('❌ Failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function configEngine(nodes, threads) {
  try {
    const body = {};
    if (nodes) body.nodes = parseInt(nodes);
    if (threads) body.threads = parseInt(threads);

    console.log('\n⚙️  Configuring engine...');
    const result = await apiRequest('POST', '/engine/config', body);

    if (result.success) {
      console.log('✓ Configuration updated');
      console.log(`   Nodes: ${result.config.nodes}`);
      console.log(`   Threads: ${result.config.threads}`);
      console.log(`   Engine: ${result.config.selectedEngine || 'none'}`);
    } else {
      console.log('❌ Failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function engineStatus() {
  try {
    const result = await apiRequest('GET', '/engine/status');
    console.log('\n🤖 Engine Status:');
    console.log(`   Enabled: ${result.engineEnabled ? 'Yes' : 'No'}`);
    console.log(`   Ready: ${result.engineReady ? 'Yes' : 'No'}`);
    console.log(`   Thinking: ${result.thinking ? 'Yes' : 'No'}`);
    console.log(`   Selected: ${result.selectedEngine || 'none'}`);
    console.log(`   Nodes: ${result.config.nodes}`);
    console.log(`   Threads: ${result.config.threads}`);

    if (result.availableEngines && result.availableEngines.length > 0) {
      console.log('\n   Available Engines:');
      result.availableEngines.forEach((eng, idx) => {
        const status = eng.executable ? '✓' : '✗';
        console.log(`     ${idx + 1}. ${eng.name} ${status}`);
      });
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function getSuggestion() {
  try {
    console.log('\n🤖 Getting engine suggestion...');
    const result = await apiRequest('GET', '/engine/suggest');

    if (result.success) {
      console.log(`✓ Best move: ${result.move}`);
      if (result.ponder) {
        console.log(`   Ponder: ${result.ponder}`);
      }
      console.log(`   Position: ${result.fen}`);
      console.log(`   Nodes searched: ${result.nodes}`);
    } else {
      console.log('❌ Failed:', result.error);
    }
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
  console.log('  BROWSER:');
  console.log('    <move>         - Send UCI move (e.g., e2e4, g1f3)');
  console.log('    board          - Show current board state');
  console.log('    status         - Check connection status');
  console.log('');
  console.log('  ENGINE:');
  console.log('    engines        - List available engines');
  console.log('    enable [name]  - Enable engine (auto-select if no name)');
  console.log('    disable        - Disable engine');
  console.log('    switch <name>  - Switch to different engine');
  console.log('    config <nodes> [threads] - Configure engine');
  console.log('    estatus        - Show engine status');
  console.log('    suggest        - Get engine move suggestion');
  console.log('');
  console.log('  GENERAL:');
  console.log('    help           - Show this help');
  console.log('    quit           - Exit');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // Show available engines on startup
  await listEngines();
  await engineStatus();

  // Interactive loop
  const prompt = () => {
    rl.question('Command: ', async (input) => {
      const cmd = input.trim();
      const parts = cmd.split(' ');
      const command = parts[0].toLowerCase();

      if (command === 'quit' || command === 'exit') {
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
      } else if (command === 'help') {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Commands:');
        console.log('  BROWSER:');
        console.log('    <move>         - Send UCI move (e.g., e2e4, g1f3)');
        console.log('    board          - Show current board state');
        console.log('    status         - Check connection status');
        console.log('');
        console.log('  ENGINE:');
        console.log('    engines        - List available engines');
        console.log('    enable [name]  - Enable engine (auto-select if no name)');
        console.log('    disable        - Disable engine');
        console.log('    switch <name>  - Switch to different engine');
        console.log('    config <nodes> [threads] - Configure engine');
        console.log('    estatus        - Show engine status');
        console.log('    suggest        - Get engine move suggestion');
        console.log('');
        console.log('  GENERAL:');
        console.log('    help           - Show this help');
        console.log('    quit           - Exit');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      } else if (command === 'board') {
        await getBoard();
      } else if (command === 'status') {
        await checkStatus();
      } else if (command === 'engines') {
        await listEngines();
      } else if (command === 'enable') {
        await enableEngine(parts[1]);
      } else if (command === 'disable') {
        await disableEngine();
      } else if (command === 'switch') {
        if (parts[1]) {
          await switchEngine(parts[1]);
        } else {
          console.log('❌ Usage: switch <engine-name>');
        }
      } else if (command === 'config') {
        if (parts[1]) {
          await configEngine(parts[1], parts[2]);
        } else {
          console.log('❌ Usage: config <nodes> [threads]');
        }
      } else if (command === 'estatus') {
        await engineStatus();
      } else if (command === 'suggest') {
        await getSuggestion();
      } else if (command === '') {
        // Skip empty input
      } else {
        // Assume it's a move
        const uciPattern = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
        if (uciPattern.test(command)) {
          await makeMove(command);
        } else {
          console.log('❌ Invalid command or move format');
          console.log('   Type "help" for available commands');
        }
      }

      prompt();
    });
  };

  prompt();
}

main();
