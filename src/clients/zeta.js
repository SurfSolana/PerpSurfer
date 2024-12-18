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

export async function initializeExchange(markets) {
	const connection = new Connection(process.env.RPC_TRADINGBOT);

	// Create set of markets to load
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
		25, // 50rps chainstack = 20ms delay, set to 25 for funzies
		true,
		connection,
		marketsArray,
		undefined,
		marketsArray
	);

	await Exchange.load(loadExchangeConfig);

	logger.info("Exchange loaded successfully");

	Exchange.setUseAutoPriorityFee(false);
	await updatePriorityFees();

	return { connection };
}

export async function updatePriorityFees() {
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

	console.log("Fees: ", data.result.priorityFeeLevels);

	// Fees:  {
	//  min: 0,
	//  low: 0,
	//  medium: 1,
	//  high: 120000,
	//  veryHigh: 10526633,
	//  unsafeMax: 3988354006
	//  }

	Exchange.updatePriorityFee(data.result.priorityFeeLevels.high);

	console.log("Set Fee Level to high: ", data.result.priorityFeeLevels.high);
}

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
        preflightCommitment: "finalized",
        commitment: "finalized",
      },
      25,
      true,
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

		this.connection = connection;

		// Load wallet
		const secretKeyString = fs.readFileSync(keyPath, "utf8");
		const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
		const keypair = Keypair.fromSecretKey(secretKey);
		this.wallet = new Wallet(keypair);


			// Create client
			this.client = await CrossClient.load(
				this.connection, // connection: Connection,
				this.wallet, // wallet: types.Wallet,
        { skipPreflight: true, preflightCommitment: "finalized", commitment: "finalized"}, // opts: ConfirmOptions = utils.defaultCommitment(),
        undefined, // callback
				false, // throttle: boolean = false
				undefined, // delegator : PublicKey = undefined,
				true, // useVersionedTxs: boolean = false,
			);

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
		Exchange.updatePriorityFee(data.result.priorityFeeLevels.high * 1.25);

		console.log("Fees: ", data.result.priorityFeeLevels);
		console.log("Fee Level (high): ", data.result.priorityFeeLevels.high);
		console.log("Exchange set to fee * 1.25:", Exchange._priorityFee);
	}

	isExchangeInitialized() {
		return typeof Exchange !== "undefined" && Exchange && Exchange.initialized;
	}

  async getPosition(marketIndex) {
    try {
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
		Exchange.getPerpMarket(asset).forceFetchOrderbook();
		const orderBook = Exchange.getOrderbook(asset);

		if (!orderBook?.asks?.[0]?.price || !orderBook?.bids?.[0]?.price) {
			throw new Error("Invalid orderbook data");
		}

	// async adjustStopLossOrder(newPrices, asset, positionSize) {
	// 	console.log("Reached threshold, do nothing for now.");
	// 	return true;
	// }

	// async checkPositionProgress() {
	// 	try {
	// 		if (this.positionState.hasAdjustedStopLoss) {
	// 			this.stopPositionMonitoring();
	// 			return;
	// 		}

	// 		await this.client.updateState();

	// 		const positions = this.client.getPositions(this.positionState.marketIndex);
	// 		const currentPosition = positions[0];

	// 		if (!currentPosition) {
	// 			logger.info("Position closed, stopping monitoring");
	// 			this.stopPositionMonitoring();
	// 			return;
	// 		}

	// 		const currentPrice = await this.getCalculatedMarkPrice(this.positionState.marketIndex);
	// 		const newStopLossPrices = this.calculateTrailingStopLoss(currentPrice);

	// 		if (newStopLossPrices) {
	// 			const adjustmentSuccess = await this.adjustStopLossOrder(newStopLossPrices);
	// 			if (!adjustmentSuccess) {
	// 				throw new Error("Failed to adjust stop loss");
	// 			}

	// 			const verificationSuccess = await this.verifyStopLossAdjustment(newStopLossPrices);
	// 			if (!verificationSuccess) {
	// 				throw new Error("Stop loss adjustment failed verification");
	// 			}

	// 			this.positionState.hasAdjustedStopLoss = true;
	// 			this.stopPositionMonitoring();
	// 		}
	// 	} catch (error) {
	// 		logger.error("Error checking position progress:", error);
	// 		throw error;
	// 	}
	// }

	async cancelAllTriggerOrders(marketIndex) {
    await this.client.updateState();
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


	async openPosition(direction, marketIndex = this.activeMarket, makerOrTaker = "maker") {
		logger.info(`Opening ${direction} position for ${assets.assetToName(marketIndex)}`);

		const settings = this.fetchSettings();
		logger.info(`Using settings:`, settings);

		await this.client.updateState(true, true);

		let transaction = new Transaction().add(
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 500_000,
			})
		);

		let assetIndex = assets.assetToIndex(marketIndex);
		let market = Exchange.getPerpMarket(marketIndex);
		let openOrdersPda = null;
		if (this.client._openOrdersAccounts[assetIndex].equals(PublicKey.default)) {
		  console.log(
		    `[${assets.assetToName(
		      marketIndex
		    )}] User doesn't have open orders account. Initialising for asset ${marketIndex}.`
		  );

		  let [initIx, _openOrdersPda] = instructions.initializeOpenOrdersV3Ix(
		    marketIndex,
		    Exchange.getPerpMarket(marketIndex).address,
		    this.client._provider.wallet.publicKey,
		    this.client._accountAddress
		  );
		  openOrdersPda = _openOrdersPda;
		  transaction.add(initIx);
		} else {
		  openOrdersPda = this.client._openOrdersAccounts[assetIndex];
		}

		const balance = Exchange.riskCalculator.getCrossMarginAccountState(this.client.account).balance;

		console.log(`BALANCE:`, balance);

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

		await updatePriorityFees();

		const triggerBit_TP = this.client.findAvailableTriggerOrderBit() || 0;
		const triggerBit_SL = this.client.findAvailableTriggerOrderBit(triggerBit_TP + 1) || 1;

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
					preflightCommitment: "finalized",
					commitment: "finalized",
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

		await this.client.updateState();

		await updatePriorityFees();

		const side = direction == "long" ? types.Side.ASK : types.Side.BID;

		const closePrice = this.getClosePrice(marketIndex, side);

		let transaction = new Transaction();

		const mainOrderIx = this.createMainOrderInstruction(marketIndex, closePrice, nativeLotSize, side, "taker");

		transaction.add(mainOrderIx);

		try {
			const txid = await utils.processTransaction(
				this.client.provider,
				transaction,
				undefined,
				{
					skipPreflight: true,
					preflightCommitment: "finalized",
					commitment: "finalized",
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

	getClosePrice(marketIndex, side) {
		// Get orderbook data
		Exchange.getPerpMarket(marketIndex).forceFetchOrderbook();
		const orderbook = Exchange.getOrderbook(marketIndex);

		if (!orderbook?.asks?.[0]?.price || !orderbook?.bids?.[0]?.price) {
			throw new Error("Invalid orderbook data for price calculation");
		}

		// Calculate current price based on side
		const currentPrice = side === types.Side.BID ? orderbook.asks[0].price : orderbook.bids[0].price;

		const makerOrTaker = "taker";

		// Calculate adjusted price with slippage
		const slippage = 0.0001;
		const closePrice = this.roundToTickSize(
			makerOrTaker === "maker"
				? side === types.Side.BID
					? currentPrice + slippage
					: currentPrice - slippage
				: side === types.Side.BID
				? currentPrice * (1 + slippage * 5)
				: currentPrice * (1 - slippage * 5)
		);

		return closePrice;
	}

	getTriggerOrders(marketIndex = this.activeMarket) {
		try {
			return this.client.getTriggerOrders(marketIndex);
		} catch (error) {
			logger.error("Error getting trigger orders:", error);
			throw error;
		}

		await this.client.updateState(true, true);

		await updatePriorityFees();

		const settings = this.fetchSettings();

		logger.info(`Using settings:`, settings);

		const balance = Exchange.riskCalculator.getCrossMarginAccountState(
			this.client.account
		).balance;
		const side = direction === "long" ? types.Side.BID : types.Side.ASK;

		const { currentPrice, adjustedPrice, positionSize, nativeLotSize } =
			this.calculatePricesAndSize(
				side,
				marketIndex,
				balance,
				settings,
				"taker"
			);

		const {
			takeProfitPrice,
			takeProfitTrigger,
			stopLossPrice,
			stopLossTrigger,
		} = this.calculateTPSLPrices(direction, adjustedPrice, settings);

		logger.info(`
  Opening ${direction} position:
  ------------------------------
      Take Profit ⟶ $${takeProfitPrice}
                        ↑ 
      TP Trigger ⟶ $${takeProfitTrigger}
                        ↑ 
  -------- Entry ⟶ $${adjustedPrice} -----
                        ↓
      SL Trigger ⟶ $${stopLossTrigger}
                        ↓
        SL Price ⟶ $${stopLossPrice}
  ------------------------------`);

		await this.client.updateState(true, true);

		let transaction = new Transaction();

		let triggerBit_TP = this.client.findAvailableTriggerOrderBit();
		let triggerBit_SL = this.client.findAvailableTriggerOrderBit(
			triggerBit_TP + 1
		);

		const mainOrderIx = this.createMainOrderInstruction(
			marketIndex,
			adjustedPrice,
			nativeLotSize,
			side,
			"taker"
		);
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
					preflightCommitment: "finalized",
					commitment: "finalized",
				},
				false,
				utils.getZetaLutArr()
			);

			logger.info(`Transaction sent successfully. txid: ${txid}`);

			return txid;
		} catch (error) {
			logger.error(`Open Position TX Error:`, error);
		}
	}

	async getTriggerOrders(marketIndex = this.activeMarket) {
		const triggerOrders = await this.client.getTriggerOrders(marketIndex);
		return triggerOrders;
	}

	fetchSettings() {
		const settings = {
			leverageMultiplier: 0.1,
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
				: currentPrice * (1 - slippage * 5)
		);

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

		// logger.info(`Order Size: ${positionSize.toFixed(6)}`);
		// logger.info(`Rounded Lot Size: ${lotSize}`);
		// logger.info(`Native Lot Size: ${nativeLotSize}`);

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

// 	calculateTrailingStopLoss(currentPrice, customPercentage = null) {
// 		const { position, orders, entryPrice } = this.positionState;
// 		if (!position || !orders?.takeProfit || !entryPrice) {
// 			throw new Error("Invalid position state for trailing stop loss calculation");
// 		}

// 		const isShort = position.size < 0;
// 		const entryPriceDecimal = this.roundToTickSize(entryPrice / 1e6);
// 		const tpPriceDecimal = this.roundToTickSize(orders.takeProfit.orderPrice / 1e6);

// 		if (customPercentage !== null) {
// 			const stopLossPrice = this.roundToTickSize(
// 				isShort ? entryPriceDecimal * (1 + Math.abs(customPercentage)) : entryPriceDecimal * (1 - Math.abs(customPercentage))
// 			);

// 			const priceDistance = Math.abs(stopLossPrice - entryPriceDecimal);
// 			const triggerPrice = this.roundToTickSize(
// 				isShort ? entryPriceDecimal + priceDistance * 0.9 : entryPriceDecimal - priceDistance * 0.9
// 			);

// 			console.log("Price movement analysis:", {
// 				direction: isShort ? "SHORT" : "LONG",
// 				entryPrice: entryPriceDecimal.toFixed(4),
// 				customPercentage: (customPercentage * 100).toFixed(2) + "%",
// 				calculatedStopLoss: stopLossPrice.toFixed(4),
// 				calculatedTrigger: triggerPrice.toFixed(4),
// 			});

// 			logger.info(`
// Direct Stop Loss Modification:
// Entry: $${entryPriceDecimal.toFixed(4)}
// New SL Price: $${stopLossPrice.toFixed(4)} (${(Math.abs(customPercentage) * 100).toFixed(1)}%)
// New Trigger: $${triggerPrice.toFixed(4)}
// `);

// 			return {
// 				orderPrice: utils.convertDecimalToNativeInteger(stopLossPrice),
// 				triggerPrice: utils.convertDecimalToNativeInteger(triggerPrice),
// 			};
// 		}

// 		const currentPriceDecimal = this.roundToTickSize(currentPrice);
// 		const totalDistance = Math.abs(tpPriceDecimal - entryPriceDecimal);
// 		const priceProgress = isShort ? entryPriceDecimal - currentPriceDecimal : currentPriceDecimal - entryPriceDecimal;
// 		const progressPercentage = priceProgress / totalDistance;

// 		console.log("Price movement analysis:", {
// 			direction: isShort ? "SHORT" : "LONG",
// 			entryPrice: entryPriceDecimal.toFixed(4),
// 			currentPrice: currentPriceDecimal.toFixed(4),
// 			tpPrice: tpPriceDecimal.toFixed(4),
// 			totalDistanceToTP: totalDistance.toFixed(4),
// 			currentProgressToTP: priceProgress.toFixed(4),
// 			progressPercentage: (progressPercentage * 100).toFixed(2) + "%",
// 			settings: {
// 				progressThreshold: (this.trailingSettings.progressThreshold * 100).toFixed(2) + "%",
// 				triggerPosition: (this.trailingSettings.triggerPricePosition * 100).toFixed(2) + "%",
// 				orderPosition: (this.trailingSettings.orderPricePosition * 100).toFixed(2) + "%",
// 			},
// 		});

// 		if (progressPercentage >= this.trailingSettings.progressThreshold) {
// 			const orderPrice = this.roundToTickSize(
// 				entryPriceDecimal + (isShort ? -1 : 1) * totalDistance * this.trailingSettings.orderPricePosition
// 			);

// 			const triggerPrice = this.roundToTickSize(
// 				entryPriceDecimal + (isShort ? -1 : 1) * totalDistance * this.trailingSettings.triggerPricePosition
// 			);

// 			logger.info(`
// Trailing Stop Adjustment:
// Direction: ${isShort ? "SHORT" : "LONG"}
// Entry: $${entryPriceDecimal.toFixed(4)}
// Current: $${currentPriceDecimal.toFixed(4)}
// TP Target: $${tpPriceDecimal.toFixed(4)}
// Progress: ${(progressPercentage * 100).toFixed(2)}%
// New Trigger: $${triggerPrice.toFixed(4)}
// New Order: $${orderPrice.toFixed(4)}
//         `);

// 			return {
// 				orderPrice: utils.convertDecimalToNativeInteger(orderPrice),
// 				triggerPrice: utils.convertDecimalToNativeInteger(triggerPrice),
// 			};
// 		}

// 		return null;
// 	}

	// async verifyStopLossAdjustment(newPrices, maxAttempts = 15) {
	// 	const POLL_INTERVAL = 3000;
	// 	const oldStopLossPrice = this.positionState.orders.stopLoss.orderPrice;

	// 	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
	// 		await this.client.updateState();
	// 		const triggerOrders = this.client.getTriggerOrders(this.positionState.marketIndex);
	// 		const stopLoss = triggerOrders?.find(
	// 			(order) => order.triggerOrderBit === this.positionState.orders.stopLoss.triggerOrderBit
	// 		);

	// 		if (stopLoss?.orderPrice !== oldStopLossPrice) {
	// 			logger.info(`Stop loss adjusted after ${attempt} attempt(s)`);
	// 			return true;
	// 		}

	// 		if (attempt < maxAttempts) {
	// 			console.log(`Stop loss not adjusted, waiting ${POLL_INTERVAL}ms...`);
	// 			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
	// 		}
	// 	}

	// 	console.log(`Stop loss not adjusted after ${maxAttempts} attempts`);
	// 	return false;
	// }

	// stopPositionMonitoring() {
	// 	if (this.monitoringInterval) {
	// 		clearInterval(this.monitoringInterval);
	// 		this.monitoringInterval = null;
	// 		this.positionState = {
	// 			isMonitoring: false,
	// 			isAdjusting: false,
	// 			marketIndex: null,
	// 			position: null,
	// 			orders: {
	// 				takeProfit: null,
	// 				stopLoss: null,
	// 			},
	// 			entryPrice: null,
	// 			hasAdjustedStopLoss: false,
	// 		};
	// 	}
	// 	console.log("[MONITOR] Stopped position monitoring");
	// }
}
