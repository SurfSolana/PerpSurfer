import {
	Wallet,
	CrossClient,
	Exchange,
	Network,
	Market,
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
import {
	BN,
	PriorityFeeMethod,
	PriorityFeeSubscriber,
	fetchSolanaPriorityFee,
} from "@drift-labs/sdk";
import readline from "readline";

dotenv.config();

export class ZetaClientWrapper {
	constructor() {
		this.client = null;
		this.connection = null;
		this.wallet = null;
		this.activeMarket = constants.Asset.SOL;
		this.use_db_settings = true;

		this.priorityFees = null;
		this.priorityFeeMultiplier = 8;
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

		this.settings = {
			leverageMultiplier: 4,
			takeProfitPercentage: 0.036,
			stopLossPercentage: 0.018,
			trailingStopLoss: {
				progressThreshold: 0.6,
				stopLossDistance: 0.4,
				triggerDistance: 0.45,
			},
		};
	}

	roundToTickSize(nativePrice) {
		// Convert from native integer to decimal first
		const decimalPrice = nativePrice / 1e6;
		// Round to the nearest tick (0.0001)
		const tickSize = 0.0001;
		const roundedDecimal = Math.round(decimalPrice / tickSize) * tickSize;
		// Convert back to native integer
		return Math.round(roundedDecimal * 1e6);
	}

	async initializeClient(keypairPath = null) {
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

	async initializeExchange(markets) {
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
				150,
				true,
				connection,
				marketsArray,
				undefined,
				marketsArray
			);

			await Exchange.load(loadExchangeConfig);
			logger.info("Exchange loaded successfully");

			this.setupPriorityFees();
			this.updatePriorityFees();

			return { connection };
		} catch (error) {
			logger.error("Error initializing exchange:", error);
			throw error;
		}
	}

	async setupPriorityFees() {
		try {
			const config = {
				priorityFeeMethod: PriorityFeeMethod.DRIFT,
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

			const initialFee =
				recentFees
					?.slice(0, 10)
					.reduce((sum, fee) => sum + fee.prioritizationFee, 0) / 10 || 1_000;

			this.currentPriorityFee = Math.floor(
				initialFee * this.priorityFeeMultiplier
			);

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
				recentFees
					?.slice(0, 10)
					.reduce((sum, fee) => sum + fee.prioritizationFee, 0) / 10 ||
				this.currentPriorityFee;

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
		try {
			logger.info("Starting stop loss adjustment process", {
				asset: assets.assetToName(asset),
				positionSize: positionSize?.toString(),
				hasNewPrices: !!newPrices,
			});

			// Get current trigger orders
			const triggerOrders = await this.getTriggerOrders(asset);
			logger.info("Retrieved current trigger orders", {
				totalOrders: triggerOrders?.length || 0,
				orderTypes: triggerOrders?.map((order) => ({
					bit: order.triggerOrderBit,
					side: order.side === types.Side.BID ? "BID" : "ASK",
					direction:
						order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL
							? "GREATER_THAN_OR_EQUAL"
							: "LESS_THAN_OR_EQUAL",
				})),
			});

			const isShort = positionSize < 0;

			// Find the stop loss order with detailed logging
			logger.info("Searching for stop loss order", {
				positionType: isShort ? "SHORT" : "LONG",
				expectedDirection: isShort
					? "GREATER_THAN_OR_EQUAL"
					: "LESS_THAN_OR_EQUAL",
			});

			const stopLoss = triggerOrders.find((order) =>
				isShort
					? order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL
					: order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL
			);

			if (!stopLoss) {
				logger.error("Stop loss order not found in current orders");
				throw new Error("Stop loss order not found");
			}

			logger.info("Found existing stop loss order", {
				orderDetails: {
					bit: stopLoss.triggerOrderBit,
					currentOrderPrice: this.roundToTickSize(stopLoss.orderPrice / 1e6),
					currentTriggerPrice: this.roundToTickSize(
						stopLoss.triggerPrice / 1e6
					),
					size: stopLoss.size.toString(),
					side: stopLoss.side === types.Side.BID ? "BID" : "ASK",
					direction:
						stopLoss.triggerDirection ===
						types.TriggerDirection.GREATERTHANOREQUAL
							? "GREATER_THAN_OR_EQUAL"
							: "LESS_THAN_OR_EQUAL",
				},
			});

			if (
				!newPrices?.orderPrice ||
				!newPrices?.triggerPrice ||
				typeof newPrices.orderPrice !== "number" ||
				typeof newPrices.triggerPrice !== "number"
			) {
				logger.error("Invalid price inputs", {
					receivedPrices: newPrices,
					orderPriceType: typeof newPrices?.orderPrice,
					triggerPriceType: typeof newPrices?.triggerPrice,
				});
				throw new Error("Invalid price inputs for stop loss adjustment");
			}

			// Log price transformation process
			logger.info("Processing new prices", {
				input: {
					orderPrice: newPrices.orderPrice,
					triggerPrice: newPrices.triggerPrice,
				},
				decimalConversion: {
					orderPrice: newPrices.orderPrice / 1e6,
					triggerPrice: newPrices.triggerPrice / 1e6,
				},
			});

			// Round the prices to tick size before converting to native integer
			const orderPriceDecimal = this.roundToTickSize(
				newPrices.orderPrice / 1e6
			);
			const triggerPriceDecimal = this.roundToTickSize(
				newPrices.triggerPrice / 1e6
			);

			const orderPriceNative =
				utils.convertDecimalToNativeInteger(orderPriceDecimal);
			const triggerPriceNative =
				utils.convertDecimalToNativeInteger(triggerPriceDecimal);

			logger.info("Price conversion complete", {
				orderPrice: {
					raw: newPrices.orderPrice,
					decimal: orderPriceDecimal,
					native: orderPriceNative.toString(),
				},
				triggerPrice: {
					raw: newPrices.triggerPrice,
					decimal: triggerPriceDecimal,
					native: triggerPriceNative.toString(),
				},
			});

			logger.info("Preparing trigger order modification", {
				bit: stopLoss.triggerOrderBit,
				currentState: {
					orderPrice: this.roundToTickSize(stopLoss.orderPrice / 1e6),
					triggerPrice: this.roundToTickSize(stopLoss.triggerPrice / 1e6),
				},
				newState: {
					orderPrice: orderPriceDecimal,
					triggerPrice: triggerPriceDecimal,
				},
				orderDetails: {
					size: stopLoss.size.toString(),
					side: stopLoss.side === types.Side.BID ? "BID" : "ASK",
					direction:
						stopLoss.triggerDirection ===
						types.TriggerDirection.GREATERTHANOREQUAL
							? "GREATER_THAN_OR_EQUAL"
							: "LESS_THAN_OR_EQUAL",
				},
			});

			await this.client.updateState();

			const tx = await this.client.editPriceTriggerOrder(
				stopLoss.triggerOrderBit,
				orderPriceNative,
				triggerPriceNative,
				stopLoss.size,
				stopLoss.side,
				stopLoss.triggerDirection,
				stopLoss.orderType,
				{
					reduceOnly: true,
					tag: constants.DEFAULT_ORDER_TAG,
				}
			);

			logger.info("Stop loss adjustment transaction completed", {
				success: true,
				txid: tx,
				finalOrderDetails: {
					bit: stopLoss.triggerOrderBit,
					newOrderPrice: orderPriceDecimal,
					newTriggerPrice: triggerPriceDecimal,
					size: stopLoss.size.toString(),
					side: stopLoss.side === types.Side.BID ? "BID" : "ASK",
					direction:
						stopLoss.triggerDirection ===
						types.TriggerDirection.GREATERTHANOREQUAL
							? "GREATER_THAN_OR_EQUAL"
							: "LESS_THAN_OR_EQUAL",
				},
			});

			return true;
		} catch (error) {
			logger.error("Failed to adjust stop loss", {
				error: error.message,
				errorType: error.name,
				stack: error.stack,
			});
			throw error;
		}
	}

	async checkPositionProgress() {
		try {
			if (this.positionState.hasAdjustedStopLoss) {
				this.stopPositionMonitoring();
				return;
			}

			await this.client.updateState();

			const positions = this.client.getPositions(
				this.positionState.marketIndex
			);
			const currentPosition = positions[0];

			if (!currentPosition) {
				logger.info("Position closed, stopping monitoring");
				this.stopPositionMonitoring();
				return;
			}

			const currentPrice = await this.getCalculatedMarkPrice(
				this.positionState.marketIndex
			);
			const newStopLossPrices = this.calculateTrailingStopLoss(currentPrice);

			if (newStopLossPrices) {
				const adjustmentSuccess = await this.adjustStopLossOrder(
					newStopLossPrices
				);
				if (!adjustmentSuccess) {
					throw new Error("Failed to adjust stop loss");
				}

				const verificationSuccess = await this.verifyStopLossAdjustment(
					newStopLossPrices
				);
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

	async openPosition(
		direction,
		marketIndex = constants.Asset.SOL,
		makerOrTaker = "maker"
	) {
		try {
			logger.info(
				`Opening ${direction} position for ${assets.assetToName(marketIndex)}`
			);
			const txid = await this.openPositionWithTPSLVersioned(
				direction,
				marketIndex,
				makerOrTaker
			);

			if (!txid) {
				throw new Error("No transaction ID returned");
			}

			logger.info(`Position opened successfully`, {
				direction,
				asset: assets.assetToName(marketIndex),
				txid,
			});

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
			logger.error(
				`Failed to open ${direction} position for ${assets.assetToName(
					marketIndex
				)}`,
				errorContext
			);

			// Rethrow a cleaner error for upper layers
			throw new Error(`Position opening failed: ${error.message}`);
		}
	}

	async openPositionWithTPSLVersioned(
		direction,
		marketIndex = this.activeMarket,
		makerOrTaker = "maker"
	) {
		try {
			logger.info(
				`Opening ${direction} position for ${assets.assetToName(marketIndex)}`
			);

			const openTriggerOrders = await this.getTriggerOrders(marketIndex);
			// Keep track of cancelled bits to avoid reuse
			const cancelledBits = [];

			if (openTriggerOrders && openTriggerOrders.length > 0) {
				logger.info("Found Trigger Orders, Cancelling...", openTriggerOrders);

				// this.updatePriorityFees();
				const triggerOrderTxs = [];

				for (const triggerOrder of openTriggerOrders) {
					await this.client.updateState(true, true);
					const tx = await this.client.cancelTriggerOrder(
						triggerOrder.triggerOrderBit
					);
					cancelledBits.push(triggerOrder.triggerOrderBit);
					triggerOrderTxs.push(tx);
				}

				logger.info("Trigger Orders Cancelled. Waiting 3s...", triggerOrderTxs);
        utils.sleep(3000);
			}

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

			// this.updatePriorityFees();

			await this.client.updateState(true, true);

			let transaction = new Transaction().add(
				ComputeBudgetProgram.setComputeUnitLimit({
					units: 450_000,
				})
			);

			let triggerBit_TP = this.client.findAvailableTriggerOrderBit();
			let triggerBit_SL = this.client.findAvailableTriggerOrderBit(
				triggerBit_TP + 1
			);

			// Forcefully increment bits if they collide with cancelled ones or exceed 127
			while (
				cancelledBits.includes(triggerBit_TP) ||
				cancelledBits.includes(triggerBit_SL) ||
				triggerBit_SL > 127
			) {
				triggerBit_TP = (triggerBit_TP + 1) % 128;
				triggerBit_SL = (triggerBit_TP + 1) % 128;
			}

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
			logger.error("Error opening position with TP/SL:", error);
			throw error;
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
		// logger.info("Using settings:", this.settings); // Debug log
		return this.settings;
	}

	// Update calculateTPSLPrices to handle decimal prices correctly
	calculateTPSLPrices(direction, price, settings) {
		if (!direction || !price || !settings) {
			throw new Error("Invalid inputs for TP/SL calculation");
		}

		const { takeProfitPercentage, stopLossPercentage } = settings;
		const isLong = direction === "long";

		// Calculate take profit levels
		const takeProfitPrice = isLong
			? price * (1 + takeProfitPercentage) // Long: Entry + TP%
			: price * (1 - takeProfitPercentage); // Short: Entry - TP%

		const takeProfitTrigger = isLong
			? price + (takeProfitPrice - price) * 0.95 // Long: Entry + 95% of distance to TP
			: price - (price - takeProfitPrice) * 0.95; // Short: Entry - 95% of distance to TP

		// Calculate stop loss levels
		const stopLossPrice = isLong
			? price * (1 - stopLossPercentage) // Long: Entry - SL%
			: price * (1 + stopLossPercentage); // Short: Entry + SL%

		const stopLossTrigger = isLong
			? price - (price - stopLossPrice) * 0.95 // Long: Entry - 95% of distance to SL
			: price + (stopLossPrice - price) * 0.95; // Short: Entry + 95% of distance to SL

		// Log calculations for verification
		console.log("TP/SL Price Calculations:", {
			direction,
			entryPrice: price,
			takeProfit: {
				price: takeProfitPrice,
				trigger: takeProfitTrigger,
				percentage: takeProfitPercentage * 100,
			},
			stopLoss: {
				price: stopLossPrice,
				trigger: stopLossTrigger,
				percentage: stopLossPercentage * 100,
			},
		});

		return {
			takeProfitPrice,
			takeProfitTrigger,
			stopLossPrice,
			stopLossTrigger,
		};
	}

	calculatePricesAndSize(
		side,
		marketIndex,
		balance,
		settings,
		makerOrTaker = "maker"
	) {
		// Input validation with detailed logging
		if (
			side === undefined ||
			side === null ||
			!marketIndex ||
			!balance ||
			!settings
		) {
			logger.error("Invalid inputs for price calculation:", {
				side,
				marketIndex,
				balance: balance?.toString(),
				hasSettings: !!settings,
				settingsContent: settings,
			});
			throw new Error("Invalid inputs for price and size calculation");
		}

		// Log settings received
		logger.info("Calculating prices and size with settings:", {
			side: side === types.Side.BID ? "BID" : "ASK",
			marketName: assets.assetToName(marketIndex),
			balance: balance.toString(),
			leverageMultiplier: settings.leverageMultiplier,
			orderType: makerOrTaker,
		});

		// Get orderbook data
		Exchange.getPerpMarket(marketIndex).forceFetchOrderbook();
		const orderbook = Exchange.getOrderbook(marketIndex);

		if (!orderbook?.asks?.[0]?.price || !orderbook?.bids?.[0]?.price) {
			throw new Error("Invalid orderbook data for price calculation");
		}

		// Calculate current price based on side
		const currentPrice =
			side === types.Side.BID
				? orderbook.asks[0].price
				: orderbook.bids[0].price;

		logger.info("Market prices:", {
			bestAsk: orderbook.asks[0].price.toFixed(4),
			bestBid: orderbook.bids[0].price.toFixed(4),
			selectedPrice: currentPrice.toFixed(4),
		});

		// Calculate adjusted price with slippage
		const slippage = 0.0001;
		const adjustedPrice =
			makerOrTaker === "maker"
				? side === types.Side.BID
					? currentPrice + slippage
					: currentPrice - slippage
				: side === types.Side.BID
				? currentPrice * (1 + slippage * 5)
				: currentPrice * (1 - slippage * 5);

		// Determine leverage based on market
		const isMainAsset =
			marketIndex === constants.Asset.SOL ||
			marketIndex === constants.Asset.ETH ||
			marketIndex === constants.Asset.BTC;

		const leverage = isMainAsset ? settings.leverageMultiplier : 1;

		logger.info("Leverage calculation:", {
			asset: assets.assetToName(marketIndex),
			isMainAsset,
			configuredLeverage: settings.leverageMultiplier,
			finalLeverage: leverage,
			reason: isMainAsset
				? "Major asset - using configured leverage"
				: "Minor asset - fixed at 1x",
		});

		// Calculate position size
		const rawPositionSize = (balance * leverage) / currentPrice;
		const decimalMinLotSize = utils.getDecimalMinLotSize(marketIndex);
		const lotSize = Math.floor(rawPositionSize / decimalMinLotSize);
		const nativeLotSize = lotSize * utils.getNativeMinLotSize(marketIndex);
		const actualPositionSize = lotSize * decimalMinLotSize;

		logger.info("Position size calculation:", {
			rawSize: rawPositionSize.toFixed(4),
			minLotSize: decimalMinLotSize,
			lotSize,
			finalSize: actualPositionSize.toFixed(4),
			nativeLotSize: nativeLotSize.toString(),
			effectiveValue: (actualPositionSize * currentPrice).toFixed(2),
			effectiveLeverage:
				((actualPositionSize * currentPrice) / balance).toFixed(2) + "x",
		});

		return {
			currentPrice,
			adjustedPrice,
			positionSize: actualPositionSize,
			nativeLotSize,
		};
	}

	createMainOrderInstruction(
		marketIndex,
		adjustedPrice,
		nativeLotSize,
		side,
		makerOrTaker = "maker"
	) {
		// adjustedPrice comes in as a decimal value (e.g., 232.30)
		// We convert it directly to native format without additional division
		const nativePrice = utils.convertDecimalToNativeInteger(adjustedPrice);

		logger.info("Creating main order instruction:", {
			market: assets.assetToName(marketIndex),
			priceInfo: {
				originalPrice: adjustedPrice,
				nativePrice: nativePrice.toString(),
			},
			sizeInfo: {
				nativeLotSize: nativeLotSize.toString(),
			},
			orderDetails: {
				side: side === types.Side.BID ? "BID" : "ASK",
				type: makerOrTaker === "maker" ? "POST_ONLY_SLIDE" : "LIMIT",
				expiryOffset: 180,
			},
		});

		return this.client.createPlacePerpOrderInstruction(
			marketIndex,
			nativePrice,
			nativeLotSize,
			side,
			{
				orderType:
					makerOrTaker === "maker"
						? types.OrderType.POSTONLYSLIDE
						: types.OrderType.LIMIT,
				tifOptions: {
					expiryOffset: 180,
				},
			}
		);
	}

	createTPOrderInstruction(
		direction,
		marketIndex,
		takeProfitPrice,
		takeProfitTrigger,
		nativeLotSize,
		triggerOrderBit = 0
	) {
		// These prices come in as decimal values, ready for native conversion
		const tp_side = direction === "long" ? types.Side.ASK : types.Side.BID;
		const triggerDirection =
			direction === "long"
				? types.TriggerDirection.GREATERTHANOREQUAL
				: types.TriggerDirection.LESSTHANOREQUAL;

		const nativeTakeProfit =
			utils.convertDecimalToNativeInteger(takeProfitPrice);
		const nativeTrigger =
			utils.convertDecimalToNativeInteger(takeProfitTrigger);

		logger.info("Creating take profit order instruction:", {
			market: assets.assetToName(marketIndex),
			direction,
			priceInfo: {
				takeProfitPrice,
				takeProfitTrigger,
				nativeTakeProfit: nativeTakeProfit.toString(),
				nativeTrigger: nativeTrigger.toString(),
			},
			sizeInfo: {
				nativeLotSize: nativeLotSize.toString(),
			},
			orderDetails: {
				side: tp_side === types.Side.BID ? "BID" : "ASK",
				triggerDirection:
					direction === "long" ? "GREATER_THAN_OR_EQUAL" : "LESS_THAN_OR_EQUAL",
				triggerOrderBit,
			},
		});

		return this.client.createPlaceTriggerOrderIx(
			marketIndex,
			nativeTakeProfit,
			nativeLotSize,
			tp_side,
			nativeTrigger,
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

	createSLOrderInstruction(
		direction,
		marketIndex,
		stopLossPrice,
		stopLossTrigger,
		nativeLotSize,
		triggerOrderBit = 1
	) {
		// These prices come in as decimal values, ready for native conversion
		const sl_side = direction === "long" ? types.Side.ASK : types.Side.BID;
		const triggerDirection =
			direction === "long"
				? types.TriggerDirection.LESSTHANOREQUAL
				: types.TriggerDirection.GREATERTHANOREQUAL;

		const nativeStopLoss = utils.convertDecimalToNativeInteger(stopLossPrice);
		const nativeTrigger = utils.convertDecimalToNativeInteger(stopLossTrigger);

		logger.info("Creating stop loss order instruction:", {
			market: assets.assetToName(marketIndex),
			direction,
			priceInfo: {
				stopLossPrice,
				stopLossTrigger,
				nativeStopLoss: nativeStopLoss.toString(),
				nativeTrigger: nativeTrigger.toString(),
			},
			sizeInfo: {
				nativeLotSize: nativeLotSize.toString(),
			},
			orderDetails: {
				side: sl_side === types.Side.BID ? "BID" : "ASK",
				triggerDirection:
					direction === "long" ? "LESS_THAN_OR_EQUAL" : "GREATER_THAN_OR_EQUAL",
				triggerOrderBit,
			},
		});

		return this.client.createPlaceTriggerOrderIx(
			marketIndex,
			nativeStopLoss,
			nativeLotSize,
			sl_side,
			nativeTrigger,
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
			throw new Error(
				"Invalid position state for trailing stop loss calculation"
			);
		}

		const isShort = position.size < 0;
		const entryPriceDecimal = this.roundToTickSize(entryPrice / 1e6);
		const tpPriceDecimal = this.roundToTickSize(
			orders.takeProfit.orderPrice / 1e6
		);

		if (customPercentage !== null) {
			const stopLossPrice = this.roundToTickSize(
				isShort
					? entryPriceDecimal * (1 + Math.abs(customPercentage))
					: entryPriceDecimal * (1 - Math.abs(customPercentage))
			);

			const priceDistance = Math.abs(stopLossPrice - entryPriceDecimal);
			const triggerPrice = this.roundToTickSize(
				isShort
					? entryPriceDecimal + priceDistance * 0.9
					: entryPriceDecimal - priceDistance * 0.9
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
New SL Price: $${stopLossPrice.toFixed(4)} (${(
				Math.abs(customPercentage) * 100
			).toFixed(1)}%)
New Trigger: $${triggerPrice.toFixed(4)}
`);

			return {
				orderPrice: utils.convertDecimalToNativeInteger(stopLossPrice),
				triggerPrice: utils.convertDecimalToNativeInteger(triggerPrice),
			};
		}

		const currentPriceDecimal = this.roundToTickSize(currentPrice);
		const totalDistance = Math.abs(tpPriceDecimal - entryPriceDecimal);
		const priceProgress = isShort
			? entryPriceDecimal - currentPriceDecimal
			: currentPriceDecimal - entryPriceDecimal;
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
				progressThreshold:
					(this.trailingSettings.progressThreshold * 100).toFixed(2) + "%",
				triggerPosition:
					(this.trailingSettings.triggerPricePosition * 100).toFixed(2) + "%",
				orderPosition:
					(this.trailingSettings.orderPricePosition * 100).toFixed(2) + "%",
			},
		});

		if (progressPercentage >= this.trailingSettings.progressThreshold) {
			const orderPrice = this.roundToTickSize(
				entryPriceDecimal +
					(isShort ? -1 : 1) *
						totalDistance *
						this.trailingSettings.orderPricePosition
			);

			const triggerPrice = this.roundToTickSize(
				entryPriceDecimal +
					(isShort ? -1 : 1) *
						totalDistance *
						this.trailingSettings.triggerPricePosition
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
			const triggerOrders = this.client.getTriggerOrders(
				this.positionState.marketIndex
			);
			const stopLoss = triggerOrders?.find(
				(order) =>
					order.triggerOrderBit ===
					this.positionState.orders.stopLoss.triggerOrderBit
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
