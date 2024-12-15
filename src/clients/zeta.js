import { Wallet, CrossClient, Exchange, Network, Market, utils, types, assets, constants, events } from "@zetamarkets/sdk";
import {
	PublicKey,
	Connection,
	Keypair,
	Transaction,
	TransactionMessage,
	VersionedTransaction,
	ComputeBudgetProgram,
} from "@solana/web3.js";
import fs from "fs";
import dotenv from "dotenv";
import logger from "../utils/logger.js";
import { BN, PriorityFeeMethod, PriorityFeeSubscriber, fetchSolanaPriorityFee } from "@drift-labs/sdk";

dotenv.config();

export class ZetaClientWrapper {
	constructor() {
		this.client = null;
		this.connection = null;
		this.connection_2 = null;
		this.connection_3 = null;
		this.wallet = null;
		this.activeMarket = constants.Asset.SOL;
		this.use_db_settings = true;

		this.priorityFees = null;
		this.priorityFeeMultiplier = 10;
		this.currentPriorityFee = 5_000;

		this.monitoringInterval = null;

		this.positionState = {
			isMonitoring: false,
			isAdjusting: false,
			marketIndex: null,
			position: null,
			orders: {
				takeProfit: null,
				stopLoss: null,
			},
			entryPrice: null,
			hasAdjustedStopLoss: false,
		};
	}

	roundToTickSize(price) {
		const tickSize = 0.0001;
		return Math.round(price / tickSize) * tickSize;
	}

	async initialize(markets = [constants.Asset.SOL], keypairPath = null) {
		try {
			const keyPath = keypairPath || process.env.KEYPAIR_FILE_PATH;
			this.connection = new Connection(process.env.RPC_TRADINGBOT);

			// Load wallet
			const secretKeyString = fs.readFileSync(keyPath, "utf8");
			const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
			const keypair = Keypair.fromSecretKey(secretKey);
			this.wallet = new Wallet(keypair);

			logger.info("Wallet initialized", { usingPath: keyPath });

			// Create client
			this.client = await CrossClient.load(
				this.connection,
				this.wallet,
				undefined,
				undefined,
				undefined,
				undefined,
				true,
				undefined
			);

			logger.info("ZetaClientWrapper initialized successfully");
		} catch (error) {
			logger.error("Initialization error:", error);
			throw error;
		}
	}

	async setupPriorityFees() {
		try {
			const config = {
				priorityFeeMethod: PriorityFeeMethod.SOLANA,
				frequencyMs: 5000,
				connection: this.connection,
			};

			logger.info("Initializing Solana Priority Fees with config:", {
				method: config.priorityFeeMethod,
				frequency: config.frequencyMs,
				hasConnection: !!this.connection,
			});

			this.priorityFees = new PriorityFeeSubscriber({
				...config,
				lookbackDistance: 150,
				addresses: [],
				connection: this.connection,
			});

			logger.info("Subscribing to priority fees...");
			await this.priorityFees.subscribe();

			logger.info("Loading priority fee data...");
			await this.priorityFees.load();

			const recentFees = await fetchSolanaPriorityFee(this.connection, 150, []);

			logger.info("Recent Priority Fees:", {
				numFees: recentFees?.length,
				latestFee: recentFees?.[0]?.prioritizationFee,
				oldestFee: recentFees?.[recentFees.length - 1]?.prioritizationFee,
				latestSlot: recentFees?.[0]?.slot,
				oldestSlot: recentFees?.[recentFees.length - 1]?.slot,
			});

			const initialFee = recentFees?.slice(0, 10).reduce((sum, fee) => sum + fee.prioritizationFee, 0) / 10 || 1_000;

			this.currentPriorityFee = Math.floor(initialFee * this.priorityFeeMultiplier);

			logger.info("Priority Fees Setup Complete", {
				subscriber: !!this.priorityFees,
				initialFee,
				adjustedFee: this.currentPriorityFee,
				multiplier: this.priorityFeeMultiplier,
			});
		} catch (error) {
			logger.error("Error setting up priority fees:", error);
			throw error;
		}
	}

	async updatePriorityFees() {
		try {
			if (!this.priorityFees) {
				throw new Error("Priority Fees not initialized");
			}

			await this.priorityFees.load();

			const recentFees = await fetchSolanaPriorityFee(this.connection, 150, []);

			const newFee =
				recentFees?.slice(0, 10).reduce((sum, fee) => sum + fee.prioritizationFee, 0) / 10 || this.currentPriorityFee;

			this.currentPriorityFee = Math.floor(newFee * this.priorityFeeMultiplier);

			logger.info("Updated Priority Fee:", {
				rawFee: newFee,
				adjustedFee: this.currentPriorityFee,
				multiplier: this.priorityFeeMultiplier,
			});

			Exchange.updatePriorityFee(this.currentPriorityFee);
		} catch (error) {
			logger.error("Error updating priority fees:", error);
			throw error;
		}
	}

