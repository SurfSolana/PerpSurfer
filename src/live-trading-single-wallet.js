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

// System-wide configuration settings
const CONFIG = {
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
		healthCheck: 300000, // System health check interval (5 minutes)
		statusUpdate: 3600000, // Status update interval (1 hour)
	},

	// Position management settings
	position: {
		// Initial threshold that triggers trailing stop monitoring (40%)
		initialThreshold: 0.33,

		// How much price can pull back from highest progress before closing (15%)
		pullbackAmount: 0.13,

		// Number of consecutive threshold hits needed to close position
		thresholdHitCount: 3,

		// Time to wait after position actions (milliseconds)
		waitAfterAction: 10000,

		// How often to check position progress
		monitorInterval: 1000,
	},

	// Trading assets configuration
	tradingAssets: ["SOL", "BTC", "ETH"],

	// Required environment variables
	requiredEnvVars: ["KEYPAIR_FILE_PATH", "WS_API_KEY", "RPC_TRADINGBOT"],
};

function validateConfig() {
	// Check required environment variables
	const missingVars = CONFIG.requiredEnvVars.filter((envVar) => !process.env[envVar]);
	if (missingVars.length > 0) {
		logger.error(`[INIT] Missing required environment variables: ${missingVars.join(", ")}`);
		process.exit(1);
	}

	// Verify wallet file exists
	if (!fs.existsSync(process.env.KEYPAIR_FILE_PATH)) {
		logger.error("[INIT] Wallet file not found");
		process.exit(1);
	}

	// Validate trading symbols
	const invalidSymbols = CONFIG.tradingAssets.filter((symbol) => !ASSETS.includes(constants.Asset[symbol]));
	if (invalidSymbols.length > 0) {
		logger.error(`[INIT] Invalid trading symbols found: ${invalidSymbols.join(", ")}`);
		process.exit(1);
	}

	return CONFIG.tradingAssets;
}

