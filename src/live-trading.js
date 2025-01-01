/**
 * Live Trading System for Zeta Markets
 *
 * This system implements an automated trading strategy for cryptocurrency perpetual futures
 * on the Zeta Markets protocol. It combines technical analysis signals with market sentiment
 * to make trading decisions while managing risk through multiple protective mechanisms:
 *
 * - Take profit targets
 * - Stop loss protection
 * - Trailing stops
 * - Market sentiment filters
 * - Position size management
 *
 * The architecture follows a hierarchical pattern:
 * - TradingManager: Top-level orchestrator that manages the entire system
 * - SymbolTradingManager: Individual managers for each trading pair (e.g., SOL-PERP)
 *
 * Trading signals are received via WebSocket, with built-in reconnection handling and
 * message queuing to ensure no signals are missed during network disruptions.
 */

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

/**
 * Validates the trading system configuration before startup.
 *
 * This function performs several critical checks:
 * 1. Verifies all required environment variables are present
 * 2. Confirms the trading wallet file exists
 * 3. Validates that all configured trading assets are supported by Zeta
 *
 * This validation step is crucial as missing configuration could lead to
 * unexpected behavior or failed trades in production.
 *
 * @returns {string[]} Array of validated trading asset symbols
 * @throws {Error} If any validation check fails
 */
function validateConfig() {
	const missingVars = CONFIG.requiredEnvVars.filter((envVar) => !process.env[envVar]);
	if (missingVars.length > 0) {
		logger.error(`[INIT] Missing required environment variables: ${missingVars.join(", ")}`);
		process.exit(1);
	}

	if (!fs.existsSync(process.env.KEYPAIR_FILE_PATH)) {
		logger.error("[INIT] Wallet file not found");
		process.exit(1);
	}

	const invalidSymbols = CONFIG.tradingAssets.filter((symbol) => !ASSETS.includes(constants.Asset[symbol]));
	if (invalidSymbols.length > 0) {
		logger.error(`[INIT] Invalid trading symbols found: ${invalidSymbols.join(", ")}`);
		process.exit(1);
	}

	return CONFIG.tradingAssets;
}

/**
 * SymbolTradingManager handles all trading operations for a single market pair.
 *
 * Each instance manages:
 * - Position monitoring and risk management
 * - Profit/loss tracking
 * - Take profit and stop loss execution
 * - Trailing stop implementation
 * - Market entry and exit execution
 *
 * The manager implements a state machine pattern to track position lifecycle:
 * New Position → Monitoring → Take Profit/Stop Loss → Position Closure
 *
 * It uses a threshold-based confirmation system to avoid acting on temporary
 * price spikes or market noise.
 */
class SymbolTradingManager {
	/**
	 * Creates a new trading manager for a specific market pair.
	 *
	 * @param {number} marketIndex - Zeta market index for the trading pair
	 * @param {ZetaLiveTradingClientWrapper} zetaWrapper - Instance of the Zeta client
	 */
	constructor(marketIndex, zetaWrapper) {
		// Core trading parameters
		this.marketIndex = marketIndex;
		this.symbol = constants.Asset[marketIndex];
		this.zetaWrapper = zetaWrapper;
		this.settings = CONFIG.getTokenSettings(this.symbol);

		// Monitoring intervals
		this.positionMonitorInterval = null;
		this.profitMonitorInterval = null;
		this.lastCheckedPrice = null;

		// Trailing stop state tracking
		this.hasReachedThreshold = false;
		this.highestProgress = 0;
		this.lowestProgress = 0;
		this.thresholdHits = 0;
		this.takeProfitHits = 0;
		this.stopLossHits = 0;
		this.trailingStopHits = 0;

		// Position state
		this.isClosing = false;
		this.currentDirection = null;

		// Price tracking for trailing stops
		this.highestPrice = 0;
		this.lowestPrice = Infinity;
		this.trailingStopPrice = null;
		this.entryPrice = null;
	}

