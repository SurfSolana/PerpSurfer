// NEEDS REFACTOR

// #!/usr/bin/env node

// import yargs from "yargs";
// import { hideBin } from "yargs/helpers";
// import dotenv from "dotenv";
// import { ZetaClientWrapper } from "./clients/zeta.js";
// import { constants } from "@zetamarkets/sdk";
// import logger from "./utils/logger.js";

// dotenv.config();

// const validateInputs = (argv) => {
// 	// Validate direction
// 	if (!["long", "short"].includes(argv.direction)) {
// 		throw new Error('Direction must be either "long" or "short"');
// 	}

// 	// Validate token
// 	if (!constants.Asset[argv.token]) {
// 		throw new Error(`Invalid token. Must be one of: ${Object.keys(constants.Asset).join(", ")}`);
// 	}

// 	// Validate numeric inputs
// 	const leverage = parseFloat(argv.leverage);
// 	const takeProfit = parseFloat(argv.takeprofit);
// 	const stopLoss = parseFloat(argv.stoploss);

// 	if (isNaN(leverage) || leverage <= 0 || leverage > 10) {
// 		throw new Error("Leverage must be a number between 0 and 10");
// 	}

// 	if (isNaN(takeProfit) || takeProfit <= 0 || takeProfit > 100) {
// 		throw new Error("Take profit must be a percentage between 0 and 100");
// 	}

// 	if (isNaN(stopLoss) || stopLoss <= 0 || stopLoss > 100) {
// 		throw new Error("Stop loss must be a percentage between 0 and 100");
// 	}

// 	return {
// 		direction: argv.direction,
// 		token: argv.token,
// 		leverage: leverage,
// 		takeProfit: takeProfit / 100, // Convert percentage to decimal
// 		stopLoss: stopLoss / 100, // Convert percentage to decimal
// 	};
// };

// const openPosition = async (validatedArgs) => {
// 	const zetaClient = new ZetaClientWrapper();

// 	// Override default settings with CLI arguments
// 	zetaClient.settings = {
// 		leverageMultiplier: validatedArgs.leverage,
// 		takeProfitPercentage: validatedArgs.takeProfit,
// 		stopLossPercentage: validatedArgs.stopLoss,
// 		trailingStopLoss: {
// 			progressThreshold: 0.6,
// 			stopLossDistance: 0.4,
// 			triggerDistance: 0.45,
// 		},
// 	};

// 	// Initialize the base client with symbols
// 	await zetaClient.initialize([validatedArgs.token]);
  
// 	// Initialize for specific direction
// 	await zetaClient.initializeDirection(validatedArgs.direction);

// 	// Open the position
// 	const marketIndex = constants.Asset[validatedArgs.token];
// 	const txid = await zetaClient.openPosition(validatedArgs.direction, marketIndex, "taker");

// 	logger.info("Position opened successfully", {
// 		txid,
// 		...validatedArgs,
// 	});

// 	// Allow time for position monitoring to start
// 	await new Promise((resolve) => setTimeout(resolve, 2000));

// 	// Cleanup
// 	if (Exchange.isInitialized) {
// 		await Exchange.close();
// 	}
// 	process.exit(0);
// };

// async function main() {
// 	try {
// 		const argv = await yargs(hideBin(process.argv))
// 			.command("$0", "Open a position with specified parameters", (yargs) => {
// 				return yargs
// 					.option("direction", {
// 						alias: "d",
// 						describe: "Trading direction (long/short)",
// 						type: "string",
// 						required: true,
// 					})
// 					.option("token", {
// 						alias: "t",
// 						describe: "Token to trade",
// 						type: "string",
// 						required: true,
// 					})
// 					.option("leverage", {
// 						alias: "l",
// 						describe: "Leverage multiplier",
// 						type: "number",
// 						required: true,
// 					})
// 					.option("takeprofit", {
// 						alias: "tp",
// 						describe: "Take profit percentage",
// 						type: "number",
// 						required: true,
// 					})
// 					.option("stoploss", {
// 						alias: "sl",
// 						describe: "Stop loss percentage",
// 						type: "number",
// 						required: true,
// 					});
// 			})
// 			.help()
// 			.strict()
// 			.parse();

// 		const validatedArgs = validateInputs(argv);
// 		await openPosition(validatedArgs);
// 	} catch (error) {
// 		logger.error(error.message);
// 		process.exit(1);
// 	}
// }

// main();