import { ZetaClientWrapper } from "./clients/zeta-api-v6.js";
import { Connection } from "@solana/web3.js";
import { ASSETS, SYMBOLS } from "./config/config.js";
import logger from "./utils/logger.js";
import { constants, types, Network, Exchange, utils } from "@zetamarkets/sdk";
import WebSocket from "ws";
import dotenv from "dotenv";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { getMarketSentiment } from "./utils/market-sentiment.js";

const execAsync = promisify(exec);

dotenv.config();

const WS_HOST = process.env.WS_HOST || "api.nosol.lol";
const WS_PORT = process.env.WS_PORT || 8080;
const API_KEY = process.env.WS_API_KEY;
const MAX_QUEUE_SIZE = 1000;

const MONITORING_INTERVALS = {
	ACTIVE_POSITION: 3000,
	RECONNECT_DELAY: 5000,
	HEALTH_CHECK: 300000,
};

const POSITION_SETTINGS = {
	progressThreshold: 0.6,
	pullbackThreshold: 0.4,
	monitorInterval: 3000,
};

function validateConfig() {
	const requiredEnvVars = ["KEYPAIR_FILE_PATH_LONG", "KEYPAIR_FILE_PATH_SHORT", "WS_API_KEY", "RPC_TRADINGBOT"];

	const missingVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);
	if (missingVars.length > 0) {
		logger.error(`[INIT] Missing required environment variables: ${missingVars.join(", ")}`);
		process.exit(1);
	}

	if (!fs.existsSync(process.env.KEYPAIR_FILE_PATH_LONG) || !fs.existsSync(process.env.KEYPAIR_FILE_PATH_SHORT)) {
		logger.error("[INIT] Wallet files not found");
		process.exit(1);
	}

	const tradingSymbols = ["SOL", "BTC", "ETH"];

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
			500,
			true,
			connection,
			marketsArray,
			undefined,
			marketsArray
		);

		await Exchange.load(loadExchangeConfig);
		logger.info("Exchange loaded successfully");

		return { connection };
	} catch (error) {
		logger.error("Error initializing exchange:", error);
		throw error;
	}
}

class SymbolTradingManager {
	constructor(marketIndex, direction, zetaWrapper) {
		// this.marketIndex = marketIndex;
		// this.direction = direction;
		// this.symbol = constants.Asset[marketIndex];
		// this.zetaWrapper = zetaWrapper;
		// this.positionMonitorInterval = null;
		// this.lastCheckedPrice = null;
		// this.hasReachedThreshold = false;
		// this.highestProgress = 0;

    this.marketIndex = marketIndex;
    this.direction = direction;
    this.symbol = constants.Asset[marketIndex];
    this.zetaWrapper = zetaWrapper;
    
    this.positionMonitorInterval = null;
    this.lastCheckedPrice = null;
    
    // Progress tracking properties remain the same
    this.hasReachedThreshold = false;    // Tracks if we've hit 30% progress
    this.highestProgress = 0;            // Can now go beyond 1.0 (100%)
    this.thresholdHits = 0;              // Counts consecutive hits at close threshold 
    
    // Position closing state
    this.isClosing = false;

	}

	async processSignal(signalData) {
		try {
			const currentPosition = await this.zetaWrapper.getPosition(this.marketIndex);

			if (!currentPosition || currentPosition.size === 0) {
				if (signalData.signal !== 0) {
					const marketConditions = await getMarketSentiment();
					const isLongSignal = signalData.signal === 1;

					if ((isLongSignal && marketConditions.canOpenLong) || (!isLongSignal && marketConditions.canOpenShort)) {
						logger.info(`[${this.symbol}] Opening position based on signal and market sentiment`, {
							direction: isLongSignal ? "long" : "short",
							marketSentiment: marketConditions.sentiment,
							sentimentIndex: marketConditions.index,
						});

						try {
							await execAsync(`node src/manage-position.js open ${this.symbol} ${isLongSignal ? "long" : "short"}`, {
								maxBuffer: 1024 * 1024 * 10,
							});
							console.log("Waiting 15s before continuing");
							await utils.sleep(15000);

							// this.startPositionMonitor();
						} catch (error) {
							logger.error(`[${this.symbol}] Failed to open position:`, error);
						}
					} else {
						logger.info(`[${this.symbol}] Skipping position due to market sentiment`, {
							attemptedDirection: isLongSignal ? "long" : "short",
							marketSentiment: marketConditions.sentiment,
							sentimentIndex: marketConditions.index,
						});
					}
				}
			}
		} catch (error) {
			logger.error(`[${this.symbol}] Error processing signal:`, error);
		}
	}

