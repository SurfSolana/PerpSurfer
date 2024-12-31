import { constants } from "@zetamarkets/sdk";
import dotenv from "dotenv";
dotenv.config();

export const SERVER_NAME = "SURF";

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

export const ASSETS = Object.values(constants.Asset).filter((asset) => asset !== "UNDEFINED");

export const SYMBOLS = ASSETS.map((asset) => constants.Asset[asset]);

export const ACTIVE_SYMBOLS = ["SOL", "ETH", "BTC"];

// System-wide configuration settings
export const CONFIG = {
  // WebSocket and connection settings
  ws: {
    host: process.env.WS_HOST || "api.nosol.lol",
    port: process.env.WS_PORT || 8080,
    maxReconnectAttempts: 5,
    reconnectDelay: 5000, // Time between reconnection attempts (ms)
    messageQueueSize: 1000,
  },

  // Monitoring intervals (in milliseconds)
  intervals: {
    activePosition: 1000, // How often to check position status
    healthCheck: 300000,  // System health check interval (5 minutes)
    statusUpdate: 3600000, // Status update interval (1 hour)
  },

  // Position management settings
  position: {
    // Initial threshold that triggers trailing stop monitoring (60%)
    initialThreshold: 0.6,

    // How much price can pull back from highest progress before closing (10%)
    pullbackAmount: 0.1,

    // Number of consecutive threshold hits needed to close position
    thresholdHitCount: 2,

    // Time to wait after position actions (milliseconds)
    waitAfterAction: 15000,

    // How often to check position progress
    monitorInterval: 1000,
  },

  // Trading assets configuration
  tradingAssets: ACTIVE_SYMBOLS,

  // Required environment variables
  requiredEnvVars: ["KEYPAIR_FILE_PATH", "WS_API_KEY", "RPC_TRADINGBOT"],

  // Default trading settings
  defaultSettings: {
    simpleTakeProfit: 5,    // 5% take profit
    simpleStopLoss: 5,      // 5% stop loss
    leverageMultiplier: 1,  // Conservative default leverage
    trailingStop: {
      initialDistance: 2,    // Initial 2% stop distance
      trailDistance: 1,     // Maintain 1% trail distance
    },
  },

  // Per-token trading settings (overrides defaults)
  tokenSettings: {
    BTC: {
      leverageMultiplier: 5.34,
    },
    ETH: {
      leverageMultiplier: 5.34,
    },
    SOL: {
      leverageMultiplier: 5.34,
    },
  },

  // Helper function to get settings for a specific token
  getTokenSettings: function(token) {
    const defaults = this.defaultSettings;
    const tokenSpecific = this.tokenSettings[token] || {};
    return {
      ...defaults,
      ...tokenSpecific,
      trailingStop: {
        ...defaults.trailingStop,
        ...(tokenSpecific.trailingStop || {}),
      },
    };
  }
};