import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

/**
 * UCIEngine handles communication with a UCI-compatible chess engine
 * Implements the Universal Chess Interface protocol
 */
export class UCIEngine extends EventEmitter {
  constructor(enginePath, options = {}) {
    super();
    this.enginePath = enginePath;
    this.process = null;
    this.ready = false;
    this.thinking = false;

    // Engine options
    this.options = {
      threads: options.threads || 8,
      moveTime: options.moveTime || 60000, // 60 seconds
      increment: options.increment || 1000, // 1 second
      ...options
    };

    // Buffer for incomplete lines
    this.outputBuffer = '';

    // Debug log file path (default to engine-debug.log in current directory)
    this.debugLogPath = options.debugLogPath || path.join(process.cwd(), 'engine-debug.log');

    // Clear debug log on startup
    if (fs.existsSync(this.debugLogPath)) {
      fs.unlinkSync(this.debugLogPath);
    }
    this.logDebug('='.repeat(80));
    this.logDebug(`ENGINE DEBUG LOG - ${new Date().toISOString()}`);
    this.logDebug(`Engine: ${enginePath}`);
    this.logDebug('='.repeat(80));
  }

  /**
   * Start the engine process
   */
  async start() {
    return new Promise((resolve, reject) => {
      console.log(`Starting engine: ${this.enginePath}`);

      this.process = spawn(this.enginePath, [], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (!this.process) {
        return reject(new Error('Failed to start engine process'));
      }

      // Handle stdout
      this.process.stdout.on('data', (data) => {
        this.handleOutput(data.toString());
      });

      // Handle stderr
      this.process.stderr.on('data', (data) => {
        console.error(`Engine stderr: ${data}`);
      });

      // Handle process exit
      this.process.on('exit', (code) => {
        console.log(`Engine process exited with code ${code}`);
        this.ready = false;
        this.emit('exit', code);
      });

      // Handle errors
      this.process.on('error', (error) => {
        console.error(`Engine error: ${error}`);
        reject(error);
      });

      // Initialize UCI communication
      this.initUCI().then(resolve).catch(reject);
    });
  }

  /**
   * Initialize UCI protocol
   */
  async initUCI() {
    console.log('Initializing UCI protocol...');

    // Send UCI command
    this.send('uci');

    // Wait for uciok
    await this.waitForResponse('uciok', 5000);
    console.log('✓ UCI protocol initialized');

    // Set options
    await this.setOptions();

    // Send isready
    this.send('isready');
    await this.waitForResponse('readyok', 5000);

    this.ready = true;
    console.log('✓ Engine is ready');
  }

  /**
   * Set engine options (threads, hash, etc.)
   */
  async setOptions() {
    console.log('Setting engine options...');

    // Set threads
    if (this.options.threads) {
      this.send(`setoption name Threads value ${this.options.threads}`);
      console.log(`  Threads: ${this.options.threads}`);
    }

    // Set hash size if specified
    if (this.options.hash) {
      this.send(`setoption name Hash value ${this.options.hash}`);
      console.log(`  Hash: ${this.options.hash} MB`);
    }

    // Wait a bit for options to be set
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Update thread count
   * @param {number} threads - Number of threads
   */
  async setThreads(threads) {
    this.options.threads = threads;
    this.send(`setoption name Threads value ${threads}`);
    console.log(`  Threads updated: ${threads}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Start a new game
   */
  newGame() {
    console.log('Starting new game...');
    this.send('ucinewgame');
    this.send('isready');
    return this.waitForResponse('readyok', 5000);
  }

  /**
   * Set position using FEN or move list
   * @param {string} fen - FEN string or 'startpos'
   * @param {string[]} moves - Array of moves in UCI format
   */
  setPosition(fen = 'startpos', moves = []) {
    let command;

    // Check if using standard starting position or custom FEN
    if (fen === 'startpos') {
      command = 'position startpos';
    } else {
      // For custom FEN, UCI protocol requires "position fen <fen>"
      command = `position fen ${fen}`;
    }

    if (moves && moves.length > 0) {
      command += ` moves ${moves.join(' ')}`;
    }

    this.send(command);
  }

  /**
   * Calculate best move with time control
   * @param {number} wtime - White's remaining time in ms
   * @param {number} btime - Black's remaining time in ms
   * @param {number} winc - White's increment in ms
   * @param {number} binc - Black's increment in ms
   * @returns {Promise<{move: string, ponder: string, timeUsed: number}>}
   */
  async go(wtime, btime, winc, binc) {
    return new Promise((resolve, reject) => {
      this.thinking = true;
      const startTime = Date.now();

      // Build go command
      let command = 'go';
      if (wtime !== undefined && btime !== undefined) {
        command += ` wtime ${wtime} btime ${btime}`;
        if (winc !== undefined && binc !== undefined) {
          command += ` winc ${winc} binc ${binc}`;
        }
      } else {
        // Use movetime if no time control specified
        command += ` movetime ${this.options.moveTime}`;
      }

      console.log(`Engine thinking: ${command}`);

      // Listen for bestmove
      const onBestMove = (line) => {
        if (line.startsWith('bestmove')) {
          this.thinking = false;
          const endTime = Date.now();
          const timeUsed = endTime - startTime;

          const parts = line.split(' ');
          const move = parts[1];
          const ponder = parts[3]; // May be undefined

          console.log(`✓ Engine suggests: ${move} (took ${timeUsed}ms)`);

          resolve({ move, ponder, timeUsed });
        }
      };

      // Set up listener
      this.once('bestmove', onBestMove);

      // Send go command
      this.send(command);

      // Set timeout
      const timeout = setTimeout(() => {
        this.removeListener('bestmove', onBestMove);
        this.thinking = false;
        reject(new Error('Timeout waiting for engine move'));
      }, this.options.moveTime + 10000); // Add 10s buffer

      // Clear timeout when we get response
      this.once('bestmove', () => clearTimeout(timeout));
    });
  }

  /**
   * Get best move with simple movetime
   * @param {number} moveTime - Time in milliseconds
   */
  async goMovetime(moveTime = this.options.moveTime) {
    return new Promise((resolve, reject) => {
      this.thinking = true;

      console.log(`Engine thinking (${moveTime}ms)...`);

      // Listen for bestmove
      const onBestMove = (line) => {
        if (line.startsWith('bestmove')) {
          this.thinking = false;

          const parts = line.split(' ');
          const move = parts[1];
          const ponder = parts[3];

          console.log(`✓ Engine suggests: ${move}`);

          resolve({ move, ponder });
        }
      };

      this.once('bestmove', onBestMove);
      this.send(`go movetime ${moveTime}`);

      // Set timeout
      const timeout = setTimeout(() => {
        this.removeListener('bestmove', onBestMove);
        this.thinking = false;
        reject(new Error('Timeout waiting for engine move'));
      }, moveTime + 10000);

      this.once('bestmove', () => clearTimeout(timeout));
    });
  }

  /**
   * Get best move with node limit
   * @param {number} nodes - Number of nodes to search
   * @returns {Promise<{move: string, ponder: string}>}
   */
  async goNodes(nodes) {
    return new Promise((resolve, reject) => {
      this.thinking = true;

      console.log(`Engine thinking (nodes: ${nodes})...`);

      // Listen for bestmove
      const onBestMove = (line) => {
        if (line.startsWith('bestmove')) {
          this.thinking = false;

          const parts = line.split(' ');
          const move = parts[1];
          const ponder = parts[3];

          console.log(`✓ Engine suggests: ${move}`);

          resolve({ move, ponder });
        }
      };

      this.once('bestmove', onBestMove);
      this.send(`go nodes ${nodes}`);

      // Set timeout (generous timeout for node-limited search)
      const timeout = setTimeout(() => {
        this.removeListener('bestmove', onBestMove);
        this.thinking = false;
        reject(new Error('Timeout waiting for engine move'));
      }, 300000); // 5 minutes max

      this.once('bestmove', () => clearTimeout(timeout));
    });
  }

  /**
   * Stop engine calculation
   */
  stop() {
    if (this.thinking) {
      this.send('stop');
      this.thinking = false;
    }
  }

  /**
   * Quit engine
   */
  async quit() {
    if (this.process) {
      this.send('quit');

      // Wait for process to exit
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            this.process.kill();
          }
          resolve();
        }, 2000);

        this.process.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
      this.ready = false;
      console.log('Engine stopped');
    }
  }

  /**
   * Send command to engine
   */
  send(command) {
    if (!this.process) {
      throw new Error('Engine not started');
    }

    // Log to debug file
    this.logDebug(`→ ${command}`);

    // Only show key commands in console
    if (!command.startsWith('setoption') && !command.startsWith('isready')) {
      console.log(`→ ${command}`);
    }

    this.process.stdin.write(command + '\n');
  }

  /**
   * Write to debug log file with timestamp
   */
  logDebug(message) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1); // HH:MM:SS.mmm
    const logLine = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(this.debugLogPath, logLine);
  }

  /**
   * Handle output from engine
   */
  handleOutput(data) {
    this.outputBuffer += data;
    const lines = this.outputBuffer.split('\n');

    // Keep the last incomplete line in buffer
    this.outputBuffer = lines.pop() || '';

    // Process complete lines
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        this.processLine(trimmed);
      }
    }
  }

  /**
   * Process a single line of output
   */
  processLine(line) {
    // Always log to debug file
    this.logDebug(`← ${line}`);

    // Filter console output to only show important lines
    const shouldShowInConsole =
      line.startsWith('bestmove') ||
      line === 'uciok' ||
      line === 'readyok' ||
      (line.startsWith('info') && (
        line.includes('depth') && line.includes('score') && line.includes('pv') ||
        line.includes('mate')
      ));

    if (shouldShowInConsole) {
      console.log(`← ${line}`);
    }

    // Emit specific events
    if (line.startsWith('bestmove')) {
      this.emit('bestmove', line);
    } else if (line.startsWith('info')) {
      this.emit('info', line);
      this.parseInfo(line);
    } else if (line === 'uciok') {
      this.emit('uciok');
    } else if (line === 'readyok') {
      this.emit('readyok');
    }

    // Emit general output event
    this.emit('output', line);
  }

  /**
   * Parse info line for useful information
   */
  parseInfo(line) {
    const info = {};

    // Extract depth
    const depthMatch = line.match(/depth (\d+)/);
    if (depthMatch) info.depth = parseInt(depthMatch[1]);

    // Extract score
    const scoreMatch = line.match(/score cp (-?\d+)/);
    if (scoreMatch) info.score = parseInt(scoreMatch[1]);

    const mateMatch = line.match(/score mate (-?\d+)/);
    if (mateMatch) info.mate = parseInt(mateMatch[1]);

    // Extract PV
    const pvMatch = line.match(/pv (.+)$/);
    if (pvMatch) info.pv = pvMatch[1].split(' ');

    // Extract time and nodes
    const timeMatch = line.match(/time (\d+)/);
    if (timeMatch) info.time = parseInt(timeMatch[1]);

    const nodesMatch = line.match(/nodes (\d+)/);
    if (nodesMatch) info.nodes = parseInt(nodesMatch[1]);

    if (Object.keys(info).length > 0) {
      this.emit('searchInfo', info);
    }
  }

  /**
   * Wait for specific response from engine
   */
  waitForResponse(response, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('output', handler);
        reject(new Error(`Timeout waiting for: ${response}`));
      }, timeout);

      const handler = (line) => {
        if (line.includes(response)) {
          clearTimeout(timer);
          this.removeListener('output', handler);
          resolve(line);
        }
      };

      this.on('output', handler);
    });
  }

  /**
   * Check if engine is ready
   */
  isReady() {
    return this.ready && this.process && !this.process.killed;
  }
}
