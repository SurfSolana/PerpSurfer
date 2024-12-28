// manage-position.js

import { ZetaClientWrapper } from "./clients/zeta/manage-position-client.js";
import { Connection } from "@solana/web3.js";
import { constants, Network, Exchange, types, utils } from "@zetamarkets/sdk";
import { PriorityFeeMethod, PriorityFeeSubscriber, fetchSolanaPriorityFee } from "@drift-labs/sdk";
import dotenv from "dotenv";
import logger from "./utils/logger.js";

dotenv.config();

const MAX_RETRIES = 60;

// Helper function to generate a random delay between 1-3 seconds
function getRandomRetryDelay() {
  return Math.floor(Math.random() * (3000 - 1000 + 1)) + 1000;
}

async function retryOperation(operation, operationName) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
          logger.info(`${operationName} attempt ${attempt}/${MAX_RETRIES}`);
          const result = await operation();
          
          // Check for undefined txSig or other invalid results
          if (!result) {
              throw new Error("Transaction failed - no transaction signature returned");
          }
          
          logger.info(`${operationName} successful on attempt ${attempt}`);
          return result;
      } catch (error) {
          const isLastAttempt = attempt === MAX_RETRIES;
          
          // Enhanced error logging
          const errorDetails = {
              attempt,
              error: error.message || error.toString(),
              code: error.code,
              txError: error.txError,
          };
          
          logger.error(`${operationName} attempt ${attempt} failed:`, errorDetails);
          
          if (isLastAttempt) {
              logger.error(`${operationName} failed after ${MAX_RETRIES} attempts`);
              throw error;
          }
          
          const delay = getRandomRetryDelay();
          logger.info(`Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
      }
  }
}

async function validateAndInitialize(markets) {
    // Validate environment with single wallet configuration
    const requiredEnvVars = ["KEYPAIR_FILE_PATH", "RPC_TRADINGBOT"];

    const missingVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);

    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(", ")}`);
    }

    // Initialize connection and exchange
    const connection = new Connection(process.env.RPC_TRADINGBOT);

    const loadExchangeConfig = types.defaultLoadExchangeConfig(
        Network.MAINNET,
        connection,
        {
            skipPreflight: true,
            preflightCommitment: "confirmed",
            commitment: "confirmed",
        },
        25
    );

    await Exchange.load(loadExchangeConfig);
    console.log("Exchange loaded successfully");

    return connection;
}

async function openTestPosition(asset, direction) {
    logger.info(`Opening position: ${direction} ${asset}`);

    // Using single wallet for all operations
    const keypairPath = process.env.KEYPAIR_FILE_PATH;
    logger.info(`Using wallet: ${keypairPath}`);
  
    // Initialize Zeta client with single wallet
    const zetaWrapper = new ZetaClientWrapper();
    await zetaWrapper.initializeExchange([constants.Asset[asset]]);
    await zetaWrapper.initialize(keypairPath);

    try {
        // Wrap the position opening in the retry mechanism
        const tx_open = await retryOperation(
            async () => {
                const result = await zetaWrapper.openPosition(direction, constants.Asset[asset]);
                if (!result) {
                    throw new Error("Failed to open position - no transaction signature returned");
                }
                return result;
            },
            `open ${direction} position for ${asset}`
        );

        if (tx_open) {
            logger.info(`Successfully opened ${direction} position for ${asset}`);
            process.exit(0);
        } else {
            throw new Error("Failed to open position - no transaction signature returned");
        }
    } catch (error) {
        // Categorize and enhance the error
        const errorContext = {
            direction,
            asset,
            type: error.name,
            details: error.message,
            code: error.code,
        };

        logger.error(`Failed to open ${direction} position for ${asset}`, errorContext);
        process.exit(1);
    }
}

async function closeTestPosition(asset, direction) {
    logger.info(`Closing position: ${direction} ${asset}`);

    // Using single wallet for all operations
    const keypairPath = process.env.KEYPAIR_FILE_PATH;
    logger.info(`Using wallet: ${keypairPath}`);
  
    // Initialize Zeta client with single wallet
    const zetaWrapper = new ZetaClientWrapper();
    await zetaWrapper.initializeExchange([constants.Asset[asset]]);
    await zetaWrapper.initialize(keypairPath);


    
    try {
        // Wrap the position closing in the retry mechanism
        const tx_close = await retryOperation(
            async () => {
                const result = await zetaWrapper.closePosition(direction, constants.Asset[asset]);
                if (!result) {
                    throw new Error("Failed to close position - no transaction signature returned");
                }
                return result;
            },
            `close ${direction} position for ${asset}`
        );

        if (tx_close) {
            logger.info(`Successfully closed ${direction} position for ${asset}`);
            process.exit(0);
        } else {
            throw new Error("Failed to close position - no transaction signature returned");
        }
    } catch (error) {
        logger.error(`Failed to close ${direction} position for ${asset}`, error);
        process.exit(1);
    }
}

// Handle process termination gracefully
process.on("SIGINT", () => {
    logger.info("Shutting down...");
    process.exit(0);
});

process.on("unhandledRejection", (error) => {
    logger.error("Unhandled promise rejection:", error);
    process.exit(1);
});

// Export functions for potential module usage
export { openTestPosition, closeTestPosition };

// Command line interface handler
if (process.argv[2] && process.argv[3] && process.argv[4]) {
    const action = process.argv[2].toLowerCase(); // "open" or "close"
    const asset = process.argv[3].toUpperCase(); // e.g., "SOL"
    const direction = process.argv[4].toLowerCase(); // "long" or "short"

    // Validate command line inputs
    if (!["open", "close"].includes(action)) {
        logger.error("Action must be either 'open' or 'close'");
        process.exit(1);
    }

    if (!["long", "short"].includes(direction)) {
        logger.error("Direction must be either 'long' or 'short'");
        process.exit(1);
    }

    if (!constants.Asset[asset]) {
        logger.error("Invalid asset symbol");
        process.exit(1);
    }

    // Execute appropriate action based on command line arguments
    if (action === "open") {
        openTestPosition(asset, direction);
    } else {
        closeTestPosition(asset, direction);
    }
}