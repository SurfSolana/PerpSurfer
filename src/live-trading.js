import { ZetaLiveTradingClientWrapper } from "./clients/zeta/live-trading-client.js";
import { Connection } from "@solana/web3.js";
import { ASSETS, SYMBOLS, ACTIVE_SYMBOLS, CONFIG } from "./config/config.js";
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
		this.settings = CONFIG.getTokenSettings(this.symbol);

		// Position monitoring state
		this.positionMonitorInterval = null;
		this.profitMonitorInterval = null;
		this.lastCheckedPrice = null;

		// Progress tracking properties
		this.hasReachedThreshold = false;
		this.highestProgress = 0;
		this.lowestProgress = 0;
		this.thresholdHits = 0;
		this.takeProfitHits = 0;
		this.stopLossHits = 0;
		this.trailingStopHits = 0;

		// Position management state
		this.isClosing = false;
		this.currentDirection = null;

		// Price tracking
		this.highestPrice = 0;
		this.lowestPrice = Infinity;

		// Trailing stop state
		this.trailingStopPrice = null;
		this.entryPrice = null;
	}

	async startSimpleProfitMonitor(targetPercent = null) {
		if (this.profitMonitorInterval) {
			clearInterval(this.profitMonitorInterval);
		}

		const target = targetPercent || this.settings.simpleTakeProfit;

		this.profitMonitorInterval = setInterval(() => this.monitorSimpleProfitTarget(target), CONFIG.position.monitorInterval);

		logger.info(`[${this.symbol}] Started simple profit monitoring with ${target}% target`);
	}


  
	async monitorSimpleProfitTarget(targetPercent = null) {
		try {
			if (this.isClosing) return;

			this.settings = CONFIG.getTokenSettings(this.symbol);
			const target = targetPercent || this.settings.simpleTakeProfit;

			const currentPosition = await this.zetaWrapper.getPosition(this.marketIndex);

			if (!currentPosition || currentPosition.size === 0) {
				this.stopMonitoring();
				return;
			}

			const entryPrice = Math.abs(currentPosition.costOfTrades / currentPosition.size);
			const currentPrice = this.zetaWrapper.getCalculatedMarkPrice(this.marketIndex);
			const direction = currentPosition.size > 0 ? "long" : "short";
			const accountState = await this.zetaWrapper.crossMarginAccountState();

			if (!this.entryPrice) {
				this.entryPrice = entryPrice;
				this.trailingStopPrice =
					direction === "long"
						? entryPrice * (1 - this.settings.trailingStop.initialDistance / 100)
						: entryPrice * (1 + this.settings.trailingStop.initialDistance / 100);
			}

			this.highestPrice = Math.max(this.highestPrice || currentPrice, currentPrice);
			this.lowestPrice = Math.min(this.lowestPrice === Infinity ? currentPrice : this.lowestPrice, currentPrice);

			let priceProgressPercent;
			// First - The Initial Setting
			if (direction === "long") {
				priceProgressPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
				if (priceProgressPercent >= this.settings.trailingStop.initialDistance) {
					// Only update if new stop would be higher
					const potentialNewStop = currentPrice * (1 - this.settings.trailingStop.trailDistance / 100);
					if (potentialNewStop > this.trailingStopPrice) {
						this.trailingStopPrice = potentialNewStop;
					}
				} else {
					// THIS NEEDS TO CHANGE - Currently setting too far back
					this.trailingStopPrice = currentPrice * (1 - (this.settings.trailingStop.initialDistance - priceProgressPercent) / 100);
				}
			} else {
				priceProgressPercent = ((entryPrice - currentPrice) / entryPrice) * 100;
				if (priceProgressPercent >= this.settings.trailingStop.initialDistance) {
					// Only update if new stop would be lower
					const potentialNewStop = currentPrice * (1 + this.settings.trailingStop.trailDistance / 100);
					if (potentialNewStop < this.trailingStopPrice) {
						this.trailingStopPrice = potentialNewStop;
					}
				} else {
					// THIS NEEDS TO CHANGE - Currently setting too far away
					this.trailingStopPrice = currentPrice * (1 + (this.settings.trailingStop.initialDistance - priceProgressPercent) / 100);
				}
			}

			const dollarPnL =
				direction === "long"
					? (currentPrice - entryPrice) * Math.abs(currentPosition.size)
					: (entryPrice - currentPrice) * Math.abs(currentPosition.size);

			const unrealizedPnl =
				dollarPnL >= 0
					? ((accountState.balance + dollarPnL) / accountState.balance - 1) * 100
					: -((1 - (accountState.balance + dollarPnL) / accountState.balance) * 100);

			this.highestProgress = Math.max(this.highestProgress, unrealizedPnl);
			this.lowestProgress = Math.min(this.lowestProgress, unrealizedPnl);

			if (this.lastCheckedPrice !== currentPrice) {
				const makeProgressBar = (percent, length = 42) => {
					const normalizedPercent =
						(percent + this.settings.simpleStopLoss) / (this.settings.simpleTakeProfit + this.settings.simpleStopLoss);
					const position = Math.round(length * normalizedPercent);
					const bar = "░".repeat(length);
					return "│" + bar.slice(0, position) + "▓" + bar.slice(position + 1) + "│";
				};

				const getDirectionEmoji = (percent) => {
					if (percent > 0) return "🟢";
					if (percent < 0) return "🔴";
					return "⚪";
				};

				const priceChangePercent = ((currentPrice - entryPrice) / entryPrice) * 100;
				const priceChange = direction === "long" ? priceChangePercent : -priceChangePercent;

				// Later in the display section
				const trailingStopDistance =
					direction === "long"
						? (((currentPrice - this.trailingStopPrice) / currentPrice) * 100).toFixed(2)
						: (((this.trailingStopPrice - currentPrice) / currentPrice) * 100).toFixed(2);

				let output = `\n \n \n \n\n${this.symbol} ${direction === "long" ? "LONG" : "SHORT"}`;
				output += ` 🎯 TP: ${this.takeProfitHits}/${CONFIG.position.thresholdHitCount}`;
				output += ` SL: ${this.stopLossHits}/${CONFIG.position.thresholdHitCount}`;
				output += ` TSL: ${this.trailingStopHits}/${CONFIG.position.thresholdHitCount}`;

				output += `\n${this.settings.leverageMultiplier}x Leverage`;
				output += ` | TP: ${this.settings.simpleTakeProfit}%`;
				output += ` | SL: ${this.settings.simpleStopLoss}%`;
				output += ` | TSL: ${this.settings.trailingStop.initialDistance}% → ${this.settings.trailingStop.trailDistance}%`;

				output += "\n─────────────────────────────────────────────────────────";
				output += `\nEntry: ${entryPrice.toFixed(2)} → Current: ${currentPrice.toFixed(2)} (${
					priceChange >= 0 ? "+" : ""
				}${priceChange.toFixed(2)}%)`;
				output += `\nHigh: ${this.highestPrice.toFixed(2)} | Low: ${this.lowestPrice.toFixed(2)}`;

				output += `\nTrailing Stop: ${this.trailingStopPrice.toFixed(2)} (${trailingStopDistance}% away)`;
				output +=
					priceProgressPercent >= this.settings.trailingStop.initialDistance
						? " [ACTIVE]"
						: "";
				output += "\n─────────────────────────────────────────────────────────";

				output += `\nSL -${this.settings.simpleStopLoss}% ──────────── Entry ──────────── TP ${this.settings.simpleTakeProfit}%`;
				output += `\n${makeProgressBar(unrealizedPnl)} ${getDirectionEmoji(unrealizedPnl)} ${unrealizedPnl.toFixed(2)}%`;
				output += "\n─────────────────────────────────────────────────────────";

				output += `\nHighest: ${this.highestProgress.toFixed(2)}% | Lowest: ${this.lowestProgress.toFixed(2)}%`;
				output += `\nBalance: $${accountState.balance.toFixed(2)} | P&L: $${dollarPnL.toFixed(2)}`;

				logger.info(output);
				this.lastCheckedPrice = currentPrice;
			}

			const trailingStopHit =
				direction === "long" ? currentPrice <= this.trailingStopPrice : currentPrice >= this.trailingStopPrice;

			if (trailingStopHit) {
				this.trailingStopHits++;
				this.takeProfitHits = 0;
				this.stopLossHits = 0;

				if (this.trailingStopHits >= CONFIG.position.thresholdHitCount) {
					logger.notify(
						`[${this.symbol}] Trailing stop confirmed after ${
							CONFIG.position.thresholdHitCount
						} hits at ${this.trailingStopPrice.toFixed(2)}`
					);
					const closed = await this.closePosition("Trailing stop hit");
					if (closed) {
						logger.notify(`[${this.symbol}] Position closed at trailing stop with ${unrealizedPnl.toFixed(2)}% PnL`);
					} else {
						logger.warn(`[${this.symbol}] Failed to close position at trailing stop - will retry`);
					}
					return;
				}
			} else {
				this.trailingStopHits = 0;
			}

			if (unrealizedPnl <= -this.settings.simpleStopLoss) {
				this.stopLossHits++;
				this.takeProfitHits = 0;
				this.trailingStopHits = 0;

				if (this.stopLossHits >= CONFIG.position.thresholdHitCount) {
					logger.notify(
						`[${this.symbol}] Stop loss confirmed after ${CONFIG.position.thresholdHitCount} hits at ${unrealizedPnl.toFixed(2)}%`
					);
					const closed = await this.closePosition("Stop loss hit");
					if (closed) {
						logger.notify(`[${this.symbol}] Position closed at stop loss ${unrealizedPnl.toFixed(2)}%`);
					} else {
						logger.warn(`[${this.symbol}] Failed to close position at stop loss - will retry`);
					}
					return;
				}
			} else {
				this.stopLossHits = 0;
			}

			if (unrealizedPnl >= target) {
				this.takeProfitHits++;
				this.stopLossHits = 0;
				this.trailingStopHits = 0;

				if (this.takeProfitHits >= CONFIG.position.thresholdHitCount) {
					logger.notify(
						`[${this.symbol}] Take profit confirmed after ${
							CONFIG.position.thresholdHitCount
						} hits! Current PnL: ${unrealizedPnl.toFixed(2)}%`
					);
					const closed = await this.closePosition("Target profit reached");
					if (closed) {
						logger.notify(`[${this.symbol}] Position closed at ${unrealizedPnl.toFixed(2)}% profit`);
					} else {
						logger.warn(`[${this.symbol}] Failed to close position at profit target - will retry`);
					}
				}
			} else {
				this.takeProfitHits = 0;
			}
		} catch (error) {
			logger.error(`[${this.symbol}] Error in simple profit monitoring:`, error);
		}
	}

	async processSignal(signalData) {
		let currentPosition;
		try {
			currentPosition = await this.zetaWrapper.getPosition(this.marketIndex);
		} catch (error) {
			logger.error(`[${this.symbol}] Error getting position:`, {
				error: error.message,
				stack: error.stack,
			});
			return;
		}

		let marketConditions = {
			sentiment: "NEUTRAL",
			index: 50,
			canOpenLong: true,
			canOpenShort: true,
		};

		if (signalData.signal !== 0) {
			try {
				marketConditions = await getMarketSentiment();

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
			} catch (error) {
				logger.error(`[${this.symbol}] Error fetching market sentiment - continuing with default neutral conditions:`, {
					error: error.message,
					stack: error.stack,
					signalData,
				});
			}
		}

		if (currentPosition && currentPosition.size !== 0) {
			const existingDirection = currentPosition.size > 0 ? "long" : "short";

			if (signalData.signal !== 0 && marketConditions.sentiment !== "NEUTRAL") {
				const isLongPosition = currentPosition.size > 0;
				const isExtremeGreed = marketConditions.sentiment === "Extreme Greed";
				const isExtremeFear = marketConditions.sentiment === "Extreme Fear";

				if ((isExtremeGreed && !isLongPosition) || (isExtremeFear && isLongPosition)) {
					logger.notify(
						`[${this.symbol}] Position closure triggered by extreme market sentiment - ${marketConditions.sentiment}`
					);

					logger.info(`[${this.symbol}] Closing position due to extreme opposite market sentiment`, {
						positionType: isLongPosition ? "LONG" : "SHORT",
						marketSentiment: marketConditions.sentiment,
						reason: "Extreme opposite market sentiment",
					});

					const closed = await this.closePosition("Extreme opposite market sentiment");

					if (closed) {
						logger.info(`[${this.symbol}] Position closed due to extreme market conditions`);

						logger.notify(`[${this.symbol}] Position successfully closed due to market sentiment`);

						if ((isExtremeGreed && signalData.signal === 1) || (isExtremeFear && signalData.signal === -1)) {
							const newDirection = signalData.signal === 1 ? "long" : "short";
							logger.notify(
								`[${this.symbol}] Opening ${newDirection} position after closure due to matching signal and market sentiment`
							);
							try {
								await execAsync(`node src/manage-position.js open ${this.symbol} ${newDirection}`, {
									maxBuffer: 1024 * 1024 * 32,
								});
							} catch (error) {
								logger.info(`[${this.symbol}] Position command completed with status info:`, {
									error: error.message,
								});
							}

							logger.info(`[${this.symbol}] Waiting ${CONFIG.position.waitAfterAction}ms before verifying`);
							await utils.sleep(CONFIG.position.waitAfterAction);

							const newPosition = await this.zetaWrapper.getPosition(this.marketIndex);
							if (newPosition && newPosition.size !== 0) {
								this.currentDirection = newDirection;
								this.startSimpleProfitMonitor(this.settings.simpleTakeProfit);
							}
						}
					}
					return;
				}
			}

			if (!this.positionMonitorInterval) {
				logger.info(`[${this.symbol}] Found unmonitored ${existingDirection} position during signal processing`, {
					size: currentPosition.size,
					entryPrice: (currentPosition.costOfTrades / currentPosition.size).toFixed(4),
				});

				this.currentDirection = existingDirection;
				this.startSimpleProfitMonitor(this.settings.simpleTakeProfit);
			}
			return;
		}

		if (signalData.signal === 0) return;

		const isLongSignal = signalData.signal === 1;
		const direction = isLongSignal ? "long" : "short";

		if (
			marketConditions.sentiment !== "NEUTRAL" &&
			((isLongSignal && !marketConditions.canOpenLong) || (!isLongSignal && !marketConditions.canOpenShort))
		) {
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

		try {
			await execAsync(`node src/manage-position.js open ${this.symbol} ${direction}`, {
				maxBuffer: 1024 * 1024 * 32,
			});
		} catch (error) {
			logger.info(`[${this.symbol}] Position command completed with status info:`, {
				error: error.message,
			});
		}

		logger.info(`[${this.symbol}] Waiting ${CONFIG.position.waitAfterAction}ms before verifying`);
		await utils.sleep(CONFIG.position.waitAfterAction);

		const verifyPosition = await this.zetaWrapper.getPosition(this.marketIndex);
		if (verifyPosition && verifyPosition.size !== 0) {
			const actualDirection = verifyPosition.size > 0 ? "long" : "short";
			logger.notify(`[${this.symbol}] Found active ${actualDirection} position after operation`, {
				size: verifyPosition.size,
				entryPrice: verifyPosition.costOfTrades ? (verifyPosition.costOfTrades / verifyPosition.size).toFixed(4) : "N/A",
			});
			this.currentDirection = actualDirection;
			this.startSimpleProfitMonitor(this.settings.simpleTakeProfit);
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
		const realizedPnl = position.size > 0 ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice;

		try {
			await execAsync(`node src/manage-position.js close ${this.symbol} ${this.currentDirection}`, {
				maxBuffer: 1024 * 1024 * 32,
			});
		} catch (error) {
			logger.error(`[${this.symbol}] Position close command failed, verifying position state:`, error);
		}

		logger.info(`[${this.symbol}] Waiting ${CONFIG.position.waitAfterAction}ms before verifying`);
		await utils.sleep(CONFIG.position.waitAfterAction);

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

		logger.warn(`[${this.symbol}] Position still active after close attempt, resuming monitoring`, {
			size: verifyPosition.size,
			entryPrice: (verifyPosition.costOfTrades / verifyPosition.size).toFixed(4),
		});

		if (!this.positionMonitorInterval) {
			const direction = verifyPosition.size > 0 ? "long" : "short";
			this.currentDirection = direction;
			this.startSimpleProfitMonitor(this.settings.simpleTakeProfit);
		}

		this.isClosing = false;
		return false;
	}

	stopMonitoring() {
		if (this.positionMonitorInterval) {
			clearInterval(this.positionMonitorInterval);
			this.positionMonitorInterval = null;
		}
		if (this.profitMonitorInterval) {
			clearInterval(this.profitMonitorInterval);
			this.profitMonitorInterval = null;
		}
		this.hasReachedThreshold = false;
		this.highestProgress = 0;
		this.lowestProgress = 0;
		this.highestPrice = 0;
		this.lowestPrice = Infinity;
		this.thresholdHits = 0;
		this.takeProfitHits = 0;
		this.stopLossHits = 0;
		this.trailingStopHits = 0;
		this.isClosing = false;
		this.currentDirection = null;
		this.trailingStopPrice = null;
		this.entryPrice = null;
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
		this.connection = null;
	}

	async initialize(symbols) {
		try {
			logger.info("[INIT] Initializing Trading Manager", {
				symbols,
				wallet: process.env.KEYPAIR_FILE_PATH,
			});

			this.connection = new Connection(process.env.RPC_TRADINGBOT);
			const marketsToLoad = new Set([constants.Asset.SOL, ...symbols.map((s) => constants.Asset[s])]);
			const marketsArray = Array.from(marketsToLoad);

			const loadExchangeConfig = types.defaultLoadExchangeConfig(
				Network.MAINNET,
				this.connection,
				{
					skipPreflight: true,
					preflightCommitment: "finalized",
					commitment: "finalized",
				},
				20,
				false,
				this.connection,
				marketsArray,
				undefined,
				marketsArray
			);

			await Exchange.load(loadExchangeConfig);
			logger.info("[INIT] Exchange loaded successfully");

			this.zetaWrapper = new ZetaLiveTradingClientWrapper();
			const marketIndices = symbols.map((symbol) => constants.Asset[symbol]);
			await this.zetaWrapper.initialize(marketIndices, process.env.KEYPAIR_FILE_PATH);

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

					manager.startSimpleProfitMonitor(manager.settings.simpleTakeProfit);
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
				logger.info(`[WS] Queued signal for ${signalData.symbol}`);

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

			logger.info("[HEALTH] System Status:", {
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
					const direction = position.size > 0 ? "long" : "short";

					const progress =
						direction === "long"
							? (currentPrice - entryPrice) / (currentPrice + entryPrice)
							: (entryPrice - currentPrice) / (entryPrice + currentPrice);

					const unrealizedPnl =
						direction === "long" ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice;

					positions.push({
						symbol,
						size: position.size,
						entryPrice,
						currentPrice,
						progress,
						unrealizedPnl,
						stopLoss:
							direction === "long"
								? entryPrice * (1 - manager.settings.simpleStopLoss / 100)
								: entryPrice * (1 + manager.settings.simpleStopLoss / 100),
						takeProfit:
							direction === "long"
								? entryPrice * (1 + manager.settings.simpleTakeProfit / 100)
								: entryPrice * (1 - manager.settings.simpleTakeProfit / 100),
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
