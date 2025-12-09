#!/usr/bin/env node

import { GameCoordinator } from './game-coordinator.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Main entry point for Wilted Chess.com Client
 */

async function main() {
  // Load configuration
  const configPath = resolve(__dirname, '../config.json');

  if (!existsSync(configPath)) {
    console.error('❌ Configuration file not found!');
    console.error('\nPlease create config.json with the following format:');
    console.error(JSON.stringify({
      enginePath: '/path/to/your/engine/binary',
      threads: 8,
      moveTime: 60000,
      increment: 1000,
      headless: false,
      gamesCount: 1
    }, null, 2));
    console.error('\nExample:');
    console.error(JSON.stringify({
      enginePath: '/home/user/Wilted-Chess-Engine/bin/wilted',
      threads: 8,
      moveTime: 60000,
      increment: 1000,
      headless: false,
      gamesCount: 1
    }, null, 2));
    process.exit(1);
  }

  let config;
  try {
    const configData = readFileSync(configPath, 'utf8');
    config = JSON.parse(configData);
  } catch (error) {
    console.error('❌ Error reading configuration file:', error.message);
    process.exit(1);
  }

  // Validate configuration
  if (!config.enginePath) {
    console.error('❌ enginePath not specified in config.json');
    process.exit(1);
  }

  if (!existsSync(config.enginePath)) {
    console.error(`❌ Engine not found at: ${config.enginePath}`);
    console.error('\nPlease build your engine first or update the path in config.json');
    process.exit(1);
  }

  // Parse command line arguments
  const args = process.argv.slice(2);
  const gamesCount = args[0] ? parseInt(args[0]) : (config.gamesCount || 1);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('     WILTED CHESS.COM CLIENT');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Engine: ${config.enginePath}`);
  console.log(`Threads: ${config.threads || 8}`);
  console.log(`Time per move: ${(config.moveTime || 60000) / 1000}s`);
  console.log(`Increment: ${(config.increment || 1000) / 1000}s`);
  console.log(`Games to play: ${gamesCount}`);
  console.log(`Headless mode: ${config.headless ? 'Yes' : 'No'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Create coordinator
  const coordinator = new GameCoordinator(config.enginePath, {
    threads: config.threads || 8,
    moveTime: config.moveTime || 60000,
    increment: config.increment || 1000,
    headless: config.headless !== false
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', async () => {
    console.log('\n\n⚠️  Interrupted by user');
    await coordinator.shutdown();
    process.exit(0);
  });

  // Handle uncaught errors
  process.on('uncaughtException', async (error) => {
    console.error('\n❌ Uncaught error:', error);
    await coordinator.shutdown();
    process.exit(1);
  });

  process.on('unhandledRejection', async (error) => {
    console.error('\n❌ Unhandled rejection:', error);
    await coordinator.shutdown();
    process.exit(1);
  });

  // Run games
  try {
    await coordinator.playMultipleGames(gamesCount);
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    await coordinator.shutdown();
    process.exit(1);
  }
}

// Run
main().catch(async (error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
