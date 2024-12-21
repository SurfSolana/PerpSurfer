import { ZetaClientWrapper } from "./clients/zeta.js";
import { Connection } from "@solana/web3.js";
import { ASSETS, SYMBOLS } from "./config/config.js";
import logger from "./utils/logger.js";
import { constants, types, Network, Exchange, utils } from "@zetamarkets/sdk";
import { PriorityFeeMethod, PriorityFeeSubscriber, fetchSolanaPriorityFee } from "@drift-labs/sdk";
import WebSocket from "ws";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

/**
 * System Configuration Constants
 * These values control the timing and behavior of various system components.
 * They're separated here for easy adjustment and maintenance.
 */
const WS_HOST = process.env.WS_HOST || "api.nosol.lol";
const WS_PORT = process.env.WS_PORT || 8080;
const API_KEY = process.env.WS_API_KEY;
const MAX_QUEUE_SIZE = 1000; // Maximum number of signals to queue before dropping old ones

// Interval timings for various monitoring activities
const MONITORING_INTERVALS = {
  ACTIVE_POSITION: 3000, // How often to check position status during active management
  WAITING_CLOSURE: 15000, // Reduced frequency after stop loss is adjusted
  RECONNECT_DELAY: 5000, // Time between WebSocket reconnection attempts
  HEALTH_CHECK: 300000, // 5 min - How often to verify system health
};

/**
 * Validates system configuration and trading symbols
 * Performs essential checks before system startup to prevent runtime errors
 * @returns {string[]} Array of validated trading symbols
 * @throws {Error} If configuration is invalid
 */
function validateConfig() {
  // Essential environment variables that must be present
  const requiredEnvVars = ["KEYPAIR_FILE_PATH_LONG", "KEYPAIR_FILE_PATH_SHORT", "WS_API_KEY", "RPC_TRADINGBOT"];

  // Check for missing variables
  const missingVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);
  if (missingVars.length > 0) {
    logger.error(`[INIT] Missing required environment variables: ${missingVars.join(", ")}`);
    process.exit(1);
  }

  // Verify wallet files exist
  if (!fs.existsSync(process.env.KEYPAIR_FILE_PATH_LONG) || !fs.existsSync(process.env.KEYPAIR_FILE_PATH_SHORT)) {
    logger.error("[INIT] Wallet files not found");
    process.exit(1);
  }

  // set trading symbols
  const tradingSymbols = ["SOL", "BTC", "ETH"];

  // Validate all symbols are supported
  const invalidSymbols = tradingSymbols.filter((symbol) => !ASSETS.includes(constants.Asset[symbol]));
  if (invalidSymbols.length > 0) {
    logger.error(`[INIT] Invalid trading symbols found: ${invalidSymbols.join(", ")}`);
    process.exit(1);
  }

  return tradingSymbols;
}

async function initializeExchange(markets) {
  try {
    const connection = new Connection(process.env.RPC_TRADINGBOT);

    // Create set of markets to load
    const marketsToLoad = new Set([constants.Asset.SOL, ...markets]);
    const marketsArray = Array.from(marketsToLoad);

    const loadExchangeConfig = types.defaultLoadExchangeConfig(
      Network.MAINNET,
      connection,
      {
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      },
      500,
      true,
      connection,
      marketsArray,
      undefined,
      marketsArray
    );

    await Exchange.load(loadExchangeConfig);
    logger.info("Exchange loaded successfully");

    // Setup priority fees once globally
    const priorityFees = await setupPriorityFees(connection);

    return { connection, priorityFees };
  } catch (error) {
    logger.error("Error initializing exchange:", error);
    throw error;
  }
}

/**
 * Top-level manager class that coordinates the entire trading system
 * Handles both long and short trading operations across multiple symbols
 */
