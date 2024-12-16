import { ZetaClientWrapper } from "./clients/zeta.js";
import { Connection } from "@solana/web3.js";
import { constants, Network, Exchange, types } from "@zetamarkets/sdk";
import { PriorityFeeMethod, PriorityFeeSubscriber, fetchSolanaPriorityFee } from "@drift-labs/sdk";
import dotenv from "dotenv";
import logger from "./utils/logger.js";

dotenv.config();

async function validateAndInitialize(markets) {
	// Validate environment
	const requiredEnvVars = ["KEYPAIR_FILE_PATH_LONG", "KEYPAIR_FILE_PATH_SHORT", "RPC_TRADINGBOT"];

	const missingVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);

	if (missingVars.length > 0) {
		throw new Error(`Missing required environment variables: ${missingVars.join(", ")}`);
	}

	// Initialize connection and exchange
	const connection = new Connection(process.env.RPC_TRADINGBOT);

	// Create set of markets to load
	const marketsToLoad = new Set([constants.Asset.SOL, ...markets]);
	const marketsArray = Array.from(marketsToLoad);

	const loadExchangeConfig = types.defaultLoadExchangeConfig(
		Network.MAINNET,
		connection,
		{
			skipPreflight: true,
			preflightCommitment: "finalized",
			commitment: "finalized",
		},
		25,
		true,
		// connection,
		// marketsArray,
		// undefined,
		// marketsArray
	);

	await Exchange.load(loadExchangeConfig);
	logger.info("Exchange loaded successfully");

	return connection;
}

async function openTestPosition(asset, direction) {
	logger.info(`Initializing test position: ${direction} ${asset}`);

	// Get correct keypair path based on direction
	const keypairPath = direction === "long" ? process.env.KEYPAIR_FILE_PATH_LONG : process.env.KEYPAIR_FILE_PATH_SHORT;

	logger.info(`Using keypair path: ${keypairPath}`);

	// Initialize connection and exchange
	// const connection = await validateAndInitialize([constants.Asset[asset]]);
	
  // Initialize Zeta client
	const zetaWrapper = new ZetaClientWrapper();
	await zetaWrapper.initializeExchange([constants.Asset[asset]]);
	await zetaWrapper.initialize(keypairPath);

	await zetaWrapper.cancelAllTriggerOrders(constants.Asset[asset]);

	// Open position
	const tx = await zetaWrapper.openPosition(direction, constants.Asset[asset]);

	process.exit(0);
}


async function closeTestPosition(asset, direction) {
	logger.info(`Closing test position: ${direction} ${asset}`);

	// Get correct keypair path based on direction
	const keypairPath = direction === "long" ? process.env.KEYPAIR_FILE_PATH_LONG : process.env.KEYPAIR_FILE_PATH_SHORT;

	logger.info(`Using keypair path: ${keypairPath}`);

	// Initialize connection and exchange
	// const connection = await validateAndInitialize([constants.Asset[asset]]);
	
  // Initialize Zeta client
	const zetaWrapper = new ZetaClientWrapper();
	await zetaWrapper.initializeExchange([constants.Asset[asset]]);
	await zetaWrapper.initialize(keypairPath);
  
	// close position
	const tx_close = await zetaWrapper.closePosition(direction, constants.Asset[asset]);

  // cancel all trigger orders
	const tx_cancel = await zetaWrapper.cancelAllTriggerOrders(constants.Asset[asset]);

	process.exit(0);
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

	// openTestPosition(asset, direction);

	closeTestPosition(asset, direction);
}