	async startPositionMonitor() {
		if (this.positionMonitorInterval) {
			clearInterval(this.positionMonitorInterval);
		}

		this.hasReachedThreshold = false;
		this.highestProgress = 0;

		this.positionMonitorInterval = setInterval(() => this.monitorPosition(), POSITION_SETTINGS.monitorInterval);
		logger.info(`[${this.symbol}] Started position monitoring`);

		await utils.sleep(500);
	}

  async monitorPosition() {
    try {
      // Don't process updates if we're in the middle of closing
      if (this.isClosing) {
        return;
      }

      const currentPosition = await this.zetaWrapper.getPosition(this.marketIndex);

      // Handle case where position is already closed
      if (!currentPosition || currentPosition.size === 0) {
        this.stopMonitoring();
        await execAsync(`node src/cancel-trigger-orders.js cancel ${this.symbol} ${this.direction}`, 
          { maxBuffer: 1024 * 1024 * 10 }
        );
        console.log("Waiting 15s before continuing");
        await utils.sleep(15000);
        return;
      }

      const settings = await this.zetaWrapper.fetchSettings();
      const direction = currentPosition.size > 0 ? "long" : "short";
      const entryPrice = Math.abs(currentPosition.costOfTrades / currentPosition.size);
      const currentPrice = this.zetaWrapper.getCalculatedMarkPrice(this.marketIndex);
      const { takeProfitPrice, stopLossPrice } = this.zetaWrapper.calculateTPSLPrices(
        direction, 
        entryPrice, 
        settings
      );

      // Calculate progress - can exceed 100%
      const totalDistanceToTP = Math.abs(takeProfitPrice - entryPrice);
      const currentProgress = direction === "long" ? 
        currentPrice - entryPrice : 
        entryPrice - currentPrice;
      const progressPercent = currentProgress / totalDistanceToTP;

      // Update highest progress - no upper limit
      this.highestProgress = Math.max(this.highestProgress, progressPercent);

      // Dynamic pullback threshold adjusts as price goes higher
      const dynamicPullbackThreshold = Math.max(0, this.highestProgress - 0.20);

      // Check if stop loss has been hit
      const originalStopLossHit = direction === "long" ? 
        currentPrice <= stopLossPrice : 
        currentPrice >= stopLossPrice;

      // Log position updates when price changes
      if (this.lastCheckedPrice !== currentPrice) {
        console.log(`[${this.symbol}] Position progress:`, {
          direction: direction === "long" ? "LONG" : "SHORT",
          entryPrice: entryPrice.toFixed(4),
          currentPrice: currentPrice.toFixed(4),
          stopLossPrice: stopLossPrice.toFixed(4),
          takeProfitPrice: takeProfitPrice.toFixed(4),
          progress: (progressPercent * 100).toFixed(2) + "%",
          hasReachedThreshold: this.hasReachedThreshold,
          highestProgress: (this.highestProgress * 100).toFixed(2) + "%",
          pullbackThreshold: (dynamicPullbackThreshold * 100).toFixed(2) + "%",
          thresholdHits: this.thresholdHits,
          beyondTakeProfit: progressPercent > 1.0 ? 
            `${((progressPercent - 1.0) * 100).toFixed(2)}% beyond TP` : 
            'No'
        });
        this.lastCheckedPrice = currentPrice;
      }

      // Handle stop loss
      if (originalStopLossHit) {
        logger.info(`[${this.symbol}] Stop loss hit, attempting to close position`);
        const closed = await this.closePosition();
        if (!closed) {
          logger.warn(`[${this.symbol}] Stop loss closure failed - will retry on next monitor cycle`);
        }
        return;
      }

      // Check initial threshold (30%)
      if (progressPercent >= 0.30) {
        this.hasReachedThreshold = true;
      }

      // Handle dynamic pullback threshold
      if (this.hasReachedThreshold) {
        if (progressPercent <= dynamicPullbackThreshold) {
          this.thresholdHits++;
          
          logger.info(`[${this.symbol}] Threshold hit detected:`, {
            hits: this.thresholdHits,
            currentProgress: (progressPercent * 100).toFixed(2) + "%",
            highestProgress: (this.highestProgress * 100).toFixed(2) + "%",
            pullbackThreshold: (dynamicPullbackThreshold * 100).toFixed(2) + "%",
            beyondTakeProfit: progressPercent > 1.0 ? 
              `${((progressPercent - 1.0) * 100).toFixed(2)}% beyond TP` : 
              'No'
          });

          if (this.thresholdHits >= 2) {
            logger.info(`[${this.symbol}] Attempting to close position:`, {
              reason: "Dynamic pullback threshold hit",
              hits: this.thresholdHits,
              currentProgress: (progressPercent * 100).toFixed(2) + "%",
              highestProgress: (this.highestProgress * 100).toFixed(2) + "%",
              pullbackThreshold: (dynamicPullbackThreshold * 100).toFixed(2) + "%"
            });
            
            const closed = await this.closePosition();
            if (!closed) {
              logger.warn(`[${this.symbol}] Pullback closure failed - will retry on next monitor cycle`);
            }
            return;
          }
        } else {
          // Reset hits counter if we're above the threshold again
          this.thresholdHits = 0;
        }
      }
    } catch (error) {
      logger.error(`[${this.symbol}] Error in position monitoring:`, error);
    }
  }