class SymbolTradingManager {
	constructor(marketIndex, zetaWrapper) {
		this.marketIndex = marketIndex;
		this.symbol = constants.Asset[marketIndex];
		this.zetaWrapper = zetaWrapper;

		// Position monitoring state
		this.positionMonitorInterval = null;
		this.lastCheckedPrice = null;

		// Progress tracking properties
		this.hasReachedThreshold = false;
		this.highestProgress = 0;
		this.thresholdHits = 0;

		// Position management state
		this.isClosing = false;
		this.currentDirection = null; // 'long' or 'short'
	}
 /*
	async processSignal(signalData) {
    const currentPosition = await this.zetaWrapper.getPosition(this.marketIndex);

    if (signalData.signal !== 0) {
        const marketConditions = await getMarketSentiment();
        
        logger.info(`[${this.symbol}] Trading Analysis:`, {
            incomingSignal: {
                type: signalData.signal === 1 ? "LONG" : signalData.signal === -1 ? "SHORT" : "NO SIGNAL",
                value: signalData.signal,
            },
            marketSentiment: {
                sentiment: marketConditions.sentiment,
                index: marketConditions.index,
                allowsLong: marketConditions.canOpenLong,
                allowsShort: marketConditions.canOpenShort,
            },
            existingPosition:
                currentPosition && currentPosition.size !== 0
                    ? {
                            direction: currentPosition.size > 0 ? "LONG" : "SHORT",
                            size: currentPosition.size,
                            entryPrice: (currentPosition.costOfTrades / currentPosition.size).toFixed(4),
                      }
                    : "No position",
            analysis:
                currentPosition && currentPosition.size !== 0
                    ? `Have ${currentPosition.size > 0 ? "LONG" : "SHORT"} position while receiving ${
                            signalData.signal === 1 ? "LONG" : signalData.signal === -1 ? "SHORT" : "NO SIGNAL"
                      } signal in ${marketConditions.sentiment} market`
                    : `No position while receiving ${
                            signalData.signal === 1 ? "LONG" : signalData.signal === -1 ? "SHORT" : "NO SIGNAL"
                      } signal in ${marketConditions.sentiment} market`,
        });
    }

    // Always check and resume monitoring if needed
    if (currentPosition && currentPosition.size !== 0) {
        const existingDirection = currentPosition.size > 0 ? "long" : "short";

        if (!this.positionMonitorInterval) {
            logger.info(`[${this.symbol}] Found unmonitored ${existingDirection} position during signal processing`, {
                size: currentPosition.size,
                entryPrice: (currentPosition.costOfTrades / currentPosition.size).toFixed(4),
            });

            this.currentDirection = existingDirection;
            this.startPositionMonitor();
        }
        return;
    }

    if (signalData.signal === 0) return;

    const marketConditions = await getMarketSentiment();
    const isLongSignal = signalData.signal === 1;
    const direction = isLongSignal ? "long" : "short";

    if (!(isLongSignal && marketConditions.canOpenLong) && !(!isLongSignal && marketConditions.canOpenShort)) {
        logger.info(`[${this.symbol}] Skipping position due to market sentiment`, {
            attemptedDirection: direction,
            marketSentiment: marketConditions.sentiment,
            sentimentIndex: marketConditions.index,
        });
        return;
    }

    logger.info(`[${this.symbol}] Opening ${direction} position based on signal and market sentiment`, {
        direction,
        marketSentiment: marketConditions.sentiment,
        sentimentIndex: marketConditions.index,
    });

    // Try to open position, but always verify state after
    try {
        await execAsync(`node src/manage-position-single-wallet.js open ${this.symbol} ${direction}`, {
            maxBuffer: 1024 * 1024 * 32,
        });
    } catch (error) {
        logger.error(`[${this.symbol}] Position open command failed, verifying position state:`, error);
    }

    logger.info(`[${this.symbol}] Waiting ${CONFIG.position.waitAfterAction}ms before verifying`);
    await utils.sleep(CONFIG.position.waitAfterAction);

    // Always verify position state and resume monitoring if needed
    const verifyPosition = await this.zetaWrapper.getPosition(this.marketIndex);
    if (verifyPosition && verifyPosition.size !== 0) {
        const actualDirection = verifyPosition.size > 0 ? "long" : "short";
        logger.info(`[${this.symbol}] Found active ${actualDirection} position after operation`, {
            size: verifyPosition.size,
            entryPrice: (verifyPosition.costOfTrades / verifyPosition.size).toFixed(4),
        });

        this.currentDirection = actualDirection;
        this.startPositionMonitor();
    }
}
*/

async processSignal(signalData) {
    // First get current position state
    const currentPosition = await this.zetaWrapper.getPosition(this.marketIndex);

    // Only fetch market conditions and log analysis if we have a signal
    if (signalData.signal !== 0) {
        const marketConditions = await getMarketSentiment();
        
        // Log detailed analysis of current state
        logger.info(`[${this.symbol}] Trading Analysis:`, {
            incomingSignal: {
                type: signalData.signal === 1 ? "LONG" : signalData.signal === -1 ? "SHORT" : "NO SIGNAL",
                value: signalData.signal,
            },
            marketSentiment: {
                sentiment: marketConditions.sentiment,
                index: marketConditions.index,
                allowsLong: marketConditions.canOpenLong,
                allowsShort: marketConditions.canOpenShort,
            },
            existingPosition:
                currentPosition && currentPosition.size !== 0
                    ? {
                            direction: currentPosition.size > 0 ? "LONG" : "SHORT",
                            size: currentPosition.size,
                            entryPrice: (currentPosition.costOfTrades / currentPosition.size).toFixed(4),
                      }
                    : "No position",
            analysis:
                currentPosition && currentPosition.size !== 0
                    ? `Have ${currentPosition.size > 0 ? "LONG" : "SHORT"} position while receiving ${
                            signalData.signal === 1 ? "LONG" : signalData.signal === -1 ? "SHORT" : "NO SIGNAL"
                      } signal in ${marketConditions.sentiment} market`
                    : `No position while receiving ${
                            signalData.signal === 1 ? "LONG" : signalData.signal === -1 ? "SHORT" : "NO SIGNAL"
                      } signal in ${marketConditions.sentiment} market`,
        });
    }

    // Position management section
    if (currentPosition && currentPosition.size !== 0) {
        const existingDirection = currentPosition.size > 0 ? "long" : "short";

        // Only check extreme conditions if we have a signal
        if (signalData.signal !== 0) {
            const isLongPosition = currentPosition.size > 0;
            const isExtremeGreed = marketConditions.sentiment === "EXTREME GREED";
            const isExtremeFear = marketConditions.sentiment === "EXTREME FEAR";

            // Check if position needs to be closed due to extreme opposite market conditions
            // Close SHORT if EXTREME GREED or LONG if EXTREME FEAR
            if ((isExtremeGreed && !isLongPosition) || (isExtremeFear && isLongPosition)) {
                logger.info(`[${this.symbol}] Closing position due to extreme opposite market sentiment`, {
                    positionType: isLongPosition ? "LONG" : "SHORT",
                    marketSentiment: marketConditions.sentiment,
                    reason: "Extreme opposite market sentiment"
                });

                const closed = await this.closePosition("Extreme opposite market sentiment");
                
                if (closed) {
                    logger.info(`[${this.symbol}] Position closed due to extreme market conditions`);
                    
                    // If signal matches the extreme sentiment direction, open new position
                    // LONG signal in EXTREME GREED or SHORT signal in EXTREME FEAR
                    if ((isExtremeGreed && signalData.signal === 1) || (isExtremeFear && signalData.signal === -1)) {
                        const newDirection = signalData.signal === 1 ? "long" : "short";
                        logger.info(`[${this.symbol}] Opening ${newDirection} position after closure due to matching signal and market sentiment`);
                        
                        try {
                            await execAsync(`node src/manage-position-single-wallet.js open ${this.symbol} ${newDirection}`, {
                                maxBuffer: 1024 * 1024 * 32,
                            });
                        } catch (error) {
                            logger.error(`[${this.symbol}] Position open command failed, verifying position state:`, error);
                        }

                        logger.info(`[${this.symbol}] Waiting ${CONFIG.position.waitAfterAction}ms before verifying`);
                        await utils.sleep(CONFIG.position.waitAfterAction);

                        const newPosition = await this.zetaWrapper.getPosition(this.marketIndex);
                        if (newPosition && newPosition.size !== 0) {
                            this.currentDirection = newDirection;
                            this.startPositionMonitor();
                        }
                    }
                }
                return;
            }
        }

        // Monitor existing position if not already monitoring
        if (!this.positionMonitorInterval) {
            logger.info(`[${this.symbol}] Found unmonitored ${existingDirection} position during signal processing`, {
                size: currentPosition.size,
                entryPrice: (currentPosition.costOfTrades / currentPosition.size).toFixed(4),
            });

            this.currentDirection = existingDirection;
            this.startPositionMonitor();
        }
        return;
    }

    // Exit if no signal to process
    if (signalData.signal === 0) return;

    // Process potential new position based on signal
    const marketConditions = await getMarketSentiment();
    const isLongSignal = signalData.signal === 1;
    const direction = isLongSignal ? "long" : "short";

    // Check if market conditions allow the signal direction
    if (!(isLongSignal && marketConditions.canOpenLong) && !(!isLongSignal && marketConditions.canOpenShort)) {
        logger.info(`[${this.symbol}] Skipping position due to market sentiment`, {
            attemptedDirection: direction,
            marketSentiment: marketConditions.sentiment,
            sentimentIndex: marketConditions.index,
        });
        return;
    }

    // Proceed with opening new position
    logger.info(`[${this.symbol}] Opening ${direction} position based on signal and market sentiment`, {
        direction,
        marketSentiment: marketConditions.sentiment,
        sentimentIndex: marketConditions.index,
    });

    // Try to open position
    try {
        await execAsync(`node src/manage-position-single-wallet.js open ${this.symbol} ${direction}`, {
            maxBuffer: 1024 * 1024 * 32,
        });
    } catch (error) {
        logger.error(`[${this.symbol}] Position open command failed, verifying position state:`, error);
    }

    logger.info(`[${this.symbol}] Waiting ${CONFIG.position.waitAfterAction}ms before verifying`);
    await utils.sleep(CONFIG.position.waitAfterAction);

    // Verify position was opened and start monitoring
    const verifyPosition = await this.zetaWrapper.getPosition(this.marketIndex);
    if (verifyPosition && verifyPosition.size !== 0) {
        const actualDirection = verifyPosition.size > 0 ? "long" : "short";
        logger.info(`[${this.symbol}] Found active ${actualDirection} position after operation`, {
            size: verifyPosition.size,
            entryPrice: (verifyPosition.costOfTrades / verifyPosition.size).toFixed(4),
        });

        this.currentDirection = actualDirection;
        this.startPositionMonitor();
    }
}

async closePosition(reason = "") {
    if (this.isClosing) {
        logger.info(`[${this.symbol}] Already attempting to close position`);
        return false;
    }

    this.isClosing = true;
    const position = await this.zetaWrapper.getPosition(this.marketIndex);
    
    if (!position || position.size === 0) {
        logger.info(`[${this.symbol}] No position found to close`);
        this.stopMonitoring();
        this.isClosing = false;
        return true;
    }

    const currentPrice = this.zetaWrapper.getCalculatedMarkPrice(this.marketIndex);
    const entryPrice = Math.abs(position.costOfTrades / position.size);
    const realizedPnl = position.size > 0 ? 
        (currentPrice - entryPrice) / entryPrice : 
        (entryPrice - currentPrice) / entryPrice;

    try {
        await execAsync(`node src/manage-position-single-wallet.js close ${this.symbol} ${this.currentDirection}`, {
            maxBuffer: 1024 * 1024 * 32,
        });
    } catch (error) {
        logger.error(`[${this.symbol}] Position close command failed, verifying position state:`, error);
    }

    logger.info(`[${this.symbol}] Waiting ${CONFIG.position.waitAfterAction}ms before verifying`);
    await utils.sleep(CONFIG.position.waitAfterAction);

    // Verify final position state
    const verifyPosition = await this.zetaWrapper.getPosition(this.marketIndex);
    
    if (!verifyPosition || verifyPosition.size === 0) {
        logger.info(`[${this.symbol}] Position closure verified`);

        logger.addClosedPosition({
            symbol: this.symbol,
            size: position.size,
            entryPrice,
            exitPrice: currentPrice,
            realizedPnl,
            reason,
        });

        this.stopMonitoring();
        this.isClosing = false;
        return true;
    }

    // Position still exists, resume monitoring
    logger.warn(`[${this.symbol}] Position still active after close attempt, resuming monitoring`, {
        size: verifyPosition.size,
        entryPrice: (verifyPosition.costOfTrades / verifyPosition.size).toFixed(4),
    });

    if (!this.positionMonitorInterval) {
        const direction = verifyPosition.size > 0 ? "long" : "short";
        this.currentDirection = direction;
        this.startPositionMonitor();
    }

    this.isClosing = false;
    return false;
}

