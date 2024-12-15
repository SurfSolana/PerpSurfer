import { Command } from 'commander';
import dotenv from 'dotenv';
import logger from "./utils/logger.js";
import { validateConfig, DirectionalTradingManager } from './main.js';

dotenv.config();

const program = new Command();

program
  .name('test-position')
  .description('Test position opening using main bot logic')
  .requiredOption('-d, --direction <type>', 'trade direction (long/short)')
  .requiredOption('-t, --token <symbol>', 'trading token (SOL/BTC/ETH)')
  .parse(process.argv);

const options = program.opts();

async function executeTest() {
  try {
    // Use the same config validation
    const tradingSymbols = validateConfig();
    
    // Validate CLI inputs
    const direction = options.direction.toLowerCase();
    const token = options.token.toUpperCase();

    if (!['long', 'short'].includes(direction)) {
      throw new Error('Direction must be either "long" or "short"');
    }
    if (!tradingSymbols.includes(token)) {
      throw new Error(`Token must be one of: ${tradingSymbols.join(', ')}`);
    }

    // Create trading manager for testing
    logger.info(`Creating ${direction} trading manager for ${token}...`);
    const manager = new DirectionalTradingManager(direction, [token]);
    await manager.initialize();

    // Create dummy signal matching main bot's signal format
    const testSignal = {
      symbol: token,
      direction: direction === 'long' ? 1 : -1,
      signal: 1 // Signal to open position
    };

    // Process signal through manager
    logger.info('Sending test signal...');
    await manager.processSignal(testSignal);

    // Wait for position check
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify position
    const symbolManager = manager.symbolManagers.get(token);
    if (!symbolManager) throw new Error('Symbol manager not found');
    
    const position = await symbolManager.zetaWrapper.getPosition(symbolManager.marketIndex);
    
    if (position && position.size !== 0) {
      logger.info('Position opened successfully:', {
        token,
        direction,
        size: position.size,
        entryPrice: position.costOfTrades ? (position.costOfTrades / position.size).toFixed(4) : 'N/A'
      });
    } else {
      logger.warn('No position detected after signal');
    }

    // Cleanup
    manager.shutdown();
    process.exit(0);
  } catch (error) {
    logger.error('Test execution failed:', error);
    process.exit(1);
  }
}

executeTest();