  // 12/20/24 replaced with above
  // *****************************
  // async monitorPosition() {
  //   try {
  //     const currentPosition = await this.zetaWrapper.getPosition(this.marketIndex);

  //     if (!currentPosition || currentPosition.size === 0) {
  //       this.stopMonitoring();
  //       await execAsync(`node src/cancel-trigger-orders.js cancel ${this.symbol} ${this.direction}`, { maxBuffer: 1024 * 1024 * 10 });
  //       console.log("Waiting 15s before continuing");
  //       await utils.sleep(15000);
  //       return;
  //     }

  //     const settings = await this.zetaWrapper.fetchSettings();
  //     const direction = currentPosition.size > 0 ? "long" : "short";
  //     const entryPrice = Math.abs(currentPosition.costOfTrades / currentPosition.size);
  //     const currentPrice = this.zetaWrapper.getCalculatedMarkPrice(this.marketIndex);
  //     const { takeProfitPrice, stopLossPrice } = this.zetaWrapper.calculateTPSLPrices(direction, entryPrice, settings);

  //     // Calculate progress - now allowed to exceed 100%
  //     const totalDistanceToTP = Math.abs(takeProfitPrice - entryPrice);
  //     const currentProgress = direction === "long" ? currentPrice - entryPrice : entryPrice - currentPrice;
  //     const progressPercent = currentProgress / totalDistanceToTP;  // Can now exceed 1.0

  //     // Update highest progress - no upper limit
  //     this.highestProgress = Math.max(this.highestProgress, progressPercent);

  //     // Dynamic pullback threshold still works the same way
  //     // As price goes higher (even beyond 100%), pullback threshold increases
  //     const dynamicPullbackThreshold = Math.max(0, this.highestProgress - 0.20);

  //     // Stop loss check remains the same
  //     const originalStopLossHit = direction === "long" ? currentPrice <= stopLossPrice : currentPrice >= stopLossPrice;
  //     if (originalStopLossHit) {
  //       logger.info(`[${this.symbol}] Stop loss hit, closing position`);
  //       await this.closePosition();
  //       return;
  //     }

  //     // Enhanced logging to better show progress beyond 100%
  //     if (this.lastCheckedPrice !== currentPrice) {
  //       console.log(`[${this.symbol}] Position progress:`, {
  //         direction: direction === "long" ? "LONG" : "SHORT",
  //         entryPrice: entryPrice.toFixed(4),
  //         currentPrice: currentPrice.toFixed(4),
  //         stopLossPrice: stopLossPrice.toFixed(4),
  //         takeProfitPrice: takeProfitPrice.toFixed(4),
  //         progress: (progressPercent * 100).toFixed(2) + "%",
  //         hasReachedThreshold: this.hasReachedThreshold,
  //         highestProgress: (this.highestProgress * 100).toFixed(2) + "%",
  //         pullbackThreshold: (dynamicPullbackThreshold * 100).toFixed(2) + "%",
  //         thresholdHits: this.thresholdHits,
  //         beyondTakeProfit: progressPercent > 1.0 ? `${((progressPercent - 1.0) * 100).toFixed(2)}% beyond TP` : 'No'
  //       });
  //       this.lastCheckedPrice = currentPrice;
  //     }