	isExchangeInitialized() {
		return typeof Exchange !== "undefined" && Exchange && Exchange.initialized;
	}

	async getPosition(marketIndex) {
		try {
			await this.client.updateState();
			const positions = this.client.getPositions(marketIndex);
			console.log("Position check:", {
				marketIndex,
				hasPosition: !!positions[0],
				size: positions[0]?.size || 0,
			});
			return positions[0] || null;
		} catch (error) {
			logger.error("Error getting position:", error);
			throw error;
		}
	}

	getCalculatedMarkPrice(asset = this.activeMarket) {
		try {
			Exchange.getPerpMarket(asset).forceFetchOrderbook();
			const orderBook = Exchange.getOrderbook(asset);

			if (!orderBook?.asks?.[0]?.price || !orderBook?.bids?.[0]?.price) {
				throw new Error("Invalid orderbook data");
			}

			return Number((orderBook.asks[0].price + orderBook.bids[0].price) / 2);
		} catch (error) {
			logger.error("Error getting calculated mark price:", error);
			throw error;
		}
	}

	async adjustStopLossOrder(newPrices, asset, positionSize) {
    console.log("Reached threshold, do nothing for now.");
    return true;
  }

	async checkPositionProgress() {
		try {
			if (this.positionState.hasAdjustedStopLoss) {
				this.stopPositionMonitoring();
				return;
			}

			await this.client.updateState();

			const positions = this.client.getPositions(this.positionState.marketIndex);
			const currentPosition = positions[0];

			if (!currentPosition) {
				logger.info("Position closed, stopping monitoring");
				this.stopPositionMonitoring();
				return;
			}

			const currentPrice = await this.getCalculatedMarkPrice(this.positionState.marketIndex);
			const newStopLossPrices = this.calculateTrailingStopLoss(currentPrice);

			if (newStopLossPrices) {
				const adjustmentSuccess = await this.adjustStopLossOrder(newStopLossPrices);
				if (!adjustmentSuccess) {
					throw new Error("Failed to adjust stop loss");
				}

				const verificationSuccess = await this.verifyStopLossAdjustment(newStopLossPrices);
				if (!verificationSuccess) {
					throw new Error("Stop loss adjustment failed verification");
				}

				this.positionState.hasAdjustedStopLoss = true;
				this.stopPositionMonitoring();
			}
		} catch (error) {
			logger.error("Error checking position progress:", error);
			throw error;
		}
	}


	async cancelAllTriggerOrders(marketIndex) {
		const openTriggerOrders = await this.getTriggerOrders(marketIndex);

		if (openTriggerOrders && openTriggerOrders.length > 0) {
			logger.info("Found Trigger Orders, Cancelling...", openTriggerOrders);
			await this.client.cancelAllTriggerOrders(marketIndex);
			logger.info("Trigger Orders Cancelled.", triggerOrderTxs);
		} else {
			logger.info(`No Trigger Orders found.`);
		}
	}

