import { ZetaClientWrapper } from "./clients/zeta.js";
import { Connection } from "@solana/web3.js";
import { constants, Network, Exchange, types } from "@zetamarkets/sdk";
import { PriorityFeeMethod, PriorityFeeSubscriber, fetchSolanaPriorityFee } from "@drift-labs/sdk";
import dotenv from "dotenv";
import logger from "./utils/logger.js";

dotenv.config();

async function validateAndInitialize() {
    // Validate environment
    const requiredEnvVars = [
        "KEYPAIR_FILE_PATH_LONG",
        "KEYPAIR_FILE_PATH_SHORT",
        "RPC_TRADINGBOT"
    ];
    
    const missingVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
    
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
        25,
        true,
        connection
    );

    await Exchange.load(loadExchangeConfig);
    logger.info("Exchange loaded successfully");

    return connection;
}

async function setupPriorityFees(connection) {
    const config = {
        priorityFeeMethod: PriorityFeeMethod.SOLANA,
        frequencyMs: 5000,
        connection: connection,
        lookbackDistance: 150,
        addresses: []
    };

    const priorityFees = new PriorityFeeSubscriber(config);
    await priorityFees.subscribe();
    await priorityFees.load();

    const recentFees = await fetchSolanaPriorityFee(connection, 150, []);
    const initialFee = recentFees?.slice(0, 10).reduce((sum, fee) => sum + fee.prioritizationFee, 0) / 10 || 1_000;
    const currentPriorityFee = Math.floor(initialFee * 5);

    Exchange.setUseAutoPriorityFee(false);
    Exchange.updatePriorityFee(currentPriorityFee);

    return priorityFees;
}

async function openTestPosition(asset, direction) {
    try {
        logger.info(`Initializing test position: ${direction} ${asset}`);
        
        // Get correct keypair path based on direction
        const keypairPath = direction === "long" 
            ? process.env.KEYPAIR_FILE_PATH_LONG 
            : process.env.KEYPAIR_FILE_PATH_SHORT;

        logger.info(`Using keypair path: ${keypairPath}`);

        // Initialize connection and exchange
        const connection = await validateAndInitialize();
        const priorityFees = await setupPriorityFees(connection);

        // Initialize Zeta client
        const zetaWrapper = new ZetaClientWrapper();
        await zetaWrapper.initialize([constants.Asset[asset]], keypairPath);

        // Open position
        logger.info(`Opening ${direction} position for ${asset}`);
        const tx = await zetaWrapper.openPosition(direction, constants.Asset[asset]);

        logger.info("Position opened successfully:", {
            asset,
            direction,
            transaction: tx
        });

        // Cleanup
        await priorityFees.unsubscribe();
        process.exit(0);

    } catch (error) {
        logger.error("Error opening test position:", error);
        process.exit(1);
    }
}

// Handle process termination
process.on("SIGINT", () => {
    logger.info("Shutting down...");
    process.exit(0);
});

process.on("unhandledRejection", (error) => {
    logger.error("Unhandled promise rejection:", error);
    process.exit(1);
});

// Export for command line usage
export { openTestPosition };

// If running directly
if (process.argv[2] && process.argv[3]) {
    const asset = process.argv[2].toUpperCase(); // e.g., "SOL"
    const direction = process.argv[3].toLowerCase(); // "long" or "short"
    
    if (!["long", "short"].includes(direction)) {
        logger.error("Direction must be either 'long' or 'short'");
        process.exit(1);
    }
    
    if (!constants.Asset[asset]) {
        logger.error("Invalid asset symbol");
        process.exit(1);
    }
    
    openTestPosition(asset, direction);
}