  //     // Initial threshold check remains at 30%
  //     if (progressPercent >= 0.30) {
  //       this.hasReachedThreshold = true;
  //     }

  //     // Position close logic now only checks pullback threshold
  //     if (this.hasReachedThreshold) {
  //       // Only close if we drop below dynamic pullback threshold
  //       if (progressPercent <= dynamicPullbackThreshold) {
  //         this.thresholdHits++;
          
  //         logger.info(`[${this.symbol}] Threshold hit detected:`, {
  //           hits: this.thresholdHits,
  //           currentProgress: (progressPercent * 100).toFixed(2) + "%",
  //           highestProgress: (this.highestProgress * 100).toFixed(2) + "%",
  //           pullbackThreshold: (dynamicPullbackThreshold * 100).toFixed(2) + "%",
  //           beyondTakeProfit: progressPercent > 1.0 ? `${((progressPercent - 1.0) * 100).toFixed(2)}% beyond TP` : 'No'
  //         });

  //         if (this.thresholdHits >= 2) {
  //           logger.info(`[${this.symbol}] Closing position:`, {
  //             reason: "Dynamic pullback threshold hit",
  //             hits: this.thresholdHits,
  //             currentProgress: (progressPercent * 100).toFixed(2) + "%",
  //             highestProgress: (this.highestProgress * 100).toFixed(2) + "%",
  //             pullbackThreshold: (dynamicPullbackThreshold * 100).toFixed(2) + "%",
  //             beyondTakeProfit: progressPercent > 1.0 ? `${((progressPercent - 1.0) * 100).toFixed(2)}% beyond TP` : 'No'
  //           });
  //           await this.closePosition();
  //           return;
  //         }
  //       } else {
  //         this.thresholdHits = 0;
  //       }
  //     }
  //   } catch (error) {
  //     logger.error(`[${this.symbol}] Error in position monitoring:`, error);
  //   }
  // }



  async closePosition() {
    // Prevent concurrent close attempts
    if (this.isClosing) {
      logger.info(`[${this.symbol}] Already attempting to close position`);
      return false;
    }

    this.isClosing = true;
    try {
      // Attempt to close the position
      await execAsync(
        `node src/manage-position.js close ${this.symbol} ${this.direction}`,
        { maxBuffer: 1024 * 1024 * 10 }
      );
      
      logger.info(`[${this.symbol}] Waiting 15s before verifying closure`);
      await utils.sleep(15000);

      // Verify closure with retries
      for (let attempt = 1; attempt <= 3; attempt++) {
        const position = await this.zetaWrapper.getPosition(this.marketIndex);
        
        if (!position || position.size === 0) {
          logger.info(`[${this.symbol}] Position closure verified`);
          this.stopMonitoring();
          return true;
        }

        if (attempt < 3) {
          logger.warn(`[${this.symbol}] Position still exists, attempt ${attempt}/3`);
          await utils.sleep(5000);
        }
      }
      
      logger.error(`[${this.symbol}] Failed to verify position closure after 3 attempts`);
      return false;

    } catch (error) {
      logger.error(`[${this.symbol}] Error closing position:`, error);
      return false;
    } finally {
      // Always reset the closing flag
      this.isClosing = false;
    }
  }
  
  // 12/20/24 replaced with above
  // ****************************
  // async closePosition() {
  //   try {
  //     await execAsync(`node src/manage-position.js close ${this.symbol} ${this.direction}`, { maxBuffer: 1024 * 1024 * 10 });
  //     console.log("Waiting 15s before continuing");
  //     await utils.sleep(15000);
  //     this.stopMonitoring();
  //   } catch (error) {
  //     logger.error(`[${this.symbol}] Failed to close position:`, error);
  //   }
  // }