class MultiTradingManager {
  constructor() {
    // Core management components
    this.longManager = null; // Handles all long positions
    this.shortManager = null; // Handles all short positions
    this.symbols = []; // Active trading symbols

    // WebSocket state
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.connectionActive = false;

    // Message handling
    this.messageQueue = []; // FIFO queue for incoming signals
    this.isProcessingQueue = false; // Prevents concurrent queue processing

    // System monitoring
    this.healthCheckInterval = null;
  }

  /**
   * Initializes the trading system
   * Creates managers for both directions and establishes market connection
   */
  // Inside MultiTradingManager class
  async initialize(symbols) {
    try {
      this.symbols = symbols;
      console.log("[INIT] Initializing Multi-Trading Manager", {
        symbols: this.symbols,
        longWallet: process.env.KEYPAIR_FILE_PATH_LONG,
        shortWallet: process.env.KEYPAIR_FILE_PATH_SHORT,
      });

      // Initialize both trading directions
      this.longManager = new DirectionalTradingManager("long", this.symbols);
      await this.longManager.initialize();

      this.shortManager = new DirectionalTradingManager("short", this.symbols);
      await this.shortManager.initialize();

      // Do position check after both managers are initialized
      logger.info("[INIT] Checking existing positions");
      await this.longManager.checkExistingPositions();
      await this.shortManager.checkExistingPositions();

      this.setupWebSocket();
      this.setupHealthCheck();

      logger.info("[INIT] Trading system initialized successfully", {
        symbols: this.symbols,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("[INIT] Critical initialization error:", error);
      throw error;
    }
  }

  /**
   * Sets up WebSocket connection and message handling
   * Manages subscription to trading signals for all symbols
   */
  setupWebSocket() {
    if (this.ws) {
      this.ws.terminate();
    }

    this.ws = new WebSocket(`ws://${WS_HOST}:${WS_PORT}?apiKey=${API_KEY}`);

    this.ws.on("open", () => {
      this.connectionActive = true;
      this.reconnectAttempts = 0;
      console.log("[WS] Connected to signal stream");

      // Subscribe to symbols with direction
      this.symbols.forEach((symbol) => {
        // Subscribe long manager to long signals
        this.ws.send(
          JSON.stringify({
            type: "subscribe",
            symbol,
            direction: "long",
          })
        );

        // Subscribe short manager to short signals
        this.ws.send(
          JSON.stringify({
            type: "subscribe",
            symbol,
            direction: "short",
          })
        );

        console.log(`[WS] Subscribed to ${symbol} signals for both directions`);
      });
    });

    // Handle incoming messages
    this.ws.on("message", async (data) => {
      try {
        const signalData = JSON.parse(data.toString());

        // Handle connection acknowledgment
        if (signalData.type === "connection") {
          console.log("[WS] Server acknowledged connection:", {
            availableSymbols: signalData.symbols,
          });
          return;
        }

        // Only queue signals for symbols we're actually trading
        if (!this.symbols.includes(signalData.symbol)) {
          // console.log(`[WS] Ignoring signal for untracked symbol: ${signalData.symbol}`);
          return;
        }

        // Queue management - drop oldest if full
        if (this.messageQueue.length >= MAX_QUEUE_SIZE) {
          console.log("[WS] Queue full, dropping oldest message");
          this.messageQueue.shift();
        }

        this.messageQueue.push(signalData);
        console.log(`[WS] Queued signal for ${signalData.symbol}`);

        await this.processMessageQueue();
      } catch (error) {
        logger.error("[WS] Error processing message:", error);
      }
    });

    // Error handling
    this.ws.on("error", (error) => {
      console.log("[WS] WebSocket error:", error.message);
      this.connectionActive = false;
    });

    this.ws.on("close", (code, reason) => {
      this.connectionActive = false;
      console.log(`[WS] Connection closed (${code}): ${reason}`);

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnect();
      } else {
        logger.error("[WS] Max reconnection attempts reached");
      }
    });
  }

  /**
   * Processes queued messages in order
   * Prevents concurrent processing with mutex
   */
  async processMessageQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    try {
      while (this.messageQueue.length > 0) {
        const signalData = this.messageQueue.shift();

        if (!signalData?.symbol || signalData.direction === undefined) {
          console.log("[QUEUE] Skipping invalid message:", signalData);
          continue;
        }

        // Route to appropriate manager based on signal direction
        const direction = signalData.direction === 1 ? "long" : "short";
        const manager = direction === "long" ? this.longManager : this.shortManager;

        try {
          await manager.processSignal(signalData);
        } catch (error) {
          logger.error(`[QUEUE] Error processing ${signalData.symbol}:`, error);
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Attempts to reconnect WebSocket
   * Implements progressive backoff
   */
  reconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`[WS] Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
      setTimeout(() => this.setupWebSocket(), MONITORING_INTERVALS.RECONNECT_DELAY);
    }
  }

  /**
   * Monitors system health
   * Checks connections and initiates recovery if needed
   */
  setupHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      if (!this.connectionActive) {
        console.log("[HEALTH] WebSocket disconnected, attempting reconnect");
        this.reconnect();
      }

      console.log("[HEALTH] System Status:", {
        wsConnected: this.connectionActive,
        queueLength: this.messageQueue.length,
        reconnectAttempts: this.reconnectAttempts,
        timestamp: new Date().toISOString(),
      });
    }, MONITORING_INTERVALS.HEALTH_CHECK);
  }

  /**
   * Gracefully shuts down the trading system
   * Ensures all components are properly closed
   */
  shutdown() {
    logger.info("[SHUTDOWN] Initiating graceful shutdown");
    clearInterval(this.healthCheckInterval);

    if (this.ws) {
      this.ws.close();
    }

    this.longManager.shutdown();
    this.shortManager.shutdown();

    console.log("[SHUTDOWN] Shutdown complete");
  }
}

/**
 * Manages trading operations for a specific direction (long/short)
 * Coordinates multiple symbols while maintaining direction-specific logic
 */
class DirectionalTradingManager {
  constructor(direction, symbols) {
    this.direction = direction; // 'long' or 'short'
    this.symbols = symbols; // Array of trading symbols
    this.symbolManagers = new Map(); // Map of symbol -> SymbolTradingManager
    this.isProcessing = false; // Prevents concurrent signal processing
    this.zetaWrapper = null; // Shared ZetaWrapper instance
  }

  async initialize() {
    try {
      logger.info(`[INIT] Initializing ${this.direction} trading manager for:`, this.symbols);

      // Initialize single ZetaWrapper for all markets in this direction
      this.zetaWrapper = new ZetaClientWrapper();
      const keypairPath = this.direction === "long" ? process.env.KEYPAIR_FILE_PATH_LONG : process.env.KEYPAIR_FILE_PATH_SHORT;

      // Initialize one client
      await this.zetaWrapper.initialize(keypairPath);
      logger.info(
        `[INIT] ZetaWrapper initialized for ${this.direction} trading with markets:`,
        marketIndices.map((idx) => constants.Asset[idx])
      );

      // Create managers for each symbol sharing the same wrapper
      for (const symbol of this.symbols) {
        const marketIndex = constants.Asset[symbol];
        const manager = new SymbolTradingManager(marketIndex, this.direction, this.zetaWrapper);
        this.symbolManagers.set(symbol, manager);
      }

      logger.info(`[INIT] ${this.direction} manager initialized with ${this.symbols.length} symbols`);
    } catch (error) {
      logger.error(`[INIT] Failed to initialize ${this.direction} trading manager:`, error);
      throw error;
    }
  }

  async processSignal(signalData) {
    // Verify signal matches our direction
    const signalDirection = signalData.direction === 1 ? "long" : "short";
    if (signalDirection !== this.direction) {
      console.log(`[${this.direction}] Ignoring ${signalDirection} signal`);
      return;
    }

    if (this.isProcessing) {
      console.log(`[${this.direction}] Already processing signal, queued for next cycle`);
      return;
    }

    this.isProcessing = true;
    try {
      const manager = this.symbolManagers.get(signalData.symbol);
      if (!manager) {
        console.log(`[${this.direction}] No manager found for ${signalData.symbol}`);
        return;
      }

      await manager.processSignal(signalData);
    } catch (error) {
      logger.error(`[${this.direction}] Error processing signal:`, error);
    } finally {
      this.isProcessing = false;
    }
  }

  // Inside DirectionalTradingManager class
  // In DirectionalTradingManager class
  async checkExistingPositions() {
    logger.info(`[INIT] Checking existing ${this.direction} positions for symbols:`, this.symbols);

    for (const [symbol, manager] of this.symbolManagers) {
      try {
        const marketIndex = constants.Asset[symbol];
        const position = await manager.zetaWrapper.getPosition(marketIndex);

        if (position && position.size !== 0) {
          // Verify position direction matches this manager
          const positionDirection = position.size > 0 ? "long" : "short";
          if (positionDirection === this.direction) {
            logger.info(`[INIT] Found existing ${this.direction} position for ${symbol}`, {
              size: position.size,
              entryPrice: position.costOfTrades ? (position.costOfTrades / position.size).toFixed(4) : "N/A",
            });
            // Just use processSignal with a dummy signal to start monitoring if needed
            await manager.processSignal({
              symbol,
              direction: positionDirection === "long" ? 1 : -1,
              close: 0, // Price not needed for existing position check
              signal: 0,
            });
          }
        } else {
          logger.info(`[INIT] No existing ${this.direction} position found for ${symbol}`);
        }
      } catch (error) {
        logger.error(`[INIT] Error checking ${symbol} position:`, error);
      }
    }
  }

  shutdown() {
    console.log(`[SHUTDOWN] Shutting down ${this.direction} trading manager`);
    // Clean up all symbol managers
    for (const manager of this.symbolManagers.values()) {
      manager.shutdown();
    }

    // Clean up the shared client
    if (this.zetaWrapper) {
      // Add any necessary cleanup for ZetaClientWrapper
      this.zetaWrapper = null;
    }
  }
}

/**
 * Manages trading operations for a specific symbol
 * Handles position entry, monitoring, and stop loss management
 */
class SymbolTradingManager {
  constructor(marketIndex, direction, zetaWrapper) {
    this.marketIndex = marketIndex;
    this.direction = direction;
    this.symbol = constants.Asset[marketIndex];
    this.zetaWrapper = zetaWrapper;
    this.monitoringIntervals = new Map();
    this.lastCheckedSize = null;
    this.monitoringState = new Map(); // Track monitoring state per position
    this.lastCheckedPrice = null;
    this.isAdjusting = false;
  }

  async updateTransactionPriorityFees() {
    try {
      const recentFees = await fetchSolanaPriorityFee(this.zetaWrapper.connection, 150, []);
      const newFee = recentFees?.slice(0, 10).reduce((sum, fee) => sum + fee.prioritizationFee, 0) / 10 || 1_000;
      const currentPriorityFee = Math.floor(newFee * 5);

      Exchange.updatePriorityFee(currentPriorityFee);
      logger.info("Updated transaction priority fee:", {
        baseFee: newFee,
        adjustedFee: currentPriorityFee,
        multiplier: 5,
      });

      return currentPriorityFee;
    } catch (error) {
      logger.error("Error updating transaction priority fees:", error);
      throw error;
    }
  }

  async verifyStopLossAdjustment(originalStopLoss, maxAttempts = 5) {
    const VERIFY_INTERVAL = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.zetaWrapper.client.updateState();
        const triggerOrders = await this.zetaWrapper.getTriggerOrders(this.marketIndex);

        const position = await this.zetaWrapper.getPosition(this.marketIndex);
        if (!position) {
          logger.info(`[${this.symbol}] Position closed during verification`);
          return true;
        }

        const isShort = position.size < 0;
        const currentStopLoss = triggerOrders.find((order) => (isShort ? order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL : order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL));

        if (!currentStopLoss) {
          logger.error(`[${this.symbol}] Stop loss order not found during verification`);
          return false;
        }

        // Simple verification - just check if the price changed
        if (currentStopLoss.orderPrice !== originalStopLoss.orderPrice) {
          logger.info(`[${this.symbol}] Stop loss adjustment verified on attempt ${attempt}`);
          return true;
        }

        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL));
        }
      } catch (error) {
        logger.error(`[${this.symbol}] Error verifying stop loss adjustment:`, error);
        if (attempt === maxAttempts) return false;
      }
    }

    logger.error(`[${this.symbol}] Failed to verify stop loss adjustment after ${maxAttempts} attempts`);
    return false;
  }

  async processSignal(signalData) {
    try {
      const currentPosition = await this.zetaWrapper.getPosition(this.marketIndex);
      
      if (!currentPosition || currentPosition.size === 0) {
        if (signalData.signal !== 0) {
          await this.openNewPosition(signalData);
        }
        return;
      }

      const positionId = this.generatePositionId(currentPosition);

      // Check if stop loss has been adjusted before starting monitoring
      const hasOriginalSL = await this.hasOriginalStopLoss(currentPosition);
      
      if (!hasOriginalSL) {
        console.log(`[${this.symbol}] Stop loss already adjusted, skipping monitoring for ${positionId}`);
        return;
      }

      if (!this.monitoringIntervals.has(positionId)) {
        console.log(`[${this.symbol}] Starting monitoring for ${positionId}`, {
          size: currentPosition.size,
          direction: this.direction,
        });
        const interval = setInterval(() => this.monitorPosition(currentPosition), 3000);
        this.monitoringIntervals.set(positionId, interval);
        this.monitoringState.set(positionId, {
          startTime: Date.now(),
          lastCheck: Date.now(),
          originalSize: currentPosition.size,
        });
      }
    } catch (error) {
      logger.error(`[TRADE] Error processing signal for ${this.symbol}:`, error);
    }
  }

  
  async openNewPosition(signalData) {
    try {
      logger.info(`[TRADE] Opening ${this.direction} position for ${this.symbol}`, {
        price: signalData.close,
        timestamp: new Date().toISOString(),
      });

      await this.updateTransactionPriorityFees();

      const tx = await this.zetaWrapper.openPosition(this.direction, this.marketIndex);

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const newPosition = await this.zetaWrapper.getPosition(this.marketIndex);
      const hasNewPosition = newPosition !== null && newPosition.size !== 0;

      if (hasNewPosition) {
        logger.info(`[TRADE] Position opened for ${this.symbol}`, {
          direction: this.direction,
          size: newPosition.size,
          price: signalData.close,
          txid: tx,
        });

        const positionId = this.generatePositionId(newPosition);
        const interval = setInterval(() => this.monitorPosition(newPosition), 3000);
        this.monitoringIntervals.set(positionId, interval);
      } else {
        logger.error(`[TRADE] Failed to verify new position for ${this.symbol}`);
      }
    } catch (error) {
      logger.error(`[TRADE] Failed to open position for ${this.symbol}:`, error);
    }
  }

  async monitorPosition(originalPosition) {
    const positionId = this.generatePositionId(originalPosition);

    if (this.isAdjusting) {
      return;
    }

    try {
      const settings = await this.zetaWrapper.fetchSettings();
      const { trailingStopLoss } = settings;

      const currentPosition = await this.zetaWrapper.getPosition(this.marketIndex);
      if (!currentPosition || currentPosition.size === 0) {
        logger.info(`[${this.symbol}] Position closed, stopping monitoring`);
        this.stopMonitoring(positionId);
        return;
      }

      const triggerOrders = await this.zetaWrapper.getTriggerOrders(this.marketIndex);
      const isShort = currentPosition.size < 0;

      const stopLoss = triggerOrders.find((order) => (isShort ? 
        order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL : 
        order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL));
      const takeProfit = triggerOrders.find((order) => (isShort ? 
        order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL : 
        order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL));

      if (!stopLoss || !takeProfit) {
        logger.info(`[${this.symbol}] No stop loss or take profit found, stopping monitoring`);
        this.stopMonitoring(positionId);
        return;
      }

      const entryPrice = Math.abs(currentPosition.costOfTrades / currentPosition.size);
      const currentPrice = this.zetaWrapper.getCalculatedMarkPrice(this.marketIndex);
      const takeProfitPrice = takeProfit.orderPrice / 1e6;

      const totalDistanceToTP = Math.abs(takeProfitPrice - entryPrice);
      const currentProgress = isShort ? entryPrice - currentPrice : currentPrice - entryPrice;
      const progressPercent = currentProgress / totalDistanceToTP;

      if (this.lastCheckedPrice !== currentPrice) {
        console.log(`[${this.symbol}] Position progress update:`, {
          positionId,
          direction: isShort ? "SHORT" : "LONG",
          entryPrice: entryPrice.toFixed(4),
          currentPrice: currentPrice.toFixed(4),
          stopLossPrice: (stopLoss.orderPrice / 1e6).toFixed(4),
          takeProfitPrice: takeProfitPrice.toFixed(4),
          progress: (progressPercent * 100).toFixed(2) + "%",
          thresholdNeeded: (trailingStopLoss.progressThreshold * 100).toFixed(2) + "%",
        });
        this.lastCheckedPrice = currentPrice;
      }

      if (progressPercent >= trailingStopLoss.progressThreshold) {
        this.isAdjusting = true;

        const newStopLoss = this.zetaWrapper.roundToTickSize(
          isShort ? 
            entryPrice - totalDistanceToTP * trailingStopLoss.stopLossDistance : 
            entryPrice + totalDistanceToTP * trailingStopLoss.stopLossDistance
        );

        const newTrigger = this.zetaWrapper.roundToTickSize(
          isShort ? 
            entryPrice - totalDistanceToTP * trailingStopLoss.triggerDistance : 
            entryPrice + totalDistanceToTP * trailingStopLoss.triggerDistance
        );

        logger.info(`[${this.symbol}] Adjusting stop loss:`, {
          currentPrice: currentPrice.toFixed(4),
          newStopLoss: newStopLoss.toFixed(4),
          newTrigger: newTrigger.toFixed(4),
          progress: (progressPercent * 100).toFixed(2) + "%",
        });

        const newPrices = {
          orderPrice: utils.convertDecimalToNativeInteger(newStopLoss),
          triggerPrice: utils.convertDecimalToNativeInteger(newTrigger),
        };

        try {
          await this.updateTransactionPriorityFees();
          const adjustmentSuccess = await this.zetaWrapper.adjustStopLossOrder(newPrices, this.marketIndex, currentPosition.size);

          if (adjustmentSuccess) {
            await new Promise(resolve => setTimeout(resolve, 2000));

            await this.zetaWrapper.client.updateState();
            const updatedOrders = await this.zetaWrapper.getTriggerOrders(this.marketIndex);
            const updatedStopLoss = updatedOrders.find(order => order.triggerOrderBit === stopLoss.triggerOrderBit);

            if (updatedStopLoss && updatedStopLoss.orderPrice !== stopLoss.orderPrice) {
              logger.info(`[${this.symbol}] Stop loss successfully adjusted`);
              this.stopMonitoring(positionId);
              return;
            }
          }
        } catch (error) {
          logger.error(`[${this.symbol}] Error during stop loss adjustment:`, error);
        } finally {
          this.isAdjusting = false;
        }
      }
    } catch (error) {
      logger.error(`[${this.symbol}] Error in position monitoring:`, {
        error: error.message,
        stack: error.stack,
        positionId,
      });
      this.isAdjusting = false;
    }
  }

  
  stopMonitoring(positionId) {
    const interval = this.monitoringIntervals.get(positionId);
    if (interval) {
      clearInterval(interval);
      this.monitoringIntervals.delete(positionId);
      console.log(`[${this.symbol}] Stopped monitoring ${positionId}`);
    }
  }

  async shouldAdjustStopLoss(position) {
    const currentPrice = this.zetaWrapper.getCalculatedMarkPrice(this.marketIndex);
    const entryPrice = Math.abs(position.costOfTrades / position.size);
    const isShort = position.size < 0;

    const triggerOrders = await this.zetaWrapper.getTriggerOrders(this.marketIndex);
    const takeProfit = triggerOrders.find((order) => (isShort ? order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL : order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL));

    if (!takeProfit) return false;

    const tpPrice = takeProfit.orderPrice / 1e6;
    const totalDistance = Math.abs(tpPrice - entryPrice);
    const currentProgress = isShort ? entryPrice - currentPrice : currentPrice - entryPrice;

    const progressPercent = currentProgress / totalDistance;

    const requiredProgress = 0.6; // 60% progress towards TP

    // Always log the progress check
    console.log(`[${this.symbol}] Progress check:`, {
      direction: isShort ? "SHORT" : "LONG",
      entryPrice: entryPrice.toFixed(4),
      currentPrice: currentPrice.toFixed(4),
      tpPrice: tpPrice.toFixed(4),
      progress: (progressPercent * 100).toFixed(2) + "%",
      requiredProgress: (requiredProgress * 100).toFixed(2) + "%",
      readyToAdjust: progressPercent >= requiredProgress,
    });

    return progressPercent >= requiredProgress;
  }

  async hasOriginalStopLoss(position) {
    const triggerOrders = await this.zetaWrapper.getTriggerOrders(this.marketIndex);
    const isShort = position.size < 0;

    const stopLoss = triggerOrders.find((order) => (isShort ? 
      order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL : 
      order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL));

    if (!stopLoss) return false;

    const currentStopLossPrice = stopLoss.orderPrice / 1e6;
    const entryPrice = Math.abs(position.costOfTrades / position.size);

    const { stopLossPrice: originalStopLoss } = this.zetaWrapper.calculateTPSLPrices(
      isShort ? "short" : "long", 
      entryPrice, 
      await this.zetaWrapper.fetchSettings()
    );

    const difference = Math.abs(currentStopLossPrice - originalStopLoss) / originalStopLoss;

    console.log(`[${this.symbol}] Stop Loss Analysis:`, {
      direction: isShort ? "SHORT" : "LONG",
      entryPrice: entryPrice.toFixed(4),
      originalStopLoss: originalStopLoss.toFixed(4),
      currentStopLoss: currentStopLossPrice.toFixed(4),
      difference: (difference * 100).toFixed(2) + "%",
      isOriginal: difference < 0.001,
    });

    return difference < 0.001;
  }

  
  async hasOriginalStopLoss(position) {
    const triggerOrders = await this.zetaWrapper.getTriggerOrders(this.marketIndex);
    const isShort = position.size < 0;

    const stopLoss = triggerOrders.find((order) => (isShort ? order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL : order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL));

    if (!stopLoss) return false;

    const currentStopLossPrice = stopLoss.orderPrice / 1e6;
    const entryPrice = Math.abs(position.costOfTrades / position.size);

    const { stopLossPrice: originalStopLoss } = this.zetaWrapper.calculateTPSLPrices(isShort ? "short" : "long", entryPrice, await this.zetaWrapper.fetchSettings());

    const difference = Math.abs(currentStopLossPrice - originalStopLoss) / originalStopLoss;
    return difference < 0.001; // Return true if at original stop loss
  }

  generatePositionId(position) {
    return `${this.symbol}-${position.size > 0 ? "LONG" : "SHORT"}-${position.costOfTrades}`;
  }

  stopMonitoring(positionId) {
    const interval = this.monitoringIntervals.get(positionId);
    if (interval) {
      clearInterval(interval);
      this.monitoringIntervals.delete(positionId);
      console.log(`[${this.symbol}] Stopped monitoring ${positionId}`);
    }
  }

  shutdown() {
    for (const [positionId, interval] of this.monitoringIntervals) {
      clearInterval(interval);
      this.monitoringIntervals.delete(positionId);
    }
    logger.info(`[${this.symbol}] Manager shutdown complete`);
  }
}

async function setupPriorityFees(connection) {
  try {
    const config = {
      priorityFeeMethod: PriorityFeeMethod.SOLANA,
      frequencyMs: 5000,
      connection: connection,
    };

    logger.info("Initializing Solana Priority Fees with config:", {
      method: config.priorityFeeMethod,
      frequency: config.frequencyMs,
      hasConnection: !!connection,
    });

    const priorityFees = new PriorityFeeSubscriber({
      ...config,
      lookbackDistance: 150,
      addresses: [],
      connection: connection,
    });

    logger.info("Subscribing to priority fees...");
    await priorityFees.subscribe();

    logger.info("Loading priority fee data...");
    await priorityFees.load();

    const recentFees = await fetchSolanaPriorityFee(connection, 150, []);

    logger.info("Recent Priority Fees:", {
      numFees: recentFees?.length,
      latestFee: recentFees?.[0]?.prioritizationFee,
      oldestFee: recentFees?.[recentFees.length - 1]?.prioritizationFee,
      latestSlot: recentFees?.[0]?.slot,
      oldestSlot: recentFees?.[recentFees.length - 1]?.slot,
    });

    const initialFee = recentFees?.slice(0, 10).reduce((sum, fee) => sum + fee.prioritizationFee, 0) / 10 || 1_000;
    const priorityFeeMultiplier = 5;
    const currentPriorityFee = Math.floor(initialFee * priorityFeeMultiplier);

    logger.info("Priority Fees Setup Complete", {
      initialFee,
      adjustedFee: currentPriorityFee,
      multiplier: priorityFeeMultiplier,
    });

    Exchange.updatePriorityFee(currentPriorityFee);
    Exchange.setUseAutoPriorityFee(false);

    return priorityFees;
  } catch (error) {
    logger.error("Error setting up priority fees:", error);
    throw error;
  }
}

/**
 * Main execution function
 * Initializes and runs the trading system
 */
async function main() {
  try {
    const tradingSymbols = validateConfig();
    logger.info("[INIT] Starting Multi-Symbol Trading System", {
      symbols: tradingSymbols,
    });

    // Initialize Exchange and priority fees first
    const marketIndices = tradingSymbols.map((symbol) => constants.Asset[symbol]);
    
    const zetaWrapper = new ZetaClientWrapper();
    await zetaWrapper.initializeExchange(marketIndices);

    const multiManager = new MultiTradingManager();
    await multiManager.initialize(tradingSymbols);

    // Start priority fee update interval
    const updateInterval = setInterval(async () => {
      try {
        await priorityFees.load();
        const recentFees = await fetchSolanaPriorityFee(connection, 150, []);
        const newFee = recentFees?.slice(0, 10).reduce((sum, fee) => sum + fee.prioritizationFee, 0) / 10 || 1_000;
        const currentPriorityFee = Math.floor(newFee * 5);
        Exchange.updatePriorityFee(currentPriorityFee);
      } catch (error) {
        logger.error("Error updating priority fees:", error);
      }
    }, 5000);

    // Add cleanup of priority fee interval
    process.on("SIGINT", () => {
      logger.info("[SHUTDOWN] Graceful shutdown initiated");
      clearInterval(updateInterval);
      priorityFees.unsubscribe().catch(console.error);
      multiManager.shutdown();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      logger.info("[SHUTDOWN] Graceful shutdown initiated");
      clearInterval(updateInterval);
      priorityFees.unsubscribe().catch(console.error);
      multiManager.shutdown();
      process.exit(0);
    });
  } catch (error) {
    logger.error("[MAIN] Fatal error:", error);
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason, promise) => {
  logger.error("[ERROR] Unhandled Promise Rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.error("[ERROR] Uncaught Exception:", error);
  process.exit(1);
});

// Start the system
main().catch((error) => {
  logger.error("[MAIN] Unhandled error:", error);
  process.exit(1);
});