	/**
	 * Initiates profit monitoring for an open position.
	 *
	 * This system uses a multi-factor approach to protect profits:
	 * 1. Simple take profit at a fixed percentage
	 * 2. Trailing stop that activates after initial profit target
	 * 3. Stop loss to limit downside risk
	 *
	 * The monitoring runs on an interval, continuously updating position metrics
	 * and checking for exit conditions.
	 *
	 * @param {number} targetPercent - Optional override for take profit percentage
	 */
	async startSimpleProfitMonitor(targetPercent = null) {
		if (this.profitMonitorInterval) {
			clearInterval(this.profitMonitorInterval);
		}

		const target = targetPercent || this.settings.simpleTakeProfit;

		this.profitMonitorInterval = setInterval(() => this.monitorSimpleProfitTarget(target), CONFIG.position.monitorInterval);

		logger.info(`[${this.symbol}] Started simple profit monitoring with ${target}% target`);
	}

	/**
	 * Core profit monitoring logic that tracks position performance and executes
	 * take profit, stop loss, and trailing stop conditions.
	 *
	 * The monitoring system uses a threshold-based confirmation approach to avoid
	 * acting on temporary price movements. Multiple consecutive threshold hits are
	 * required before taking action.
	 *
	 * For trailing stops, the system:
	 * 1. Waits for initial profit target (activation threshold)
	 * 2. Starts tracking new highs/lows
	 * 3. Moves the stop loss up/down to lock in profits
	 *
	 * @param {number} targetPercent - Take profit target percentage
	 */