  stopMonitoring() {
    if (this.positionMonitorInterval) {
      clearInterval(this.positionMonitorInterval);
      this.positionMonitorInterval = null;
    }
    this.hasReachedThreshold = false;
    this.highestProgress = 0;
    this.thresholdHits = 0;
    this.isClosing = false;
    logger.info(`[${this.symbol}] Stopped monitoring`);
  }

  // 12/20/24 replaced with above
  // ****************************
  // stopMonitoring() {
  //   if (this.positionMonitorInterval) {
  //     clearInterval(this.positionMonitorInterval);
  //     this.positionMonitorInterval = null;
  //   }
  //   this.hasReachedThreshold = false;
  //   this.highestProgress = 0;
  //   this.thresholdHits = 0;
  //   logger.info(`[${this.symbol}] Stopped monitoring`);
  // }

	shutdown() {
		this.stopMonitoring();
		logger.info(`[${this.symbol}] Manager shutdown complete`);
	}
}

class DirectionalTradingManager {
	constructor(direction, symbols) {
		this.direction = direction;
		this.symbols = symbols;
		this.symbolManagers = new Map();
		this.isProcessing = false;
		this.zetaWrapper = null;
	}

	async initialize() {
		try {
			logger.info(`[INIT] Initializing ${this.direction} trading manager for:`, this.symbols);

			this.zetaWrapper = new ZetaClientWrapper();
			const keypairPath = this.direction === "long" ? process.env.KEYPAIR_FILE_PATH_LONG : process.env.KEYPAIR_FILE_PATH_SHORT;
			const marketIndices = this.symbols.map((symbol) => constants.Asset[symbol]);

			await this.zetaWrapper.initialize(marketIndices, keypairPath);
			logger.info(
				`[INIT] ZetaWrapper initialized for ${this.direction} trading with markets:`,
				marketIndices.map((idx) => constants.Asset[idx])
			);

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
			logger.info(`[${this.direction}] Ignoring ${signalDirection} signal`);
			return;
		}

		if (this.isProcessing) {
			logger.info(`[${this.direction}] Already processing signal, queued for next cycle`);
			return;
		}

		this.isProcessing = true;
		try {
			const manager = this.symbolManagers.get(signalData.symbol);
			if (!manager) {
				logger.info(`[${this.direction}] No manager found for ${signalData.symbol}`);
				return;
			}

			// Check for position and start monitoring if found
			const position = await manager.zetaWrapper.getPosition(manager.marketIndex);
			if (position && position.size !== 0 && !manager.positionMonitorInterval) {
				logger.info(`[${signalData.symbol}] Found unmonitored position, starting monitoring`);
				manager.startPositionMonitor();
			}

			await manager.processSignal(signalData);
		} catch (error) {
			logger.error(`[${this.direction}] Error processing signal:`, error);
		} finally {
			this.isProcessing = false;
		}
	}

