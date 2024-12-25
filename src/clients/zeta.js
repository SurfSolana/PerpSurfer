import {
	Wallet,
	CrossClient,
	Exchange,
	Network,
	Market,
	instructions,
	utils,
	types,
	assets,
	constants,
	events,
} from "@zetamarkets/sdk";
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
import { BN } from "@drift-labs/sdk";

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

	async initializeExchange(markets) {
		// Initialize connection and exchange
		this.connection = new Connection(process.env.RPC_TRADINGBOT);

		// Create set of markets to load
		const marketsToLoad = new Set([constants.Asset.SOL, ...markets]);
		const marketsArray = Array.from(marketsToLoad);

		const loadExchangeConfig = types.defaultLoadExchangeConfig(
			Network.MAINNET,
			this.connection,
			{
				skipPreflight: true,
				preflightCommitment: "confirmed",
				commitment: "confirmed",
			},
			25,
			true
			// this.connection,
			// marketsArray,
			// undefined,
			// marketsArray
		);

		await Exchange.load(loadExchangeConfig);
		logger.info("Exchange loaded successfully");
	}

	async initialize(keypairPath = null) {
		try {
			const keyPath = keypairPath || process.env.KEYPAIR_FILE_PATH;

			// Load wallet
			const secretKeyString = fs.readFileSync(keyPath, "utf8");
			const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
			const keypair = Keypair.fromSecretKey(secretKey);
			this.wallet = new Wallet(keypair);

			logger.info("Wallet initialized", { usingPath: keyPath });

			// Create client
			this.client = await CrossClient.load(
				this.connection, // connection: Connection,
				this.wallet, // wallet: types.Wallet,
				{ skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" }, // opts: ConfirmOptions = utils.defaultCommitment(),
				undefined, // callback
				false, // throttle: boolean = false
				undefined, // delegator : PublicKey = undefined,
				true // useVersionedTxs: boolean = false,
			);

			logger.info("ZetaClientWrapper initialized successfully");
		} catch (error) {
			logger.error("Initialization error:", error);
			throw error;
		}
	}

	async updatePriorityFees() {
		const helius_url = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

		const response = await fetch(helius_url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "getPriorityFeeEstimate",
				params: [
					{
						accountKeys: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
						options: {
							includeAllPriorityFeeLevels: true,
						},
					},
				],
			}),
		});

		const data = await response.json();

		/*
    ============================================
     data.result.priorityFeeLevels.___
    ============================================
    Valid Options: min, low, medium, ** high **, 
                   veryHigh, unsafeMax
    */

		Exchange.setUseAutoPriorityFee(false);
		Exchange.updatePriorityFee(Math.floor(data.result.priorityFeeLevels.high * 1.25));

		console.log("Fees: ", data.result.priorityFeeLevels);
		console.log("Fee Level (high): ", data.result.priorityFeeLevels.high);
		console.log("Exchange set to fee * 1.25:", Exchange._priorityFee);
	}

	isExchangeInitialized() {
		return typeof Exchange !== "undefined" && Exchange && Exchange.initialized;
	}

	async getPosition(marketIndex) {
		try {
			await Exchange.updateState();
			await this.client.updateState(true, true);
			const positions = await this.client.getPositions(marketIndex);
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
		const { markPrice } = this.getMarkPriceAndSpread(asset);
		return markPrice;

		/* 12/20/24 replacing functionality with forwarded value
    ********************************************************
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
    */
	}

	async cancelAllTriggerOrders(marketIndex) {
		await this.updatePriorityFees();

		await Exchange.updateState();

		await this.client.updateState(true, true);

		const openTriggerOrders = await this.getTriggerOrders(marketIndex);

		if (openTriggerOrders && openTriggerOrders.length > 0) {
			logger.info("Found Trigger Orders, Cancelling...", openTriggerOrders);
			const txids = await this.client.cancelAllTriggerOrders(marketIndex);
			logger.info("Trigger Orders Cancelled.");
			return txids;
		} else {
			logger.info(`No Trigger Orders found.`);
		}
	}

	async openPosition(direction, marketIndex = this.activeMarket, makerOrTaker = "taker") {
		logger.info(`Opening ${direction} position for ${assets.assetToName(marketIndex)}`);

		const settings = this.fetchSettings();

		logger.info(`Using settings:`, settings);

		await this.client.updateState(true, true);

		let transaction = new Transaction().add(
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 350_000,
			})
		);

		const balance = Exchange.riskCalculator.getCrossMarginAccountState(this.client.account).balance;

		console.log(`BALANCE:`, balance);

		const side = direction === "long" ? types.Side.BID : types.Side.ASK;

		const { currentPrice, adjustedPrice, positionSize, nativeLotSize } = await this.calculatePricesAndSize(
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

		await this.updatePriorityFees();

		await Exchange.updateState();

		await this.client.updateState(true, true);

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
		// transaction.add(tpOrderIx);
		// transaction.add(slOrderIx);

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

	async closePosition(direction, marketIndex) {
		await this.updatePriorityFees();

		await Exchange.updateState();

		await this.client.updateState(true, true);

		let position = await this.client.getPositions(marketIndex); // <- RIGHT WAY

		console.log(position);

		if (position) {
			position = position[0];
			logger.info(`Closing position for ${assets.assetToName(marketIndex)}`, position);
		} else {
			logger.info(`No position to close for ${assets.assetToName(marketIndex)}`);
			return;
		}

		// Calculate position size
		const rawPositionSize = Math.abs(position.size);
		const decimalMinLotSize = utils.getDecimalMinLotSize(marketIndex);
		const lotSize = Math.round(rawPositionSize / decimalMinLotSize);
		const nativeLotSize = lotSize * utils.getNativeMinLotSize(marketIndex);
		const actualPositionSize = lotSize * decimalMinLotSize;

		logger.info(`Lots Debug:`, {
			rawPositionSize,
			decimalMinLotSize,
			lotSize,
			nativeLotSize,
			actualPositionSize,
		});

		await this.updatePriorityFees();

		await Exchange.updateState();

		await this.client.updateState(true, true);

		const side = direction == "long" ? types.Side.ASK : types.Side.BID;

		const closePrice = await this.getClosePrice(marketIndex, side);

		let transaction = new Transaction();

		const mainOrderIx = this.createCloseOrderInstruction(marketIndex, closePrice, nativeLotSize, side, "taker");

		transaction.add(mainOrderIx);

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
			logger.error(`Close Position TX Error:`, error);
		}
	}

	async getClosePrice(marketIndex, side) {
		try {
			const { bestAsk, bestBid, spread } = await this.waitForAcceptableSpread(marketIndex);

			// Calculate current price based on side
			const currentPrice = side === types.Side.BID ? bestAsk : bestBid;

			const makerOrTaker = "taker";
			const slippage = 0.0001;

			// Calculate adjusted price with slippage
			const adjustedPrice =
				makerOrTaker === "taker"
					? side === types.Side.BID
						? bestAsk - slippage
						: bestBid + slippage
					: side === types.Side.BID
					? bestAsk * (1 + slippage * 5)
					: bestBid * (1 - slippage * 5);

      const closePrice = adjustedPrice;

			logger.info("Close price calculation:", {
				market: assets.assetToName(marketIndex),
				side: side === types.Side.BID ? "BUY" : "SELL",
				spread: spread.toFixed(4) + "%",
				bestAsk: bestAsk.toFixed(4),
				bestBid: bestBid.toFixed(4),
				closePrice: closePrice.toFixed(4),
			});

			return closePrice;
		} catch (error) {
			logger.error("Error calculating close price:", error);
			throw error;
		}
	}

	// 12/20/24 replaced with above
	// ************************************
	// getClosePrice(marketIndex, side) {
	// 	// Get orderbook data
	// 	Exchange.getPerpMarket(marketIndex).forceFetchOrderbook();
	// 	const orderbook = Exchange.getOrderbook(marketIndex);

	// 	if (!orderbook?.asks?.[0]?.price || !orderbook?.bids?.[0]?.price) {
	// 		throw new Error("Invalid orderbook data for price calculation");
	// 	}

	// 	// Calculate current price based on side
	// 	const currentPrice = side === types.Side.BID ? orderbook.asks[0].price : orderbook.bids[0].price;

	// 	const makerOrTaker = "taker";

	// 	// Calculate adjusted price with slippage
	// 	const slippage = 0.0001;
	// 	const closePrice = this.roundToTickSize(
	// 		makerOrTaker === "maker"
	// 			? side === types.Side.BID
	// 				? currentPrice + slippage
	// 				: currentPrice - slippage
	// 			: side === types.Side.BID
	// 			? currentPrice * (1 + slippage * 5)
	// 			: currentPrice * (1 - slippage * 5)
	// 	);

	// 	return closePrice;
	// }

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
				progressThreshold: 0.3,
				stopLossDistance: 0.1,
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

	async calculatePricesAndSize(side, marketIndex, balance, settings, makerOrTaker = "taker") {
		if (side === undefined || side === null || !marketIndex || !balance || !settings) {
			throw new Error("Invalid inputs for price and size calculation");
		}

		const { markPrice, bestAsk, bestBid, spread } = await this.waitForAcceptableSpread(marketIndex);

		const slippage = 0.0001;
		const adjustedPrice =
			makerOrTaker === "taker"
				? side === types.Side.BID
					? bestAsk - slippage
					: bestBid + slippage
				: side === types.Side.BID
				? bestAsk * (1 + slippage * 5)
				: bestBid * (1 - slippage * 5);

		const positionSize = (balance * settings.leverageMultiplier) / adjustedPrice;
		const decimalMinLotSize = utils.getDecimalMinLotSize(marketIndex);
		const lotSize = Math.floor(positionSize / decimalMinLotSize);
		const nativeLotSize = lotSize * utils.getNativeMinLotSize(marketIndex);

		logger.info(`Lots Debug:`, {
			currentPrice: markPrice,
			bestAsk: bestAsk,
			bestBid: bestBid,
			adjustedPrice: adjustedPrice,
			positionSize: positionSize,
			decimalMinLotSize: decimalMinLotSize,
			lotSize: lotSize,
			nativeLotSize: nativeLotSize,
		});

		return {
			currentPrice: markPrice,
			adjustedPrice,
			positionSize,
			nativeLotSize,
			spread,
		};
	}

	/* 12/20/24 replaced with above
  *********************************
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
		const lotSize = Math.round(positionSize / decimalMinLotSize);
		const nativeLotSize = lotSize * utils.getNativeMinLotSize(marketIndex);

		logger.info(`Lots Debug:`, {
			positionSize,
			decimalMinLotSize,
			lotSize,
			nativeLotSize
		});

		return {
			currentPrice,
			adjustedPrice,
			positionSize,
			nativeLotSize,
		};
	}
  */

	getMarkPriceAndSpread(asset = this.activeMarket) {
		try {
      Exchange.updateState();
			Exchange.getPerpMarket(asset).forceFetchOrderbook();
			const orderbook = Exchange.getOrderbook(asset);

			if (!orderbook?.asks?.[0]?.price || !orderbook?.bids?.[0]?.price) {
				throw new Error("Invalid orderbook data");
			}

			const bestAsk = orderbook.asks[0].price;
			const bestBid = orderbook.bids[0].price;
			const markPrice = (bestAsk + bestBid) / 2;
			const spread = ((bestAsk - bestBid) / markPrice) * 100;

			return {
				markPrice,
				bestAsk,
				bestBid,
				spread,
			};
		} catch (error) {
			logger.error("Error getting mark price and spread:", error);
			throw error;
		}
	}

	async waitForAcceptableSpread(marketIndex, maxWaitTime = 30000, pollInterval = 1000) {
		const startTime = Date.now();
		const MAX_SPREAD = 0.3;
		let attempts = 0;

		while (Date.now() - startTime < maxWaitTime) {
			try {
				const marketData = this.getMarkPriceAndSpread(marketIndex);
				attempts++;

				logger.info("Checking spread:", {
					market: assets.assetToName(marketIndex),
					spread: marketData.spread.toFixed(4) + "%",
					maxSpread: MAX_SPREAD.toFixed(4) + "%",
					attempt: attempts,
					elapsedTime: ((Date.now() - startTime) / 1000).toFixed(1) + "s",
				});

				if (marketData.spread <= MAX_SPREAD) {
					return marketData;
				}

				await new Promise((resolve) => setTimeout(resolve, pollInterval));
			} catch (error) {
				logger.error("Error checking spread:", error);
				throw error;
			}
		}

		throw new Error(`Unable to find acceptable spread after ${maxWaitTime / 1000}s`);
	}

	createMainOrderInstruction(marketIndex, adjustedPrice, nativeLotSize, side, makerOrTaker = "taker") {
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

	createCloseOrderInstruction(marketIndex, adjustedPrice, nativeLotSize, side, makerOrTaker = "taker") {
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
				reduceOnly: true,
				tag: constants.DEFAULT_ORDER_TAG,
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
}
