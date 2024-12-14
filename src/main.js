import { ZetaClientWrapper } from "./clients/zeta.js";
import { ASSETS, SYMBOLS, ACTIVE_SYMBOLS } from "./config/config.js";
import logger from "./utils/logger.js";
import { constants } from "@zetamarkets/sdk";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

function validateConfig() {
  const requiredEnvVars = [
    "KEYPAIR_FILE_PATH_LONG",
    "KEYPAIR_FILE_PATH_SHORT",
    "WS_API_KEY",
    "RPC_TRADINGBOT",
  ];

  const missingVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);
  if (missingVars.length > 0) {
    logger.error(`Missing required environment variables: ${missingVars.join(", ")}`);
    process.exit(1);
  }

  if (
    !fs.existsSync(process.env.KEYPAIR_FILE_PATH_LONG) ||
    !fs.existsSync(process.env.KEYPAIR_FILE_PATH_SHORT)
  ) {
    logger.error("Wallet files not found");
    process.exit(1);
  }

  const tradingSymbols = ACTIVE_SYMBOLS;
  const invalidSymbols = tradingSymbols.filter(
    (symbol) => !ASSETS.includes(constants.Asset[symbol])
  );
  
  if (invalidSymbols.length > 0) {
    logger.error(`Invalid trading symbols found: ${invalidSymbols.join(", ")}`);
    process.exit(1);
  }

  return tradingSymbols;
}

async function main() {
  try {
    const tradingSymbols = validateConfig();
    const zetaClient = new ZetaClientWrapper();
    
    logger.info("Starting trading system", { symbols: tradingSymbols });
    await zetaClient.initialize(tradingSymbols);

    // Shutdown handlers
    process.on("SIGINT", () => {
      logger.info("Graceful shutdown initiated");
      zetaClient.shutdown();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      logger.info("Graceful shutdown initiated");
      zetaClient.shutdown();
      process.exit(0);
    });
  } catch (error) {
    logger.error("Fatal error:", error);
    process.exit(1);
  }
}

// Global error handlers
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Promise Rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  process.exit(1);
});

main().catch((error) => {
  logger.error("Unhandled error:", error);
  process.exit(1);
});