	async startPositionMonitor() {
		if (this.positionMonitorInterval) {
			clearInterval(this.positionMonitorInterval);
		}

		this.hasReachedThreshold = false;
		this.highestProgress = 0;
		this.thresholdHits = 0;

		this.positionMonitorInterval = setInterval(() => this.monitorPosition(), CONFIG.position.monitorInterval);

		logger.info(`[${this.symbol}] Started position monitoring`);
		await utils.sleep(500);
	}

	async monitorPosition() {
		try {
			if (this.isClosing) return;

			const currentPosition = await this.zetaWrapper.getPosition(this.marketIndex);

			if (!currentPosition || currentPosition.size === 0) {
				this.stopMonitoring();
				// await execAsync(`node src/cancel-trigger-orders.js cancel ${this.symbol} ${this.currentDirection}`, {
				// 	maxBuffer: 1024 * 1024 * 10,
				// });
				// logger.info(`[${this.symbol}] Waiting ${CONFIG.position.waitAfterAction}ms before continuing`);
				// await utils.sleep(CONFIG.position.waitAfterAction);
				return;
			}

			const settings = await this.zetaWrapper.fetchSettings();
			const direction = currentPosition.size > 0 ? "long" : "short";
			const entryPrice = Math.abs(currentPosition.costOfTrades / currentPosition.size);
			const currentPrice = this.zetaWrapper.getCalculatedMarkPrice(this.marketIndex);

			const { takeProfitPrice, stopLossPrice } = this.zetaWrapper.calculateTPSLPrices(direction, entryPrice, settings);

			const totalDistanceToTP = Math.abs(takeProfitPrice - entryPrice);
			const currentProgress = direction === "long" ? currentPrice - entryPrice : entryPrice - currentPrice;
			const progressPercent = currentProgress / totalDistanceToTP;

			this.highestProgress = Math.max(this.highestProgress, progressPercent);
			const dynamicPullbackThreshold = Math.max(0, this.highestProgress - CONFIG.position.pullbackAmount);

			const stopLossHit = direction === "long" ? currentPrice <= stopLossPrice : currentPrice >= stopLossPrice;

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
					beyondTakeProfit: progressPercent > 1.0 ? `${((progressPercent - 1.0) * 100).toFixed(2)}% beyond TP` : "No",
				});
				this.lastCheckedPrice = currentPrice;
			}

			if (stopLossHit) {
				logger.info(`[${this.symbol}] Stop loss hit, attempting to close position`);
				const closed = await this.closePosition("Stop loss hit");
				if (!closed) {
					logger.warn(`[${this.symbol}] Stop loss closure failed - will retry on next monitor cycle`);
				}
				return;
			}

			if (progressPercent >= CONFIG.position.initialThreshold) {
				this.hasReachedThreshold = true;
			}

			if (this.hasReachedThreshold) {
				if (progressPercent <= dynamicPullbackThreshold) {
					this.thresholdHits++;

					logger.info(`[${this.symbol}] Threshold hit detected:`, {
						hits: this.thresholdHits,
						currentProgress: (progressPercent * 100).toFixed(2) + "%",
						highestProgress: (this.highestProgress * 100).toFixed(2) + "%",
						pullbackThreshold: (dynamicPullbackThreshold * 100).toFixed(2) + "%",
						beyondTakeProfit: progressPercent > 1.0 ? `${((progressPercent - 1.0) * 100).toFixed(2)}% beyond TP` : "No",
					});

					if (this.thresholdHits >= CONFIG.position.thresholdHitCount) {
						logger.info(`[${this.symbol}] Attempting to close position:`, {
							reason: "Dynamic pullback threshold hit",
							hits: this.thresholdHits,
							currentProgress: (progressPercent * 100).toFixed(2) + "%",
							highestProgress: (this.highestProgress * 100).toFixed(2) + "%",
							pullbackThreshold: (dynamicPullbackThreshold * 100).toFixed(2) + "%",
						});

						const closed = await this.closePosition("Dynamic pullback threshold hit");
						if (!closed) {
							logger.warn(`[${this.symbol}] Pullback closure failed - will retry on next monitor cycle`);
						}
						return;
					}
				} else {
					this.thresholdHits = 0;
				}
			}
		} catch (error) {
			logger.error(`[${this.symbol}] Error in position monitoring:`, error);
		}
	}

	stopMonitoring() {
		if (this.positionMonitorInterval) {
			clearInterval(this.positionMonitorInterval);
			this.positionMonitorInterval = null;
		}
		this.hasReachedThreshold = false;
		this.highestProgress = 0;
		this.thresholdHits = 0;
		this.isClosing = false;
		this.currentDirection = null;
		logger.info(`[${this.symbol}] Stopped monitoring`);
	}

	shutdown() {
		this.stopMonitoring();
		logger.info(`[${this.symbol}] Manager shutdown complete`);
	}
}

