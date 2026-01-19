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

async function configEngine(args) {
  try {
    if (!args || args.length === 0) {
      console.log('❌ Usage:');
      console.log('   config mode <nodes|time>');
      console.log('   config nodes <number>');
      console.log('   config time <base> <increment> [threads]');
      console.log('   config uci <name> value <value>');
      return;
    }

    const subcommand = args[0];
    let body = {};

    if (subcommand === 'mode') {
      const mode = args[1];
      if (!mode || (mode !== 'nodes' && mode !== 'time')) {
        console.log('❌ Mode must be "nodes" or "time"');
        return;
      }
      body = { mode };
    } else if (subcommand === 'nodes') {
      const nodes = parseInt(args[1]);
      if (isNaN(nodes)) {
        console.log('❌ Invalid node count');
        return;
      }
      body = { nodes };
    } else if (subcommand === 'time') {
      const base = parseInt(args[1]);
      const increment = parseInt(args[2]);
      const threads = args[3] ? parseInt(args[3]) : undefined;

      if (isNaN(base) || isNaN(increment)) {
        console.log('❌ Invalid time control values');
        return;
      }

      body = { timeControl: { base, increment } };
      if (threads !== undefined && !isNaN(threads)) {
        body.timeControl.threads = threads;
      }
    } else if (subcommand === 'uci') {
      const optionName = args[1];
      const valueIndex = args.indexOf('value');

      if (!optionName || valueIndex === -1 || !args[valueIndex + 1]) {
        console.log('❌ Usage: config uci <name> value <value>');
        return;
      }

      // Combine all parts after 'value' in case value contains spaces
      const value = args.slice(valueIndex + 1).join(' ');
      body = { uciOption: { name: optionName, value } };
    } else {
      console.log('❌ Unknown subcommand. Use: mode, nodes, time, or uci');
      return;
    }

    console.log('\n⚙️  Configuring engine...');
    const result = await apiRequest('POST', '/engine/config', body);

    if (result.success) {
      console.log('✓ Configuration updated');
      console.log(`   Mode: ${result.config.mode}`);
      console.log(`   Threads: ${result.config.threads}`);
      if (result.config.mode === 'nodes') {
        console.log(`   Nodes: ${result.config.nodes}`);
      } else {
        console.log(`   Time control: ${result.config.timeControl.base}ms + ${result.config.timeControl.increment}ms`);
      }
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
    console.log(`\n   Configuration:`);
    console.log(`   Mode: ${result.config.mode}`);
    console.log(`   Threads: ${result.config.threads}`);

    if (result.config.mode === 'nodes') {
      console.log(`   Nodes: ${result.config.nodes}`);
    } else {
      console.log(`   Time control: ${result.config.timeControl.base}ms + ${result.config.timeControl.increment}ms`);
      if (result.timeTracking) {
        console.log(`\n   Time Tracking:`);
        console.log(`   White: ${result.timeTracking.whiteTime}ms`);
        console.log(`   Black: ${result.timeTracking.blackTime}ms`);
        console.log(`   Increment: ${result.timeTracking.increment}ms`);
      }
    }

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
      console.log(`✓ Engine suggests: ${result.move}`);
      if (result.ponder) {
        console.log(`   Ponder: ${result.ponder}`);
      }
      console.log(`   Position: ${result.fen}`);
      console.log(`   Moves played: ${result.moveHistory?.join(' ') || 'none'}`);
      console.log(`   Nodes searched: ${result.nodes}`);
    } else {
      console.log('❌ Failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
    if (error.message.includes('not enabled')) {
      console.log('\n💡 Tip: Enable the engine first with: enable');
    }
  }
}

async function playEngineMove() {
  try {
    console.log('\n🤖 Getting engine move and executing...');

    // First, get the engine suggestion
    const suggestResult = await apiRequest('GET', '/engine/suggest');

    if (!suggestResult.success) {
      console.log('❌ Failed to get engine suggestion:', suggestResult.error);
      return;
    }

    const move = suggestResult.move;
    console.log(`✓ Engine suggests: ${move}`);
    if (suggestResult.ponder) {
      console.log(`   Ponder: ${suggestResult.ponder}`);
    }

    // Now execute the move
    console.log(`\n➤ Executing move: ${move}`);
    const moveResult = await apiRequest('POST', '/move', { move });

    if (moveResult.success) {
      console.log('✓ Move executed successfully');
      console.log(`  Total moves: ${moveResult.moveHistory}`);
    } else {
      console.log('❌ Move execution failed:', moveResult.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
    if (error.message.includes('not enabled')) {
      console.log('\n💡 Tip: Enable the engine first with: enable');
    }
  }
}

async function makeMove(move) {
  try {
    console.log(`\n➤ Sending move: ${move}`);
    const result = await apiRequest('POST', '/move', { move });

    if (result.success) {
      console.log('✓ Move executed successfully');
      console.log(`  Total moves: ${result.moveHistory}`);
    } else {
      console.log('❌ Move failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function enableAutoplay(color) {
  try {
    if (color) {
      console.log(`\n🤖 Enabling autoplay as ${color}...`);
    } else {
      console.log(`\n🤖 Enabling autoplay with auto-detection...`);
    }

    const requestBody = color ? { color } : {};
    const result = await apiRequest('POST', '/autoplay/enable', requestBody);

    if (result.success) {
      console.log(`✓ Autoplay enabled!`);
      console.log(`  Playing as: ${result.color}`);
      if (result.isPuzzle) {
        console.log(`  🧩 Puzzle mode detected`);
      }
      if (!color) {
        console.log(`  🔍 Auto-detected color from position`);
      }
      console.log(`  The engine will automatically play when it's your turn`);
    } else {
      console.log('❌ Failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
    if (error.message.includes('not enabled')) {
      console.log('\n💡 Tip: Enable the engine first with: enable');
    }
  }
}

async function disableAutoplay() {
  try {
    console.log('\n⏹️  Disabling autoplay...');
    const result = await apiRequest('POST', '/autoplay/disable');

    if (result.success) {
      console.log('✓ Autoplay disabled');
    } else {
      console.log('❌ Failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function getAutoplayStatus() {
  try {
    console.log('\n📊 Autoplay Status:');
    const result = await apiRequest('GET', '/autoplay/status');

    console.log(`  Enabled: ${result.enabled ? '✓ Yes' : '✗ No'}`);
    if (result.enabled) {
      console.log(`  Playing as: ${result.color}`);
      console.log(`  Current turn: ${result.currentTurn}`);
      console.log(`  Our turn: ${result.ourTurn ? '✓ Yes' : '✗ No'}`);
      console.log(`  Busy: ${result.busy ? 'Yes (processing)' : 'No'}`);
      console.log(`  Game active: ${result.gameActive ? '✓ Yes' : '✗ No'}`);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function syncPosition() {
  try {
    console.log('\n🔄 Syncing position...');
    const result = await apiRequest('POST', '/sync');

    if (result.success) {
      if (result.positionsMatch) {
        console.log('✓ Position in sync');
      } else {
        console.log(`✓ Detected opponent move: ${result.detectedMove}`);
        console.log(`  Move history: ${result.moveHistory.join(' ')}`);
      }
      console.log(`  Total moves: ${result.moveCount}`);
    } else {
      console.log('⚠️  Position out of sync:', result.error);
      if (result.suggestion) {
        console.log(`\n💡 ${result.suggestion}`);
      }
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function resetPosition() {
  try {
    console.log('\n🔄 Resetting position...');
    const result = await apiRequest('POST', '/reset');

    if (result.success) {
      console.log('✓ Position reset');
      console.log(`  Cleared ${result.previousMoveCount} moves`);
      if (result.engineReset) {
        console.log('  ✓ Engine also reset');
      }
    } else {
      console.log('❌ Failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function setPosition(movesString) {
  try {
    const moves = movesString.split(/\s+/).filter(m => m.length > 0);
    console.log(`\n📍 Setting position with ${moves.length} moves...`);
    console.log(`   Moves: ${moves.join(' ')}`);

    const result = await apiRequest('POST', '/position', { moves });

    if (result.success) {
      console.log(`✓ Position set (${result.moveCount} moves)`);
    } else {
      console.log('❌ Set position failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function extractMoves() {
  try {
    console.log('\n🔍 Extracting move history from chess.com...');
    const result = await apiRequest('GET', '/extract-moves');

    if (result.success) {
      console.log(`✓ Extracted ${result.moveCount} moves`);
      console.log(`   Moves: ${result.movesString}`);
    } else {
      console.log('⚠️  Could not extract moves');
      console.log(`   ${result.message}`);
      if (result.suggestion) {
        console.log(`\n💡 ${result.suggestion}`);
      }
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
  console.log('    sync           - Detect opponent moves and sync position');
  console.log('    extract        - Extract move history from chess.com (debug)');
  console.log('    reset          - Reset move history (new game)');
  console.log('    position <moves> - Set position (e.g., position e2e4 e7e5)');
  console.log('');
  console.log('  ENGINE:');
  console.log('    engines        - List available engines');
  console.log('    enable [name]  - Enable engine (auto-select if no name)');
  console.log('    disable        - Disable engine');
  console.log('    switch <name>  - Switch to different engine');
  console.log('    config mode <nodes|time>        - Switch engine mode');
  console.log('    config nodes <number>           - Set node limit');
  console.log('    config time <base> <inc> [thr]  - Set time control');
  console.log('    config uci <name> value <value> - Set UCI option');
  console.log('    estatus        - Show engine status');
  console.log('    suggest        - Get engine move suggestion');
  console.log('    play           - Get engine move and execute it immediately');
  console.log('');
  console.log('  AUTOPLAY:');
  console.log('    auto white     - Enable autoplay as white');
  console.log('    auto black     - Enable autoplay as black');
  console.log('    auto off       - Disable autoplay');
  console.log('    auto status    - Show autoplay status');
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
        console.log('    sync           - Detect opponent moves and sync position');
        console.log('    extract        - Extract move history from chess.com (debug)');
        console.log('    reset          - Reset move history (new game)');
        console.log('    position <moves> - Set position (e.g., position e2e4 e7e5)');
        console.log('');
        console.log('  ENGINE:');
        console.log('    engines        - List available engines');
        console.log('    enable [name]  - Enable engine (auto-select if no name)');
        console.log('    disable        - Disable engine');
        console.log('    switch <name>  - Switch to different engine');
        console.log('    config mode <nodes|time>        - Switch engine mode');
        console.log('    config nodes <number>           - Set node limit');
        console.log('    config time <base> <inc> [thr]  - Set time control');
        console.log('    estatus        - Show engine status');
        console.log('    suggest        - Get engine move suggestion');
        console.log('    play           - Get engine move and execute it immediately');
        console.log('');
        console.log('  AUTOPLAY:');
        console.log('    auto           - Enable autoplay with auto-detection (recommended)');
        console.log('    auto white     - Force play as white');
        console.log('    auto black     - Force play as black');
        console.log('    auto off       - Disable autoplay');
        console.log('    auto status    - Show autoplay status');
        console.log('');
        console.log('  GENERAL:');
        console.log('    help           - Show this help');
        console.log('    quit           - Exit');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      } else if (command === 'board') {
        await getBoard();
      } else if (command === 'status') {
        await checkStatus();
      } else if (command === 'sync') {
        await syncPosition();
      } else if (command === 'extract') {
        await extractMoves();
      } else if (command === 'reset') {
        await resetPosition();
      } else if (command === 'position') {
        if (parts.length > 1) {
          const movesString = parts.slice(1).join(' ');
          await setPosition(movesString);
        } else {
          console.log('❌ Usage: position <moves> (e.g., position e2e4 e7e5)');
        }
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
        if (parts.length > 1) {
          await configEngine(parts.slice(1));
        } else {
          console.log('❌ Usage:');
          console.log('   config mode <nodes|time>');
          console.log('   config nodes <number>');
          console.log('   config time <base> <increment> [threads]');
        }
      } else if (command === 'estatus') {
        await engineStatus();
      } else if (command === 'suggest') {
        await getSuggestion();
      } else if (command === 'play') {
        await playEngineMove();
      } else if (command === 'auto') {
        const subcommand = parts[1];
        if (subcommand === 'white' || subcommand === 'w') {
          await enableAutoplay('white');
        } else if (subcommand === 'black' || subcommand === 'b') {
          await enableAutoplay('black');
        } else if (subcommand === 'off' || subcommand === 'stop' || subcommand === 'disable') {
          await disableAutoplay();
        } else if (subcommand === 'status') {
          await getAutoplayStatus();
        } else if (!subcommand) {
          // No color specified - auto-detect mode
          await enableAutoplay(null);
        } else {
          console.log('❌ Usage: auto [white|black|off|status]');
          console.log('   auto        - Auto-detect which side to play (recommended for puzzles)');
          console.log('   auto white  - Force play as white');
          console.log('   auto black  - Force play as black');
        }
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