	async openPosition(direction, marketIndex = this.activeMarket, makerOrTaker = "maker") {
		logger.info(`Opening ${direction} position for ${assets.assetToName(marketIndex)}`);

		const settings = this.fetchSettings();
		logger.info(`Using settings:`, settings);

		const balance = Exchange.riskCalculator.getCrossMarginAccountState(this.client.account).balance;
		const side = direction === "long" ? types.Side.BID : types.Side.ASK;

		const { currentPrice, adjustedPrice, positionSize, nativeLotSize } = this.calculatePricesAndSize(
			side,
			marketIndex,
			balance,
			settings,
			"taker"
		);

		const { takeProfitPrice, takeProfitTrigger, stopLossPrice, stopLossTrigger } = this.calculateTPSLPrices(
			direction,
			adjustedPrice,
			settings
		);

		logger.info(`
Opening ${direction} position:
------------------------------
    Take Profit ⟶ $${takeProfitPrice.toFixed(4)}
                      ↑ 
    TP Trigger ⟶ $${takeProfitTrigger.toFixed(4)}
                      ↑ 
-------- Entry ⟶ $${adjustedPrice.toFixed(4)} -----
                      ↓
    SL Trigger ⟶ $${stopLossTrigger.toFixed(4)}
                      ↓
      SL Price ⟶ $${stopLossPrice.toFixed(4)}
------------------------------`);

		// await this.updatePriorityFees();

		await this.client.updateState(true, true);

		let transaction = new Transaction().add(
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 350_000,
			})
		);

		const triggerBit_TP = this.client.findAvailableTriggerOrderBit();
		const triggerBit_SL = this.client.findAvailableTriggerOrderBit(triggerBit_TP + 1);

		const mainOrderIx = this.createMainOrderInstruction(marketIndex, adjustedPrice, nativeLotSize, side, "taker");
		const tpOrderIx = this.createTPOrderInstruction(
			direction,
			marketIndex,
			takeProfitPrice,
			takeProfitTrigger,
			nativeLotSize,
			triggerBit_TP
		);
		const slOrderIx = this.createSLOrderInstruction(
			direction,
			marketIndex,
			stopLossPrice,
			stopLossTrigger,
			nativeLotSize,
			triggerBit_SL
		);

		transaction.add(mainOrderIx);
		transaction.add(tpOrderIx);
		transaction.add(slOrderIx);

		try {
			const txid = await utils.processTransaction(
				this.client.provider,
				transaction,
				undefined,
				{
					skipPreflight: true,
					preflightCommitment: "confirmed",
					commitment: "confirmed",
				},
				false,
				utils.getZetaLutArr()
			);

			logger.info(`Transaction sent successfully. txid: ${txid}`);
			return txid;
		} catch (error) {
			// Categorize and enhance the error
			const errorContext = {
				direction,
				asset: assets.assetToName(marketIndex),
				type: error.name,
				details: error.message,
				code: error.code, // If provided by SDK
				timestamp: new Date().toISOString(),
			};

			// Log a single, comprehensive error message
			logger.error(`Failed to open ${direction} position for ${assets.assetToName(marketIndex)}`, errorContext);
		}
	}

	getTriggerOrders(marketIndex = this.activeMarket) {
		try {
			return this.client.getTriggerOrders(marketIndex);
		} catch (error) {
			logger.error("Error getting trigger orders:", error);
			throw error;
		}
	}

	fetchSettings() {
		const settings = {
			leverageMultiplier: 4,
			takeProfitPercentage: 0.036,
			stopLossPercentage: 0.018,
			trailingStopLoss: {
				progressThreshold: 0.6, // Updated default
				triggerDistance: 0.0525,
				stopLossDistance: 0.5,
			},
		};
		return settings;
	}

	calculateTPSLPrices(direction, price, settings) {
		// if (!direction || !price || !settings) {
		// 	throw new Error("Invalid inputs for TP/SL calculation");
		// }

		const { takeProfitPercentage, stopLossPercentage } = settings;
		const isLong = direction === "long";

		const takeProfitPrice = this.roundToTickSize(
			isLong ? price + price * takeProfitPercentage : price - price * takeProfitPercentage
		);

		const takeProfitTrigger = this.roundToTickSize(
			isLong ? price + (takeProfitPrice - price) * 0.95 : price - (price - takeProfitPrice) * 0.95
		);

		const stopLossPrice = this.roundToTickSize(isLong ? price - price * stopLossPercentage : price + price * stopLossPercentage);

		const stopLossTrigger = this.roundToTickSize(
			isLong ? price - (price - stopLossPrice) * 0.95 : price + (stopLossPrice - price) * 0.95
		);

		console.log("Calculated TP/SL Prices:", {
			direction,
			entryPrice: price.toFixed(4),
			takeProfit: {
				price: takeProfitPrice.toFixed(4),
				trigger: takeProfitTrigger.toFixed(4),
				percentage: (takeProfitPercentage * 100).toFixed(2) + "%",
			},
			stopLoss: {
				price: stopLossPrice.toFixed(4),
				trigger: stopLossTrigger.toFixed(4),
				percentage: (stopLossPercentage * 100).toFixed(2) + "%",
			},
		});

		return {
			takeProfitPrice,
			takeProfitTrigger,
			stopLossPrice,
			stopLossTrigger,
		};
	}

	calculatePricesAndSize(side, marketIndex, balance, settings, makerOrTaker = "maker") {
		// if (side === undefined || side === null || !marketIndex || !balance || !settings) {
		// 	throw new Error("Invalid inputs for price and size calculation");
		// }

		Exchange.getPerpMarket(marketIndex).forceFetchOrderbook();
		const orderbook = Exchange.getOrderbook(marketIndex);

		if (!orderbook?.asks?.[0]?.price || !orderbook?.bids?.[0]?.price) {
			throw new Error("Invalid orderbook data for price calculation");
		}

		const currentPrice = side === types.Side.BID ? orderbook.asks[0].price : orderbook.bids[0].price;
		const slippage = 0.0001;

		const adjustedPrice =
			makerOrTaker === "maker"
				? side === types.Side.BID
					? currentPrice + slippage
					: currentPrice - slippage
				: side === types.Side.BID
				? currentPrice * (1 + slippage * 5)
				: currentPrice * (1 - slippage * 5);

		const positionSize = (balance * settings.leverageMultiplier) / currentPrice;
		const decimalMinLotSize = utils.getDecimalMinLotSize(marketIndex);
		const lotSize = Math.floor(positionSize / decimalMinLotSize);
		const nativeLotSize = lotSize * utils.getNativeMinLotSize(marketIndex);

		logger.info(`Order Size: ${positionSize.toFixed(1)}`);
		logger.info(`Lot Size: ${lotSize}`);
		logger.info(`Native Lot Size: ${nativeLotSize}`);

		return {
			currentPrice,
			adjustedPrice,
			positionSize,
			nativeLotSize,
		};
	}

	createMainOrderInstruction(marketIndex, adjustedPrice, nativeLotSize, side, makerOrTaker = "maker") {
		return this.client.createPlacePerpOrderInstruction(
			marketIndex,
			utils.convertDecimalToNativeInteger(adjustedPrice),
			nativeLotSize,
			side,
			{
				orderType: makerOrTaker === "maker" ? types.OrderType.POSTONLYSLIDE : types.OrderType.LIMIT,
				tifOptions: {
					expiryOffset: 180,
				},
			}
		);
	}

	createTPOrderInstruction(direction, marketIndex, takeProfitPrice, takeProfitTrigger, nativeLotSize, triggerOrderBit = 0) {
		const tp_side = direction === "long" ? types.Side.ASK : types.Side.BID;
		const triggerDirection =
			direction === "long" ? types.TriggerDirection.GREATERTHANOREQUAL : types.TriggerDirection.LESSTHANOREQUAL;

		return this.client.createPlaceTriggerOrderIx(
			marketIndex,
			utils.convertDecimalToNativeInteger(takeProfitPrice),
			nativeLotSize,
			tp_side,
			utils.convertDecimalToNativeInteger(takeProfitTrigger),
			triggerDirection,
			new BN(0),
			types.OrderType.FILLORKILL,
			triggerOrderBit,
			{
				reduceOnly: true,
				tag: constants.DEFAULT_ORDER_TAG,
			}
		);
	}

	createSLOrderInstruction(direction, marketIndex, stopLossPrice, stopLossTrigger, nativeLotSize, triggerOrderBit = 1) {
		const sl_side = direction === "long" ? types.Side.ASK : types.Side.BID;
		const triggerDirection =
			direction === "long" ? types.TriggerDirection.LESSTHANOREQUAL : types.TriggerDirection.GREATERTHANOREQUAL;

		return this.client.createPlaceTriggerOrderIx(
			marketIndex,
			utils.convertDecimalToNativeInteger(stopLossPrice),
			nativeLotSize,
			sl_side,
			utils.convertDecimalToNativeInteger(stopLossTrigger),
			triggerDirection,
			new BN(0),
			types.OrderType.FILLORKILL,
			triggerOrderBit,
			{
				reduceOnly: true,
				tag: constants.DEFAULT_ORDER_TAG,
			}
		);
	}

	calculateTrailingStopLoss(currentPrice, customPercentage = null) {
		const { position, orders, entryPrice } = this.positionState;
		if (!position || !orders?.takeProfit || !entryPrice) {
			throw new Error("Invalid position state for trailing stop loss calculation");
		}

		const isShort = position.size < 0;
		const entryPriceDecimal = this.roundToTickSize(entryPrice / 1e6);
		const tpPriceDecimal = this.roundToTickSize(orders.takeProfit.orderPrice / 1e6);

		if (customPercentage !== null) {
			const stopLossPrice = this.roundToTickSize(
				isShort ? entryPriceDecimal * (1 + Math.abs(customPercentage)) : entryPriceDecimal * (1 - Math.abs(customPercentage))
			);

			const priceDistance = Math.abs(stopLossPrice - entryPriceDecimal);
			const triggerPrice = this.roundToTickSize(
				isShort ? entryPriceDecimal + priceDistance * 0.9 : entryPriceDecimal - priceDistance * 0.9
			);

			console.log("Price movement analysis:", {
				direction: isShort ? "SHORT" : "LONG",
				entryPrice: entryPriceDecimal.toFixed(4),
				customPercentage: (customPercentage * 100).toFixed(2) + "%",
				calculatedStopLoss: stopLossPrice.toFixed(4),
				calculatedTrigger: triggerPrice.toFixed(4),
			});

			logger.info(`
Direct Stop Loss Modification:
Entry: $${entryPriceDecimal.toFixed(4)}
New SL Price: $${stopLossPrice.toFixed(4)} (${(Math.abs(customPercentage) * 100).toFixed(1)}%)
New Trigger: $${triggerPrice.toFixed(4)}
`);

			return {
				orderPrice: utils.convertDecimalToNativeInteger(stopLossPrice),
				triggerPrice: utils.convertDecimalToNativeInteger(triggerPrice),
			};
		}

		const currentPriceDecimal = this.roundToTickSize(currentPrice);
		const totalDistance = Math.abs(tpPriceDecimal - entryPriceDecimal);
		const priceProgress = isShort ? entryPriceDecimal - currentPriceDecimal : currentPriceDecimal - entryPriceDecimal;
		const progressPercentage = priceProgress / totalDistance;

		console.log("Price movement analysis:", {
			direction: isShort ? "SHORT" : "LONG",
			entryPrice: entryPriceDecimal.toFixed(4),
			currentPrice: currentPriceDecimal.toFixed(4),
			tpPrice: tpPriceDecimal.toFixed(4),
			totalDistanceToTP: totalDistance.toFixed(4),
			currentProgressToTP: priceProgress.toFixed(4),
			progressPercentage: (progressPercentage * 100).toFixed(2) + "%",
			settings: {
				progressThreshold: (this.trailingSettings.progressThreshold * 100).toFixed(2) + "%",
				triggerPosition: (this.trailingSettings.triggerPricePosition * 100).toFixed(2) + "%",
				orderPosition: (this.trailingSettings.orderPricePosition * 100).toFixed(2) + "%",
			},
		});

		if (progressPercentage >= this.trailingSettings.progressThreshold) {
			const orderPrice = this.roundToTickSize(
				entryPriceDecimal + (isShort ? -1 : 1) * totalDistance * this.trailingSettings.orderPricePosition
			);

			const triggerPrice = this.roundToTickSize(
				entryPriceDecimal + (isShort ? -1 : 1) * totalDistance * this.trailingSettings.triggerPricePosition
			);

			logger.info(`
Trailing Stop Adjustment:
Direction: ${isShort ? "SHORT" : "LONG"}
Entry: $${entryPriceDecimal.toFixed(4)}
Current: $${currentPriceDecimal.toFixed(4)}
TP Target: $${tpPriceDecimal.toFixed(4)}
Progress: ${(progressPercentage * 100).toFixed(2)}%
New Trigger: $${triggerPrice.toFixed(4)}
New Order: $${orderPrice.toFixed(4)}
        `);

			return {
				orderPrice: utils.convertDecimalToNativeInteger(orderPrice),
				triggerPrice: utils.convertDecimalToNativeInteger(triggerPrice),
			};
		}

		return null;
	}

	async verifyStopLossAdjustment(newPrices, maxAttempts = 15) {
		const POLL_INTERVAL = 3000;
		const oldStopLossPrice = this.positionState.orders.stopLoss.orderPrice;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			await this.client.updateState();
			const triggerOrders = this.client.getTriggerOrders(this.positionState.marketIndex);
			const stopLoss = triggerOrders?.find(
				(order) => order.triggerOrderBit === this.positionState.orders.stopLoss.triggerOrderBit
			);

			if (stopLoss?.orderPrice !== oldStopLossPrice) {
				logger.info(`Stop loss adjusted after ${attempt} attempt(s)`);
				return true;
			}

			if (attempt < maxAttempts) {
				console.log(`Stop loss not adjusted, waiting ${POLL_INTERVAL}ms...`);
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
			}
		}

		console.log(`Stop loss not adjusted after ${maxAttempts} attempts`);
		return false;
	}

	stopPositionMonitoring() {
		if (this.monitoringInterval) {
			clearInterval(this.monitoringInterval);
			this.monitoringInterval = null;
			this.positionState = {
				isMonitoring: false,
				isAdjusting: false,
				marketIndex: null,
				position: null,
				orders: {
					takeProfit: null,
					stopLoss: null,
				},
				entryPrice: null,
				hasAdjustedStopLoss: false,
			};
		}
		console.log("[MONITOR] Stopped position monitoring");
	}
}