class TradingManager {
	constructor() {
		this.symbolManagers = new Map();
		this.ws = null;
		this.reconnectAttempts = 0;
		this.connectionActive = false;
		this.messageQueue = [];
		this.isProcessingQueue = false;
		this.healthCheckInterval = null;
		this.statusUpdateInterval = null;
		this.zetaWrapper = null;
		this.connection = null; // Add connection property
	}

	async initialize(symbols) {
		try {
			logger.info("[INIT] Initializing Trading Manager", {
				symbols,
				wallet: process.env.KEYPAIR_FILE_PATH,
			});

			// Initialize Exchange first
			this.connection = new Connection(process.env.RPC_TRADINGBOT);
			const marketsToLoad = new Set([constants.Asset.SOL, ...symbols.map((s) => constants.Asset[s])]);
			const marketsArray = Array.from(marketsToLoad);

			const loadExchangeConfig = types.defaultLoadExchangeConfig(
				Network.MAINNET,
				this.connection,
				{
					skipPreflight: true,
					preflightCommitment: "confirmed",
					commitment: "confirmed",
				},
				500,
				true,
				this.connection,
				marketsArray,
				undefined,
				marketsArray
			);

			await Exchange.load(loadExchangeConfig);
			logger.info("[INIT] Exchange loaded successfully");

			// Initialize ZetaWrapper
			this.zetaWrapper = new ZetaClientWrapper();
			const marketIndices = symbols.map((symbol) => constants.Asset[symbol]);
			await this.zetaWrapper.initialize(marketIndices, process.env.KEYPAIR_FILE_PATH);

			// Rest of initialization remains the same...
			for (const symbol of symbols) {
				const marketIndex = constants.Asset[symbol];
				const manager = new SymbolTradingManager(marketIndex, this.zetaWrapper);
				this.symbolManagers.set(symbol, manager);
			}

			logger.info("[INIT] Checking existing positions");
			await this.checkExistingPositions();

			this.setupWebSocket();
			this.setupHealthCheck();
			this.setupStatusUpdates();

			logger.info("[INIT] Trading system initialized successfully", {
				symbols,
				timestamp: new Date().toISOString(),
			});
		} catch (error) {
			logger.error("[INIT] Critical initialization error:", error);
			throw error;
		}
	}

