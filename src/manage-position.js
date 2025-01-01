import { ZetaManagePositionClientWrapper } from "./clients/zeta/manage-position-client.js";
import { Connection } from "@solana/web3.js";
import { constants, Network, Exchange, types, utils } from "@zetamarkets/sdk";
import dotenv from "dotenv";
import logger from "./utils/logger.js";

dotenv.config();

const MAX_RETRIES = 10;

const VERIFY_TIMEOUT = 30000; // 30 seconds to verify position closed

// Helper function to generate a random delay between 1-3 seconds
function getRandomRetryDelay() {
	return Math.floor(Math.random() * (3000 - 1000 + 1)) + 1000;
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
			preflightCommitment: "finalized",
			commitment: "finalized",
		},
		25
	);

	// Store original console methods
	const originalLog = console.log;
	const originalError = console.error;
	const originalInfo = console.info;
	const originalWarn = console.warn;
	const originalDebug = console.debug;

	// Disable all console output
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};
	console.warn = () => {};
	console.debug = () => {};

	await Exchange.load(loadExchangeConfig);

	// Restore console methods
	console.log = originalLog;
	console.error = originalError;
	console.info = originalInfo;
	console.warn = originalWarn;
	console.debug = originalDebug;

	logger.info("Exchange loaded successfully");

	return connection;
}

async function verifyPositionOpened(zetaWrapper, asset, direction) {
	const startTime = Date.now();

	logger.info(`Checking position status for ${VERIFY_TIMEOUT}ms...`);

	while (Date.now() - startTime < VERIFY_TIMEOUT) {
		try {
			const position = await zetaWrapper.getPosition(constants.Asset[asset]);

			if (position && position.size !== 0) {
				logger.notify(`Position opening verified for ${asset}`);
				return true;
			}

			// Wait 1 second before checking again
			logger.info("Position not yet opened. Waiting 1s.");
			await utils.sleep(1000);
		} catch (error) {
			logger.error(`Error verifying position opening: ${error.message}`);
			return false;
		}
	}

	logger.error(`Timed out waiting for position opening verification for ${asset}`);
	return false;
}

async function verifyPositionClosed(zetaWrapper, asset, direction) {
	const startTime = Date.now();

	logger.info(`Checking position status for ${VERIFY_TIMEOUT}ms...`);

	while (Date.now() - startTime < VERIFY_TIMEOUT) {
		try {
			const position = await zetaWrapper.getPosition(constants.Asset[asset]);

			if (!position || position.size === 0) {
				logger.notify(`Position closure verified for ${asset}`);
				return true;
			}

			// Wait 1 second before checking again
			logger.info("Position still open. Waiting 1s.");
			await utils.sleep(1000);
		} catch (error) {
			logger.error(`Error verifying position closure: ${error.message}`);
			return false;
		}
	}

	logger.error(`Timed out waiting for position closure verification for ${asset}`);
	return false;
}

async function retryOperation(operation, operationName, asset) {
	// Save original exchange state for reload
	// const exchangeConfig = {
	// 	network: Exchange.network,
	// 	connection: Exchange.connection,
	// 	opts: Exchange.opts,
	// };

	// const keypairPath = process.env.KEYPAIR_FILE_PATH;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			logger.info(`${operationName} attempt ${attempt}/${MAX_RETRIES}`);
			const result = await operation();

			if (result && result.status === "NO_POSITION") {
				logger.info(`No position to close, exiting cleanly`);
				process.exit(0);
			}

			if (!result) {
				throw new Error("Transaction failed - no transaction signature returned");
			}

			logger.notify(`${operationName} successful on attempt ${attempt}`);
			return result;
		} catch (error) {
			const isLastAttempt = attempt === MAX_RETRIES;
			let errorMessage = error.message || error.toString();

			// Check for non-retryable errors
			const isNonRetryable =
				error.code === 6008 || // ZeroSize
				error.code === 6002 || // Failed initial margin requirement
				errorMessage.includes("Order size too small"); // Our early size check

			if (isNonRetryable) {
				logger.notify(`[CRITICAL] Non-retryable error encountered: ${errorMessage} - ${operationName}`);
				logger.error(`${operationName} failed with non-retryable error: ${errorMessage}`);
				process.exit(1);
			}

			const errorDetails = {
				attempt,
				error: errorMessage,
				code: error.code,
				txError: error.txError,
			};

			logger.error(`${operationName} attempt ${attempt} failed:`, errorDetails);

			if (isLastAttempt) {
				logger.notify(`[CRITICAL] Operation failed after maximum ${MAX_RETRIES} attempts - ${operationName}`);
				logger.error(`${operationName} failed after ${MAX_RETRIES} attempts`);
				throw error;
			}

			const delay = getRandomRetryDelay();
			logger.info(`Waiting ${delay}ms before retry...`);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

async function openTestPosition(asset, direction) {
	logger.notify(`[${asset}] Opening ${direction} position`);

	// Using single wallet for all operations
	const keypairPath = process.env.KEYPAIR_FILE_PATH;
	logger.info(`Using wallet: ${keypairPath}`);

	// Initialize Zeta client with single wallet
	const zetaWrapper = new ZetaManagePositionClientWrapper();
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
			`open ${direction} position for ${asset}`,
			asset
		);

		if (tx_open) {
			// Verify the position actually opened
			const verified = await verifyPositionOpened(zetaWrapper, asset, direction);

			if (verified) {
				logger.notify(`[${asset}] Successfully opened and verified ${direction} position`);
				process.exit(0);
			} else {
				logger.error(`Failed to verify position opening for ${asset}`);
				process.exit(1);
			}
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
	logger.notify(`[${asset}] Closing ${direction} position`);

	const keypairPath = process.env.KEYPAIR_FILE_PATH;
	logger.info(`Using wallet: ${keypairPath}`);

	const zetaWrapper = new ZetaManagePositionClientWrapper();
	await zetaWrapper.initializeExchange([constants.Asset[asset]]);
	await zetaWrapper.initialize(keypairPath);

	try {
		// Only retry the actual close operation if it fails
		const tx_close = await retryOperation(
			async () => {
				const result = await zetaWrapper.closePosition(direction, constants.Asset[asset]);
				if (!result) {
					throw new Error("Failed to close position - no transaction signature returned");
				}
				return result;
			},
			`close ${direction} position for ${asset}`,
			asset
		);

		if (tx_close) {
			// Verify the position actually closed
			const verified = await verifyPositionClosed(zetaWrapper, asset, direction);

			if (verified) {
				logger.notify(`[${asset}] Successfully closed and verified ${direction} position`);
				process.exit(0);
			} else {
				logger.error(`Failed to verify position closure for ${asset}`);
				process.exit(1);
			}
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
