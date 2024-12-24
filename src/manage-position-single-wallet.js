// manage-position-single-wallet.js

import { ZetaClientWrapper } from "./clients/zeta.js";
import { Connection } from "@solana/web3.js";
import { constants, Network, Exchange, types, utils } from "@zetamarkets/sdk";
import { PriorityFeeMethod, PriorityFeeSubscriber, fetchSolanaPriorityFee } from "@drift-labs/sdk";
import dotenv from "dotenv";
import logger from "./utils/logger.js";

dotenv.config();

// Time to wait between operations for better transaction handling
const delay_ms = 500;

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

    console.log(`Sleep for ${delay_ms}ms...`)
    await utils.sleep(delay_ms);

    // Open the position with specified direction
    const tx_open = await zetaWrapper.openPosition(direction, constants.Asset[asset]);

    process.exit(0);
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

    console.log(`Sleep for ${delay_ms}ms...`)
    await utils.sleep(delay_ms);

    // Close the position
    const tx_close = await zetaWrapper.closePosition(direction, constants.Asset[asset]);

    process.exit(0);
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