	async checkExistingPositions() {
		for (const [symbol, manager] of this.symbolManagers) {
			try {
				const position = await manager.zetaWrapper.getPosition(manager.marketIndex);

				if (position && position.size !== 0) {
					const direction = position.size > 0 ? "long" : "short";
					manager.currentDirection = direction;

					logger.info(`[${symbol}] Found existing position`, {
						direction,
						size: position.size,
						entryPrice: position.costOfTrades ? (position.costOfTrades / position.size).toFixed(4) : "N/A",
					});

					manager.startPositionMonitor();
				} else {
					logger.info(`[${symbol}] No existing position found`);
				}
			} catch (error) {
				logger.error(`[INIT] Error checking ${symbol} position:`, error);
			}
		}
	}

	setupWebSocket() {
		if (this.ws) {
			this.ws.terminate();
		}

		this.ws = new WebSocket(`ws://${CONFIG.ws.host}:${CONFIG.ws.port}?apiKey=${process.env.WS_API_KEY}`);

		this.ws.on("open", () => {
			this.connectionActive = true;
			this.reconnectAttempts = 0;
			logger.info("[WS] Connected to signal stream");

			// Subscribe to both directions for all symbols
			for (const symbol of this.symbolManagers.keys()) {
				["long", "short"].forEach((direction) => {
					this.ws.send(
						JSON.stringify({
							type: "subscribe",
							symbol,
							direction,
						})
					);
				});
				logger.info(`[WS] Subscribed to ${symbol} signals for both directions`);
			}
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

				if (!this.symbolManagers.has(signalData.symbol)) {
					return;
				}

				if (this.messageQueue.length >= CONFIG.ws.messageQueueSize) {
					logger.info("[WS] Queue full, dropping oldest message");
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

			if (this.reconnectAttempts < CONFIG.ws.maxReconnectAttempts) {
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

				const manager = this.symbolManagers.get(signalData.symbol);
				if (!manager) continue;

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
		if (this.reconnectAttempts < CONFIG.ws.maxReconnectAttempts) {
			this.reconnectAttempts++;
			logger.info(`[WS] Attempting reconnection ${this.reconnectAttempts}/${CONFIG.ws.maxReconnectAttempts}`);
			setTimeout(() => this.setupWebSocket(), CONFIG.ws.reconnectDelay);
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
		}, CONFIG.intervals.healthCheck);
	}

	setupStatusUpdates() {
		this.sendStatusUpdate(true);

		this.statusUpdateInterval = setInterval(async () => this.sendStatusUpdate(false), CONFIG.intervals.statusUpdate);
	}

	async sendStatusUpdate(isStartup = false) {
		try {
			const positions = [];

			for (const [symbol, manager] of this.symbolManagers) {
				const position = await manager.zetaWrapper.getPosition(manager.marketIndex);

				if (position && position.size !== 0) {
					const currentPrice = manager.zetaWrapper.getCalculatedMarkPrice(manager.marketIndex);
					const entryPrice = Math.abs(position.costOfTrades / position.size);
					const settings = await manager.zetaWrapper.fetchSettings();
					const direction = position.size > 0 ? "long" : "short";

					const { takeProfitPrice, stopLossPrice } = manager.zetaWrapper.calculateTPSLPrices(direction, entryPrice, settings);

					const progress =
						direction === "long"
							? (currentPrice - entryPrice) / (takeProfitPrice - entryPrice)
							: (entryPrice - currentPrice) / (entryPrice - takeProfitPrice);

					const unrealizedPnl =
						direction === "long" ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice;

					positions.push({
						symbol,
						size: position.size,
						entryPrice,
						currentPrice,
						progress,
						unrealizedPnl,
						stopLoss: stopLossPrice,
						takeProfit: takeProfitPrice,
						hasReachedThreshold: progress >= CONFIG.position.initialThreshold,
					});
				}
			}

			await logger.sendHourlyUpdate(positions, isStartup);
		} catch (error) {
			logger.error("[STATUS] Error sending status update:", error);
		}
	}

	shutdown() {
		logger.info("[SHUTDOWN] Initiating graceful shutdown");
		clearInterval(this.healthCheckInterval);
		clearInterval(this.statusUpdateInterval);

		if (this.ws) {
			this.ws.close();
		}

		for (const manager of this.symbolManagers.values()) {
			manager.shutdown();
		}

		logger.info("[SHUTDOWN] Shutdown complete");
	}
}

async function main() {
	try {
		const tradingSymbols = validateConfig();
		logger.info("[INIT] Starting Trading System", {
			symbols: tradingSymbols,
		});

		const tradingManager = new TradingManager();
		await tradingManager.initialize(tradingSymbols);

		process.on("SIGINT", () => {
			logger.info("[SHUTDOWN] Graceful shutdown initiated");
			tradingManager.shutdown();
			process.exit(0);
		});

		process.on("SIGTERM", () => {
			logger.info("[SHUTDOWN] Graceful shutdown initiated");
			tradingManager.shutdown();
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
