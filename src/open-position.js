import { ZetaClientWrapper } from "./clients/zeta.js";
import { Exchange, Network, types, constants, utils } from "@zetamarkets/sdk";
import {
	BN,
	PriorityFeeMethod,
	PriorityFeeSubscriber,
	fetchSolanaPriorityFee,
} from "@drift-labs/sdk";
import dotenv from "dotenv";
import fs from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

dotenv.config();

// Command line argument setup with improved descriptions
const argv = yargs(hideBin(process.argv))
	.usage("Usage: $0 [options]")
	.example(
		"$0 -d long -s SOL",
		"Open a long SOL position with default settings"
	)
	.example(
		"$0 -d short -s ETH -l 3 --tp 0.04",
		"Open a 3x leveraged short ETH position with 4% take profit"
	)
	.option("direction", {
		alias: "d",
		description: "Position direction (long = buy, short = sell)",
		choices: ["long", "short"],
		required: true,
		group: "Required:",
	})
	.option("symbol", {
		alias: "s",
		description: "Trading asset symbol (e.g., SOL, ETH, BTC)",
		choices: Object.keys(constants.Asset).filter((key) => isNaN(Number(key))),
		required: true,
		group: "Required:",
	})
	.option("leverage", {
		alias: "l",
		description: "Position leverage multiplier (e.g., 4 means 4x leverage)",
		type: "number",
		default: 4,
		group: "Position Settings:",
	})
	.option("takeProfit", {
		alias: "tp",
		description: "Take profit percentage (0.036 = 3.6% profit target)",
		type: "number",
		default: 0.036,
		group: "Position Settings:",
	})
	.option("stopLoss", {
		alias: "sl",
		description: "Stop loss percentage (0.018 = 1.8% loss limit)",
		type: "number",
		default: 0.018,
		group: "Position Settings:",
	})
	.option("orderType", {
		alias: "o",
		description: "Order type (maker = limit order, taker = market order)",
		choices: ["maker", "taker"],
		default: "taker",
		group: "Position Settings:",
	})
	.wrap(100)
	.epilogue(
		"For more information about the trading parameters, check the documentation"
	)
	.help()
	.alias("help", "h").argv;

/**
 * Validates essential environment variables and files
 * @throws {Error} If required configuration is missing
 */
function validateConfig() {
	const requiredEnvVars = [
		"KEYPAIR_FILE_PATH_LONG",
		"KEYPAIR_FILE_PATH_SHORT",
		"RPC_TRADINGBOT",
	];

	const missingVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);
	if (missingVars.length > 0) {
		console.error(
			`Missing required environment variables: ${missingVars.join(", ")}`
		);
		process.exit(1);
	}

	// Verify wallet files exist
	const walletPath =
		argv.direction === "long"
			? process.env.KEYPAIR_FILE_PATH_LONG
			: process.env.KEYPAIR_FILE_PATH_SHORT;

	if (!fs.existsSync(walletPath)) {
		console.error(`Wallet file not found at ${walletPath}`);
		process.exit(1);
	}
}

/**
 * Opens a position with specified parameters
 */
async function openPosition() {
	try {
		// Validate configuration first
		validateConfig();

		// Convert symbol to market index
		const marketIndex = constants.Asset[argv.symbol];

		// Initialize ZetaWrapper
		const zetaWrapper = new ZetaClientWrapper();

		// Initialize exchange and get connection
		await zetaWrapper.initializeExchange(marketIndex);

		// Set custom trading settings
		zetaWrapper.settings = {
			leverageMultiplier: argv.leverage,
			takeProfitPercentage: argv.takeProfit,
			stopLossPercentage: argv.stopLoss,
			trailingStopLoss: {
				progressThreshold: 0.6,
				stopLossDistance: 0.4,
				triggerDistance: 0.45,
			},
		};

		// Initialize client with appropriate wallet
		const walletPath =
			argv.direction === "long"
				? process.env.KEYPAIR_FILE_PATH_LONG
				: process.env.KEYPAIR_FILE_PATH_SHORT;

		await zetaWrapper.initializeClient(walletPath);

		console.log("Opening position with parameters:", {
			direction: argv.direction,
			symbol: argv.symbol,
			leverage: argv.leverage + "x",
			takeProfit: (argv.takeProfit * 100).toFixed(2) + "%",
			stopLoss: (argv.stopLoss * 100).toFixed(2) + "%",
			orderType: argv.orderType,
		});

		// Open the position
		const txid = await zetaWrapper.openPosition(
			argv.direction,
			marketIndex,
			argv.orderType
		);

		console.log("Position opened successfully!");
		console.log("Transaction ID:", txid);

		process.exit(0);
	} catch (error) {
		console.error("Error opening position:", error);
		process.exit(1);
	}
}

// Handle interruptions gracefully
process.on("SIGINT", async () => {
	console.log("\nGracefully shutting down...");
	process.exit(0);
});

process.on("unhandledRejection", async (reason, promise) => {
	console.error("Unhandled Promise Rejection:", reason);
	process.exit(1);
});

// Start the position opening process
openPosition().catch(async (error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