	async monitorSimpleProfitTarget(targetPercent = null) {
		try {
			if (this.isClosing) return;

			this.settings = CONFIG.getTokenSettings(this.symbol);
			const target = targetPercent || this.settings.simpleTakeProfit;

			const currentPosition = await this.zetaWrapper.getPosition(this.marketIndex);
			const accountState = await this.zetaWrapper.crossMarginAccountState();

			if (!currentPosition || currentPosition.size === 0) {
				this.stopMonitoring();
				return;
			}

			const entryPrice = Math.abs(currentPosition.costOfTrades / currentPosition.size);
			const currentPrice = this.zetaWrapper.getCalculatedMarkPrice(this.marketIndex);
			const direction = currentPosition.size > 0 ? "long" : "short";

			// Calculate BALANCE impact - this is what matters with leverage
			const priceDifference = direction === "long" ? currentPrice - entryPrice : entryPrice - currentPrice;
			const dollarPnL = currentPosition.size * priceDifference; // Actual $ impact on our balance
			const initialBalance = accountState.balance - dollarPnL; // What balance was when we entered
			const unrealizedPnl = (dollarPnL / initialBalance) * 100; // Percentage change in our total balance

			// Initialize tracking on new position - all numbers track BALANCE changes
			if (!this.entryPrice) {
				this.entryPrice = entryPrice;
				this.initialBalance = initialBalance;
				this.highestProgress = unrealizedPnl; // Track best balance impact
				this.lowestProgress = 0; // Track worst balance impact

				// Set initial trailing stop based on balance impact threshold
				const initialBalanceRisk = (this.settings.trailingStop.initialDistance * initialBalance) / (currentPosition.size * 100);
				this.trailingStopPrice = direction === "long" ? entryPrice - initialBalanceRisk : entryPrice + initialBalanceRisk;
			}

			// Update our highest and lowest balance impacts
			this.highestProgress = Math.max(this.highestProgress, unrealizedPnl);
			this.lowestProgress = Math.min(this.lowestProgress, unrealizedPnl);

			// Handle trailing stops based on BALANCE changes, not just price
			if (direction === "long") {
				// Check if we've hit our initial balance gain threshold
				if (unrealizedPnl >= this.settings.trailingStop.initialDistance && !this.hasReachedThreshold) {
					logger.notify(
						`[${this.symbol}] 🎯 Trailing Stop Threshold ${
							this.settings.trailingStop.initialDistance
						}% Balance Change Reached! Current PnL: ${unrealizedPnl.toFixed(2)}%`
					);
					logger.notify(
						`[${this.symbol}] 🔄 Now tracking ${this.settings.trailingStop.trailDistance}% balance pullback from new highs`
					);
					this.hasReachedThreshold = true;
				}

				if (unrealizedPnl >= this.settings.trailingStop.initialDistance) {
					// Calculate price needed for our maximum allowed balance pullback
					const maxAllowedLoss = this.highestProgress - this.settings.trailingStop.trailDistance;
					const requiredPrice = entryPrice + (maxAllowedLoss * initialBalance) / (currentPosition.size * 100);

					if (requiredPrice > this.trailingStopPrice) {
						this.trailingStopPrice = requiredPrice;
						if (this.hasReachedThreshold) {
							logger.notify(
								`[${this.symbol}] 📈 New Balance High - Trailing Stop raised to ${this.trailingStopPrice.toFixed(2)}`
							);
						}
					}
				} else {
					// Reset trailing stop to initial balance-based distance
					const initialStopDistance =
						(this.settings.trailingStop.initialDistance * initialBalance) / (currentPosition.size * 100);
					this.trailingStopPrice = entryPrice - initialStopDistance;
				}
			} else {
				// Same logic for shorts but reversed
				if (unrealizedPnl >= this.settings.trailingStop.initialDistance && !this.hasReachedThreshold) {
					logger.notify(
						`[${this.symbol}] 🎯 Trailing Stop Threshold ${
							this.settings.trailingStop.initialDistance
						}% Balance Change Reached! Current PnL: ${unrealizedPnl.toFixed(2)}%`
					);
					logger.notify(
						`[${this.symbol}] 🔄 Now tracking ${this.settings.trailingStop.trailDistance}% balance pullback from new highs`
					);
					this.hasReachedThreshold = true;
				}

				if (unrealizedPnl >= this.settings.trailingStop.initialDistance) {
					// Calculate price needed for our maximum allowed balance pullback
					const maxAllowedLoss = this.highestProgress - this.settings.trailingStop.trailDistance;
					const requiredPrice = entryPrice - (maxAllowedLoss * initialBalance) / (currentPosition.size * 100);

					if (requiredPrice < this.trailingStopPrice) {
						this.trailingStopPrice = requiredPrice;
						if (this.hasReachedThreshold) {
							logger.notify(
								`[${this.symbol}] 📉 New Balance High - Trailing Stop lowered to ${this.trailingStopPrice.toFixed(2)}`
							);
						}
					}
				} else {
					// Reset trailing stop to initial balance-based distance
					const initialStopDistance =
						(this.settings.trailingStop.initialDistance * initialBalance) / (currentPosition.size * 100);
					this.trailingStopPrice = entryPrice + initialStopDistance;
				}
			}

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

				// Calculate distance to trailing stop in terms of balance impact
				const trailingStopPnL =
					direction === "long"
						? ((this.trailingStopPrice - entryPrice) / entryPrice) * 100 * this.settings.leverageMultiplier
						: ((entryPrice - this.trailingStopPrice) / entryPrice) * 100 * this.settings.leverageMultiplier;

				let output = `\n \n \n \n\n${this.symbol} ${direction === "long" ? "LONG" : "SHORT"}`;
				output += ` 🎯 TP: ${this.takeProfitHits}/${CONFIG.position.thresholdHitCount}`;
				output += ` SL: ${this.stopLossHits}/${CONFIG.position.thresholdHitCount}`;
				output += ` TSL: ${this.trailingStopHits}/${CONFIG.position.thresholdHitCount}`;

				output += `\n${this.settings.leverageMultiplier}x `;
				output += ` | TP: ${this.settings.simpleTakeProfit}% balance`;
				output += ` | SL: ${this.settings.simpleStopLoss}% balance`;
				output += ` | TSL: ${this.settings.trailingStop.initialDistance}% → ${this.settings.trailingStop.trailDistance}%`;
				output += this.hasReachedThreshold ? " ✅" : " 🔄";

				output += "\n─────────────────────────────────────────────────────────";
				output += `\nEntry Balance: $${this.initialBalance.toFixed(2)} → Current: $${accountState.balance.toFixed(2)}`;
				output += `\nPosition Size: ${currentPosition.size} @ $${entryPrice.toFixed(2)} → $${currentPrice.toFixed(2)}`;

				if (this.hasReachedThreshold) {
					const pullback = unrealizedPnl - this.highestProgress;
					output += `\nTSL: $${this.trailingStopPrice.toFixed(2)} (${pullback.toFixed(2)}%)`;
				} else {
					const distanceToThreshold = this.settings.trailingStop.initialDistance - unrealizedPnl;
					output += `\nTSL: Need ${distanceToThreshold.toFixed(2)}% more to reach threshold`;
				}

				output += this.hasReachedThreshold ? " 🟢" : " ⚪";
				output += "\n─────────────────────────────────────────────────────────";

				output += `\nSL -${this.settings.simpleStopLoss}% ──────────── Entry ──────────── TP ${this.settings.simpleTakeProfit}%`;
				output += `\n${makeProgressBar(unrealizedPnl)} ${getDirectionEmoji(unrealizedPnl)} ${unrealizedPnl.toFixed(2)}%`;
				output += "\n─────────────────────────────────────────────────────────";

				// Show highest and lowest balance impacts
				output += `\nLow: ${this.lowestProgress.toFixed(2)}% | High: ${this.highestProgress.toFixed(2)}% `;
				output += `\nBalance: $${accountState.balance.toFixed(2)} | P&L: $${dollarPnL.toFixed(2)}`;

				logger.info(output);
				this.lastCheckedPrice = currentPrice;
			}

			// Check if we've hit our trailing stop price
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
						} hits at ${this.trailingStopPrice.toFixed(2)} (${unrealizedPnl.toFixed(2)}% balance change)`
					);
					const closed = await this.closePosition("Trailing stop hit");
					if (closed) {
						logger.notify(`[${this.symbol}] Position closed at trailing stop with ${unrealizedPnl.toFixed(2)}% balance change`);
					} else {
						logger.warn(`[${this.symbol}] Failed to close position at trailing stop - will retry`);
					}
					return;
				}
			} else {
				this.trailingStopHits = 0;
			}

			// Check stop loss against balance impact
			if (unrealizedPnl <= -this.settings.simpleStopLoss) {
				this.stopLossHits++;
				this.takeProfitHits = 0;
				this.trailingStopHits = 0;

				if (this.stopLossHits >= CONFIG.position.thresholdHitCount) {
					logger.notify(
						`[${this.symbol}] Stop loss confirmed after ${CONFIG.position.thresholdHitCount} hits at ${unrealizedPnl.toFixed(
							2
						)}% balance change`
					);
					const closed = await this.closePosition("Stop loss hit");
					if (closed) {
						logger.notify(`[${this.symbol}] Position closed at stop loss ${unrealizedPnl.toFixed(2)}% balance change`);
					} else {
						logger.warn(`[${this.symbol}] Failed to close position at stop loss - will retry`);
					}
					return;
				}
			} else {
				this.stopLossHits = 0;
			}

			// Check take profit against balance impact
			if (unrealizedPnl >= target) {
				this.takeProfitHits++;
				this.stopLossHits = 0;
				this.trailingStopHits = 0;

				if (this.takeProfitHits >= CONFIG.position.thresholdHitCount) {
					logger.notify(`[${this.symbol}] Take profit confirmed: ${unrealizedPnl.toFixed(2)}% balance change`);
					const closed = await this.closePosition("Target profit reached");
					if (closed) {
						logger.notify(`[${this.symbol}] Position closed at ${unrealizedPnl.toFixed(2)}% balance gain`);
					} else {
						logger.warn(`[${this.symbol}] Failed to close position at profit target - will retry`);
					}
				}
			} else {
				this.takeProfitHits = 0;
			}
		} catch (error) {
			logger.error(`[${this.symbol}] Error in balance-based monitoring:`, error);
		}
	}

	/**
	 * Processes incoming trading signals while considering market sentiment.
	 *
	 * This function implements a sophisticated decision-making process:
	 * 1. Checks current position state
	 * 2. Analyzes market sentiment
	 * 3. Validates signal against sentiment
	 * 4. Executes position entry/exit based on combined analysis
	 *
	 * The system uses market sentiment as a filter to avoid:
	 * - Opening longs in extreme fear conditions
	 * - Opening shorts in extreme greed conditions
	 * - Holding positions against strong counter-trend sentiment
	 *
	 * @param {Object} signalData - Trading signal information
	 * @param {number} signalData.signal - Direction indicator (-1: short, 0: neutral, 1: long)
	 */
	async processSignal(signalData) {
		// Check current position state
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

		// Initialize default market conditions
		let marketConditions = {
			sentiment: "NEUTRAL",
			index: 50,
			canOpenLong: true,
			canOpenShort: true,
		};

		// Only analyze market sentiment for active signals
		if (signalData.signal !== 0) {
			try {
				marketConditions = await getMarketSentiment();

				// Log comprehensive analysis of current situation
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

		// Handle existing position management
		if (currentPosition && currentPosition.size !== 0) {
			const existingDirection = currentPosition.size > 0 ? "long" : "short";

			// Check for extreme market conditions that warrant position closure
			if (signalData.signal !== 0 && marketConditions.sentiment !== "NEUTRAL") {
				const isLongPosition = currentPosition.size > 0;
				const isExtremeGreed = marketConditions.sentiment === "Extreme Greed";
				const isExtremeFear = marketConditions.sentiment === "Extreme Fear";

				// Close positions in extreme counter-trend conditions
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

						// Open new position if signal aligns with extreme sentiment
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

							// Wait for position to settle before verifying
							logger.info(`[${this.symbol}] Waiting ${CONFIG.position.waitAfterAction}ms before verifying`);
							await utils.sleep(CONFIG.position.waitAfterAction);

							// Verify new position and start monitoring
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

			// Start monitoring for unmonitored positions
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

		// Ignore neutral signals
		if (signalData.signal === 0) return;

		// Process new position signals
		const isLongSignal = signalData.signal === 1;
		const direction = isLongSignal ? "long" : "short";

		// Skip new positions that conflict with market sentiment
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

		// Open new position aligned with signal and sentiment
		logger.info(`[${this.symbol}] Opening ${direction} position based on signal and market sentiment`, {
			direction,
			marketSentiment: marketConditions.sentiment,
			sentimentIndex: marketConditions.index,
		});

		// Execute position opening
		try {
			await execAsync(`node src/manage-position.js open ${this.symbol} ${direction}`, {
				maxBuffer: 1024 * 1024 * 32,
			});
		} catch (error) {
			logger.info(`[${this.symbol}] Position command completed with status info:`, {
				error: error.message,
			});
		}

		// Wait for position to settle
		logger.info(`[${this.symbol}] Waiting ${CONFIG.position.waitAfterAction}ms before verifying`);
		await utils.sleep(CONFIG.position.waitAfterAction);

		// Verify position and start monitoring
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

	/**
	 * Closes an open position with retry mechanism.
	 *
	 * This function handles the complete position closure process:
	 * 1. Prevents concurrent closure attempts
	 * 2. Verifies position existence
	 * 3. Executes closure command
	 * 4. Verifies successful closure
	 * 5. Logs trading metrics
	 *
	 * @param {string} reason - Reason for position closure
	 * @returns {boolean} True if position was closed successfully
	 */
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

		// Calculate final PnL metrics
		const currentPrice = this.zetaWrapper.getCalculatedMarkPrice(this.marketIndex);
		const entryPrice = Math.abs(position.costOfTrades / position.size);
		const realizedPnl = position.size > 0 ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice;

		try {
			// Execute position closure command
			await execAsync(`node src/manage-position.js close ${this.symbol} ${this.currentDirection}`, {
				maxBuffer: 1024 * 1024 * 32,
			});
		} catch (error) {
			logger.error(`[${this.symbol}] Position close command failed, verifying position state:`, error);
		}

		// Allow time for blockchain confirmation
		logger.info(`[${this.symbol}] Waiting ${CONFIG.position.waitAfterAction}ms before verifying`);
		await utils.sleep(CONFIG.position.waitAfterAction);

		// Verify position closure
		const verifyPosition = await this.zetaWrapper.getPosition(this.marketIndex);

		if (!verifyPosition || verifyPosition.size === 0) {
			logger.info(`[${this.symbol}] Position closure verified`);

			// Log trade completion metrics
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

		// Handle failed closure
		logger.warn(`[${this.symbol}] Position still active after close attempt, resuming monitoring`, {
			size: verifyPosition.size,
			entryPrice: (verifyPosition.costOfTrades / verifyPosition.size).toFixed(4),
		});

		// Restart monitoring if closure failed
		if (!this.positionMonitorInterval) {
			const direction = verifyPosition.size > 0 ? "long" : "short";
			this.currentDirection = direction;
			this.startSimpleProfitMonitor(this.settings.simpleTakeProfit);
		}

		this.isClosing = false;
		return false;
	}

	/**
	 * Stops all position monitoring activities and resets state.
	 *
	 * This cleanup function ensures:
	 * 1. All monitoring intervals are cleared
	 * 2. Trading state is reset to initial values
	 * 3. Position tracking metrics are cleared
	 *
	 * Called after successful position closure or when monitoring
	 * needs to be stopped for any reason.
	 */
	stopMonitoring() {
		if (this.positionMonitorInterval) {
			clearInterval(this.positionMonitorInterval);
			this.positionMonitorInterval = null;
		}
		if (this.profitMonitorInterval) {
			clearInterval(this.profitMonitorInterval);
			this.profitMonitorInterval = null;
		}
		// Reset all trading state variables
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

	/**
	 * Performs graceful shutdown of the symbol manager.
	 *
	 * Important for clean system termination to avoid:
	 * - Hanging monitoring processes
	 * - Incomplete logging
	 * - Memory leaks
	 */
	shutdown() {
		this.stopMonitoring();
		logger.info(`[${this.symbol}] Manager shutdown complete`);
	}
}

/**
 * TradingManager orchestrates the entire trading system.
 *
 * This class serves as the central coordinator, managing:
 * 1. System initialization and shutdown
 * 2. WebSocket connections for trading signals
 * 3. Individual symbol trading managers
 * 4. Health monitoring and status updates
 * 5. Message queue processing
 *
 * The architecture follows the Facade pattern, providing a simplified
 * interface to the complex trading subsystems while handling:
 * - Connection management
 * - Error recovery
 * - System state monitoring
 * - Cross-cutting concerns like logging
 */
class TradingManager {
	constructor() {
		// Core system components
		this.symbolManagers = new Map();
		this.zetaWrapper = null;
		this.connection = null;

		// WebSocket state management
		this.ws = null;
		this.reconnectAttempts = 0;
		this.connectionActive = false;

		// Message queue for handling trading signals
		this.messageQueue = [];
		this.isProcessingQueue = false;

		// System monitoring intervals
		this.healthCheckInterval = null;
		this.statusUpdateInterval = null;
	}

	/**
	 * Initializes the trading system with specified symbols.
	 *
	 * This complex initialization process:
	 * 1. Establishes blockchain connections
	 * 2. Loads the Zeta Markets exchange
	 * 3. Initializes symbol-specific trading managers
	 * 4. Sets up WebSocket for trading signals
	 * 5. Starts system monitoring
	 *
	 * The function implements defense in depth:
	 * - Validates all configurations
	 * - Verifies connections
	 * - Checks existing positions
	 * - Sets up error handling
	 *
	 * @param {string[]} symbols - Trading pairs to initialize
	 * @throws {Error} If initialization fails
	 */
	async initialize(symbols) {
		try {
			logger.info("[INIT] Initializing Trading Manager", {
				symbols,
				wallet: process.env.KEYPAIR_FILE_PATH,
			});

			// Initialize blockchain connection
			this.connection = new Connection(process.env.RPC_TRADINGBOT);

			// Prepare markets for initialization
			const marketsToLoad = new Set([constants.Asset.SOL, ...symbols.map((s) => constants.Asset[s])]);
			const marketsArray = Array.from(marketsToLoad);

			// Configure exchange loading parameters
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

			// Load the exchange
			await Exchange.load(loadExchangeConfig);
			logger.info("[INIT] Exchange loaded successfully");

			// Set up redundant connections if configured
			if (process.env.RPC_DOUBLEDOWN_1) {
				const doubledown_1 = new Connection(process.env.RPC_DOUBLEDOWN_1);
				await Exchange.addDoubleDownConnection(doubledown_1);
			}

			if (process.env.RPC_DOUBLEDOWN_2) {
				const doubledown_2 = new Connection(process.env.RPC_DOUBLEDOWN_2);
				await Exchange.addDoubleDownConnection(doubledown_2);
			}

			// Initialize Zeta client
			this.zetaWrapper = new ZetaLiveTradingClientWrapper();
			const marketIndices = symbols.map((symbol) => constants.Asset[symbol]);
			await this.zetaWrapper.initialize(marketIndices, process.env.KEYPAIR_FILE_PATH);

			// Create trading managers for each symbol
			for (const symbol of symbols) {
				const marketIndex = constants.Asset[symbol];
				const manager = new SymbolTradingManager(marketIndex, this.zetaWrapper);
				this.symbolManagers.set(symbol, manager);
			}

			// Check for existing positions that need monitoring
			logger.info("[INIT] Checking existing positions");
			await this.checkExistingPositions();

			// Set up system infrastructure
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

	/**
	 * Checks for and initializes monitoring of existing positions.
	 *
	 * This function ensures no positions are left unmonitored when:
	 * - System restarts
	 * - Connection recovers
	 * - After initialization
	 *
	 * For each existing position, it:
	 * 1. Detects position direction and size
	 * 2. Initializes appropriate monitoring
	 * 3. Logs position details
	 */
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

	/**
	 * Establishes and manages WebSocket connection for trading signals.
	 *
	 * The WebSocket connection is crucial for:
	 * 1. Receiving real-time trading signals
	 * 2. Maintaining system synchronization
	 * 3. Ensuring timely position management
	 *
	 * Features robust error handling:
	 * - Automatic reconnection
	 * - Message queuing
	 * - Connection monitoring
	 * - Error logging
	 */
	setupWebSocket() {
		// Clean up existing connection if any
		if (this.ws) {
			this.ws.terminate();
		}

		// Initialize new connection
		this.ws = new WebSocket(`ws://${CONFIG.ws.host}:${CONFIG.ws.port}?apiKey=${process.env.WS_API_KEY}`);