	async checkExistingPositions() {
		logger.info(`[INIT] Checking existing ${this.direction} positions for symbols:`, this.symbols);

		for (const [symbol, manager] of this.symbolManagers) {
			try {
				const marketIndex = constants.Asset[symbol];
				const position = await manager.zetaWrapper.getPosition(marketIndex);

				if (position && position.size !== 0) {
					const positionDirection = position.size > 0 ? "long" : "short";
					if (positionDirection === this.direction) {
						logger.info(`[INIT] Found existing ${this.direction} position for ${symbol}`, {
							size: position.size,
							entryPrice: position.costOfTrades ? (position.costOfTrades / position.size).toFixed(4) : "N/A",
						});
						manager.startPositionMonitor();
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
		logger.info(`[SHUTDOWN] Shutting down ${this.direction} trading manager`);
		for (const manager of this.symbolManagers.values()) {
			manager.shutdown();
		}
		this.zetaWrapper = null;
	}
}

class MultiTradingManager {
	constructor() {
		this.longManager = null;
		this.shortManager = null;
		this.symbols = [];
		this.ws = null;
		this.reconnectAttempts = 0;
		this.maxReconnectAttempts = 5;
		this.connectionActive = false;
		this.messageQueue = [];
		this.isProcessingQueue = false;
		this.healthCheckInterval = null;
	}

	async initialize(symbols) {
		try {
			this.symbols = symbols;
			logger.info("[INIT] Initializing Multi-Trading Manager", {
				symbols: this.symbols,
				longWallet: process.env.KEYPAIR_FILE_PATH_LONG,
				shortWallet: process.env.KEYPAIR_FILE_PATH_SHORT,
			});

			this.longManager = new DirectionalTradingManager("long", this.symbols);
			await this.longManager.initialize();

			this.shortManager = new DirectionalTradingManager("short", this.symbols);
			await this.shortManager.initialize();

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

	setupWebSocket() {
		if (this.ws) {
			this.ws.terminate();
		}

		this.ws = new WebSocket(`ws://${WS_HOST}:${WS_PORT}?apiKey=${API_KEY}`);

		this.ws.on("open", () => {
			this.connectionActive = true;
			this.reconnectAttempts = 0;
			logger.info("[WS] Connected to signal stream");

			this.symbols.forEach((symbol) => {
				this.ws.send(
					JSON.stringify({
						type: "subscribe",
						symbol,
						direction: "long",
					})
				);

				this.ws.send(
					JSON.stringify({
						type: "subscribe",
						symbol,
						direction: "short",
					})
				);

				logger.info(`[WS] Subscribed to ${symbol} signals for both directions`);
			});
		});

		this.ws.on("message", async (data) => {
			try {
				const signalData = JSON.parse(data.toString());

				if (signalData.type === "connection") {
					logger.info("[WS] Server acknowledged connection:", {
						availableSymbols: signalData.symbols,
					});
					return;
				}

				if (!this.symbols.includes(signalData.symbol)) {
					return;
				}

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

		this.ws.on("error", (error) => {
			logger.error("[WS] WebSocket error:", error.message);
			this.connectionActive = false;
		});

		this.ws.on("close", (code, reason) => {
			this.connectionActive = false;
			logger.info(`[WS] Connection closed (${code}): ${reason}`);

			if (this.reconnectAttempts < this.maxReconnectAttempts) {
				this.reconnect();
			} else {
				logger.error("[WS] Max reconnection attempts reached");
			}
		});
	}

	async processMessageQueue() {
		if (this.isProcessingQueue) return;
		this.isProcessingQueue = true;

		try {
			while (this.messageQueue.length > 0) {
				const signalData = this.messageQueue.shift();

				if (!signalData?.symbol || signalData.direction === undefined) {
					logger.info("[QUEUE] Skipping invalid message:", signalData);
					continue;
				}

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

	reconnect() {
		if (this.reconnectAttempts < this.maxReconnectAttempts) {
			this.reconnectAttempts++;
			logger.info(`[WS] Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
			setTimeout(() => this.setupWebSocket(), MONITORING_INTERVALS.RECONNECT_DELAY);
		}
	}

	setupHealthCheck() {
		this.healthCheckInterval = setInterval(() => {
			if (!this.connectionActive) {
				logger.info("[HEALTH] WebSocket disconnected, attempting reconnect");
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

	shutdown() {
		logger.info("[SHUTDOWN] Initiating graceful shutdown");
		clearInterval(this.healthCheckInterval);

		if (this.ws) {
			this.ws.close();
		}

		this.longManager.shutdown();
		this.shortManager.shutdown();

		logger.info("[SHUTDOWN] Shutdown complete");
	}
}

async function main() {
	try {
		const tradingSymbols = validateConfig();
		logger.info("[INIT] Starting Multi-Symbol Trading System", {
			symbols: tradingSymbols,
		});

		const marketIndices = tradingSymbols.map((symbol) => constants.Asset[symbol]);
		const { connection } = await initializeExchange(marketIndices);

		const multiManager = new MultiTradingManager();
		await multiManager.initialize(tradingSymbols);

		process.on("SIGINT", () => {
			logger.info("[SHUTDOWN] Graceful shutdown initiated");
			multiManager.shutdown();
			process.exit(0);
		});

		process.on("SIGTERM", () => {
			logger.info("[SHUTDOWN] Graceful shutdown initiated");
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

main().catch((error) => {
	logger.error("[MAIN] Unhandled error:", error);
	process.exit(1);
});