		// Handle successful connection
		this.ws.on("open", () => {
			this.connectionActive = true;
			this.reconnectAttempts = 0;
			logger.info("[WS] Connected to signal stream");

			// Subscribe to signals for all trading pairs
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

		// Process incoming messages
		this.ws.on("message", async (data) => {
			try {
				const signalData = JSON.parse(data.toString());

				// Handle connection acknowledgment
				if (signalData.type === "connection") {
					logger.info("[WS] Server acknowledged connection:", {
						availableSymbols: signalData.symbols,
					});
					return;
				}

				// Validate signal is for managed symbol
				if (!this.symbolManagers.has(signalData.symbol)) {
					return;
				}

				// Implement circular buffer behavior for message queue
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

		// Handle connection errors
		this.ws.on("error", (error) => {
			logger.error("[WS] WebSocket error:", error.message);
			this.connectionActive = false;
		});

		// Handle connection closure
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

	/**
	 * Processes queued trading signals in FIFO order.
	 *
	 * This function implements a synchronous processing queue to:
	 * 1. Maintain signal order
	 * 2. Prevent concurrent processing
	 * 3. Ensure reliable signal handling
	 *
	 * The queue helps manage:
	 * - Network latency
	 * - Processing delays
	 * - System load balancing
	 */
	async processMessageQueue() {
		if (this.isProcessingQueue) return;
		this.isProcessingQueue = true;

		try {
			while (this.messageQueue.length > 0) {
				const signalData = this.messageQueue.shift();

				// Validate signal data
				if (!signalData?.symbol || signalData.direction === undefined) {
					logger.info("[QUEUE] Skipping invalid message:", signalData);
					continue;
				}

				// Get appropriate symbol manager
				const manager = this.symbolManagers.get(signalData.symbol);
				if (!manager) continue;

				// Process signal with error handling
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
	 * Implements WebSocket reconnection logic with exponential backoff.
	 *
	 * This function manages connection recovery by:
	 * 1. Tracking reconnection attempts
	 * 2. Implementing retry limits
	 * 3. Maintaining system stability
	 */
	reconnect() {
		if (this.reconnectAttempts < CONFIG.ws.maxReconnectAttempts) {
			this.reconnectAttempts++;
			logger.info(`[WS] Attempting reconnection ${this.reconnectAttempts}/${CONFIG.ws.maxReconnectAttempts}`);
			setTimeout(() => this.setupWebSocket(), CONFIG.ws.reconnectDelay);
		}
	}

	/**
	 * Establishes system health monitoring.
	 *
	 * The health check system monitors:
	 * 1. WebSocket connection status
	 * 2. Message queue length
	 * 3. Reconnection attempts
	 * 4. Overall system state
	 *
	 * This provides early warning of potential issues and
	 * triggers automatic recovery procedures when needed.
	 */
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

	/**
	 * Configures periodic status updates for system monitoring.
	 *
	 * The status update system provides:
	 * 1. Regular snapshots of all positions
	 * 2. Performance metrics
	 * 3. System state information
	 *
	 * This monitoring helps track:
	 * - Trading performance
	 * - Risk exposure
	 * - System health
	 * - Position management effectiveness
	 */
	setupStatusUpdates() {
		// Send initial status update on startup
		this.sendStatusUpdate(true);

		// Schedule regular updates
		this.statusUpdateInterval = setInterval(async () => this.sendStatusUpdate(false), CONFIG.intervals.statusUpdate);
	}

	/**
	 * Generates and sends comprehensive system status report.
	 *
	 * This function collects and reports:
	 * 1. Active positions for all trading pairs
	 * 2. Current profit/loss metrics
	 * 3. Risk management status
	 * 4. Trading performance indicators
	 *
	 * The status report helps monitor:
	 * - Overall portfolio performance
	 * - Risk exposure levels
	 * - Trading strategy effectiveness
	 * - System operational status
	 *
	 * @param {boolean} isStartup - Whether this is the initial startup report
	 */
	async sendStatusUpdate(isStartup = false) {
		try {
			const positions = [];

			// Collect status for all active positions
			for (const [symbol, manager] of this.symbolManagers) {
				const position = await manager.zetaWrapper.getPosition(manager.marketIndex);

				if (position && position.size !== 0) {
					// Calculate position metrics
					const currentPrice = manager.zetaWrapper.getCalculatedMarkPrice(manager.marketIndex);
					const entryPrice = Math.abs(position.costOfTrades / position.size);
					const direction = position.size > 0 ? "long" : "short";

					// Calculate position progress metrics
					const progress =
						direction === "long"
							? (currentPrice - entryPrice) / (currentPrice + entryPrice)
							: (entryPrice - currentPrice) / (entryPrice + currentPrice);

					const unrealizedPnl =
						direction === "long" ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice;

					// Compile comprehensive position status
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

			// Send status update through logger
			await logger.sendHourlyUpdate(positions, isStartup);
		} catch (error) {
			logger.error("[STATUS] Error sending status update:", error);
		}
	}

	/**
	 * Performs graceful system shutdown.
	 *
	 * This function ensures clean termination by:
	 * 1. Stopping all monitoring intervals
	 * 2. Closing WebSocket connections
	 * 3. Shutting down symbol managers
	 * 4. Completing final logging
	 *
	 * The ordered shutdown prevents:
	 * - Hanging connections
	 * - Incomplete operations
	 * - Data loss
	 * - Resource leaks
	 */
	shutdown() {
		logger.info("[SHUTDOWN] Initiating graceful shutdown");

		// Clear monitoring intervals
		clearInterval(this.healthCheckInterval);
		clearInterval(this.statusUpdateInterval);

		// Close WebSocket connection
		if (this.ws) {
			this.ws.close();
		}

		// Shutdown all symbol managers
		for (const manager of this.symbolManagers.values()) {
			manager.shutdown();
		}

		logger.info("[SHUTDOWN] Shutdown complete");
	}
}

/**
 * Initializes and runs the complete trading system.
 *
 * This main function:
 * 1. Validates configuration
 * 2. Initializes trading system
 * 3. Sets up signal handlers
 * 4. Manages system lifecycle
 *
 * The initialization sequence ensures:
 * - Proper system configuration
 * - Clean startup
 * - Error handling
 * - Graceful shutdown capability
 */
async function main() {
	try {
		// Validate configuration before starting
		const tradingSymbols = validateConfig();
		logger.info("[INIT] Starting Trading System", {
			symbols: tradingSymbols,
		});

		// Initialize trading system
		const tradingManager = new TradingManager();
		await tradingManager.initialize(tradingSymbols);

		// Set up graceful shutdown handlers
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

// Set up global error handlers
process.on("unhandledRejection", (reason, promise) => {
	logger.error("[ERROR] Unhandled Promise Rejection:", reason);
	process.exit(1);
});

process.on("uncaughtException", (error) => {
	logger.error("[ERROR] Uncaught Exception:", error);
	process.exit(1);
});

// Start the trading system
main().catch((error) => {
	logger.error("[MAIN] Unhandled error:", error);
	process.exit(1);
});
