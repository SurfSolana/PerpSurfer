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
import WebSocket from "ws";


dotenv.config();

export class ZetaClientWrapper {
  constructor() {
    // Core components
    this.longClient = null;
    this.shortClient = null;
    this.connection = null;
    this.symbols = [];

    // WebSocket state
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.connectionActive = false;

    // Message handling
    this.messageQueue = [];
    this.isProcessingQueue = false;
    this.MAX_QUEUE_SIZE = 1000;

    // Priority Fees
    this.priorityFees = null;
    this.priorityFeeMultiplier = 5;
    this.currentPriorityFee = 5_000;

    // System monitoring
    this.healthCheckInterval = null;
    this.monitoringState = new Map();
    this.lastCheckedPrice = null;
    this.isAdjusting = false;

    // Settings
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
		const tickSize = 0.0001;
		const roundedDecimal = Math.round(decimalPrice / tickSize) * tickSize;
		return roundedDecimal;
	}

  async initialize(symbols) {
    try {
      this.symbols = symbols;
      logger.info("Initializing Trading System", {
        symbols: this.symbols,
        longWallet: process.env.KEYPAIR_FILE_PATH_LONG,
        shortWallet: process.env.KEYPAIR_FILE_PATH_SHORT,
      });
  
      this.connection = new Connection(process.env.RPC_TRADINGBOT);
  
      // Initialize long wallet
      const longSecretKey = Uint8Array.from(JSON.parse(
        fs.readFileSync(process.env.KEYPAIR_FILE_PATH_LONG, "utf8")
      ));
      const longKeypair = Keypair.fromSecretKey(longSecretKey);
      const longWallet = new Wallet(longKeypair);
  
      // Initialize short wallet
      const shortSecretKey = Uint8Array.from(JSON.parse(
        fs.readFileSync(process.env.KEYPAIR_FILE_PATH_SHORT, "utf8")
      ));
      const shortKeypair = Keypair.fromSecretKey(shortSecretKey);
      const shortWallet = new Wallet(shortKeypair);
  
      logger.info("Wallets initialized successfully");
  
      // Create set of markets to load
      const marketsToLoad = new Set([constants.Asset.SOL, ...symbols]);
      const marketsArray = Array.from(marketsToLoad);
  
      // Initialize Exchange once
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
        this.connection,
        marketsArray,
        undefined,
        marketsArray,
      );
  
      await Exchange.load(loadExchangeConfig, longWallet);
      logger.info("Exchange loaded successfully");
  
      await this.setupPriorityFees();
      Exchange.setUseAutoPriorityFee(false);
      await this.updatePriorityFees();
  
      // Initialize both clients
      this.longClient = await CrossClient.load(
        this.connection,
        longWallet,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined
      );
  
      this.shortClient = await CrossClient.load(
        this.connection,
        shortWallet,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined
      );
  
      logger.info("Both clients initialized successfully");
  
      // Check existing positions
      await this.checkExistingPositions();
  
      // Setup websocket and monitoring
      this.setupWebSocket();
      this.setupHealthCheck();
  
      logger.info("Trading system initialized successfully", {
        symbols: this.symbols,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Initialization error:", error);
      throw error;
    }
  }
  
  loadKeypair(keypairPath) {
    const secretKeyString = fs.readFileSync(keypairPath, "utf8");
    const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
    return Keypair.fromSecretKey(secretKey);
  }

  async getPosition(marketIndex, direction = "long") {
    try {
      const client = direction === "long" ? this.longClient : this.shortClient;
      if (!client) {
        logger.error(`Client not initialized for ${direction} direction`);
        return null;
      }
      
      await client.updateState();
      const positions = client.getPositions(marketIndex);
      return positions[0] || null;
    } catch (error) {
      logger.error(`Error getting ${direction} position:`, error);
      throw error;
    }
  }

  async handleTradeSignal(signalData) {
    try {
      // Log initial signal
      console.log(`Processing signal for ${signalData.symbol}:`, {
        direction: signalData.direction,
        signal: signalData.signal
      });

      const direction = signalData.direction === 1 ? "long" : "short";
      const marketIndex = constants.Asset[signalData.symbol];

      // Only proceed if signal is NOT 0 (0 means close/don't open)
      if (signalData.signal === 0) {
        console.log(`[${signalData.symbol}] Signal is 0, not opening position`);
        return;
      }

      // Check if we already have a position
      const position = await this.getPosition(marketIndex, direction);
      if (position && ((direction === "long" && position.size > 0) || 
                      (direction === "short" && position.size < 0))) {
        logger.info(`Already have ${direction} position for ${signalData.symbol}`, {
          size: position.size,
          entryPrice: position.costOfTrades ? (position.costOfTrades / position.size).toFixed(4) : "N/A"
        });
        return;
      }

      // Check for existing monitoring/processing
      if (this.monitoringState.has(marketIndex)) {
        logger.info(`[${signalData.symbol}] Market already being monitored/processed`);
        return;
      }
      
      // Log intent to open
      logger.info(`Opening ${direction} position for ${signalData.symbol}`, {
        marketIndex,
        direction,
        signal: signalData.signal
      });

      // Open position
      const txid = await this.openPosition(direction, marketIndex);

      // Wait for position to be confirmed
      await utils.sleep(2000);
      const newPosition = await this.getPosition(marketIndex, direction);
      if (!newPosition) {
        logger.error(`Failed to verify position creation for ${signalData.symbol}`);
        return;
      }

      // Start monitoring
      this.startMonitoring(marketIndex, newPosition);

    } catch (error) {
      logger.error("Error handling trade signal:", error, {
        symbol: signalData.symbol,
        direction: signalData.direction,
        signal: signalData.signal
      });
    }
  }
  
  setupWebSocket() {
    const WS_HOST = process.env.WS_HOST || "api.nosol.lol";
    const WS_PORT = process.env.WS_PORT || 8080;
    const API_KEY = process.env.WS_API_KEY;

    if (this.ws) {
      this.ws.terminate();
    }

    this.ws = new WebSocket(`ws://${WS_HOST}:${WS_PORT}?apiKey=${API_KEY}`);

    this.ws.on("open", () => {
      this.connectionActive = true;
      this.reconnectAttempts = 0;
      logger.info("Connected to signal stream");

      this.symbols.forEach((symbol) => {
        ["long", "short"].forEach(direction => {
          this.ws.send(JSON.stringify({
            type: "subscribe",
            symbol,
            direction
          }));
        });
        logger.info(`Subscribed to ${symbol} signals for both directions`);
      });
    });

    this.ws.on("message", async (data) => {
      try {
        const signalData = JSON.parse(data.toString());

        if (signalData.type === "connection") {
          logger.info("Server acknowledged connection", {
            availableSymbols: signalData.symbols,
          });
          return;
        }

        if (!this.symbols.includes(signalData.symbol)) return;

        if (this.messageQueue.length >= this.MAX_QUEUE_SIZE) {
          this.messageQueue.shift();
        }

        this.messageQueue.push(signalData);
        console.log(`Queued signal for ${signalData.symbol}`);

        await this.processMessageQueue();
      } catch (error) {
        logger.error("Error processing message:", error);
      }
    });

    this.ws.on("error", (error) => {
      logger.error("WebSocket error:", error.message);
      this.connectionActive = false;
    });

    this.ws.on("close", (code, reason) => {
      this.connectionActive = false;
      logger.info(`Connection closed (${code}): ${reason}`);
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnect();
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
          logger.info("Skipping invalid message:", signalData);
          continue;
        }
        await this.handleTradeSignal(signalData);
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  reconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      logger.info(`Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
      setTimeout(() => this.setupWebSocket(), 5000);
    }
  }

  setupHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      if (!this.connectionActive) {
        logger.info("WebSocket disconnected, attempting reconnect");
        this.reconnect();
      }

      console.log("System Status:", {
        wsConnected: this.connectionActive,
        queueLength: this.messageQueue.length,
        reconnectAttempts: this.reconnectAttempts,
        timestamp: new Date().toISOString(),
      });
    }, 300000); // 5 minutes
  }

  shutdown() {
    logger.info("Initiating graceful shutdown");
    clearInterval(this.healthCheckInterval);

    if (this.ws) {
      this.ws.close();
    }

    this.longClient = null;
    this.shortClient = null;
    
    logger.info("Shutdown complete");
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



  async checkExistingPositions() {
    for (const symbol of this.symbols) {
      try {
        const marketIndex = constants.Asset[symbol];

        // Check long positions
        const longPosition = await this.getPosition(marketIndex, "long");
        if (longPosition && longPosition.size > 0) {
          logger.info(`Found existing long position for ${symbol}`, {
            size: longPosition.size,
            entryPrice: longPosition.costOfTrades 
              ? (longPosition.costOfTrades / longPosition.size).toFixed(4)
              : "N/A",
          });

          const longTriggerOrders = await this.getTriggerOrders(marketIndex, "long");
          if (longTriggerOrders.length === 0) {
            logger.warn(`Long position without trigger orders for ${symbol}`);
          } else {
            this.startMonitoring(marketIndex, longPosition);
          }
        } else {
          // Cancel any existing trigger orders if no position exists
          await this.cancelTriggerOrders(marketIndex, 'long');
        }

        // Check short positions
        const shortPosition = await this.getPosition(marketIndex, "short");
        if (shortPosition && shortPosition.size < 0) {
          logger.info(`Found existing short position for ${symbol}`, {
            size: shortPosition.size,
            entryPrice: shortPosition.costOfTrades 
              ? (shortPosition.costOfTrades / shortPosition.size).toFixed(4)
              : "N/A",
          });

          const shortTriggerOrders = await this.getTriggerOrders(marketIndex, "short");
          if (shortTriggerOrders.length === 0) {
            logger.warn(`Short position without trigger orders for ${symbol}`);
          } else {
            this.startMonitoring(marketIndex, shortPosition);
          }
        } else {
          // Cancel any existing trigger orders if no position exists
          await this.cancelTriggerOrders(marketIndex, 'short');
        }

        await utils.sleep(250); // Jitter between symbols
      } catch (error) {
        logger.error(`Error checking ${symbol} positions:`, error);
      }
    }
  }

  async getTriggerOrders(marketIndex, direction = "long") {
    try {
      const client = direction === "long" ? this.longClient : this.shortClient;
      if (!client) {
        logger.error(`Client not initialized for ${direction} direction`);
        return [];
      }
      
      return client.getTriggerOrders(marketIndex);
    } catch (error) {
      logger.error(`Error getting ${direction} trigger orders:`, error);
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


  

  
  async openPosition(direction, marketIndex = constants.Asset.SOL, makerOrTaker = "maker") {
    try {
      logger.info(`Opening ${direction} position for ${assets.assetToName(marketIndex)}`);
      const txid = await this.openPositionWithTPSLVersioned(direction, marketIndex, makerOrTaker);

      if (!txid) {
        throw new Error("No transaction ID returned");
      }

      // Get the new position and start monitoring
      await utils.sleep(2000); // Wait for position to be confirmed
      const position = await this.getPosition(marketIndex, direction);
      if (position) {
        this.startMonitoring(marketIndex, position);
      }

      logger.info(`Position opened successfully`, {
        direction,
        asset: assets.assetToName(marketIndex),
        txid,
      });

      return txid;
    } catch (error) {
      const errorContext = {
        direction,
        asset: assets.assetToName(marketIndex),
        type: error.name,
        details: error.message,
        code: error.code,
        timestamp: new Date().toISOString(),
      };

      logger.error(`Failed to open ${direction} position for ${assets.assetToName(marketIndex)}`, errorContext);
      throw new Error(`Position opening failed: ${error.message}`);
    }
  }


  async processSignal(signalData) {
    try {
      const marketIndex = constants.Asset[signalData.symbol];
      const currentPosition = await this.getPosition(marketIndex);
  
      // If no position exists and we have a valid signal, open new position
      if (!currentPosition || currentPosition.size === 0) {
        if (signalData.signal !== 0) {
          await this.openNewPosition(signalData);
        }
        return;
      }
  
      // Start monitoring if not already monitoring
      if (!this.monitoringState.has(marketIndex)) {
        logger.info(`[${signalData.symbol}] Starting position monitoring`, {
          size: currentPosition.size,
          direction: currentPosition.size > 0 ? "LONG" : "SHORT"
        });
  
        this.monitoringState.set(marketIndex, {
          isMonitoring: true,
          interval: setInterval(() => this.monitorPosition(currentPosition, marketIndex), 
            MONITORING_INTERVALS.ACTIVE_POSITION)
        });
      }
    } catch (error) {
      logger.error(`[TRADE] Error processing signal:`, error);
    }
  }
  
  startMonitoring(marketIndex, position) {
    const direction = position.size > 0 ? "long" : "short";
    const monitoringKey = `${marketIndex}-${direction}`;

    if (this.monitoringState.has(monitoringKey)) {
      logger.info(`Already monitoring ${direction} position for ${assets.assetToName(marketIndex)}`);
      return;
    }

    logger.info(`Starting ${direction} position monitoring for ${assets.assetToName(marketIndex)}`, {
      size: position.size,
      direction: position.size > 0 ? "LONG" : "SHORT"
    });

    const interval = setInterval(() => this.monitorPosition(position, marketIndex, direction), 3000);
    this.monitoringState.set(monitoringKey, { interval });
  }

  stopMonitoring(marketIndex, direction) {
    const monitoringKey = `${marketIndex}-${direction}`;
    const state = this.monitoringState.get(monitoringKey);
    if (state?.interval) {
      clearInterval(state.interval);
      this.monitoringState.delete(monitoringKey);
      logger.info(`Stopped monitoring ${direction} position for ${assets.assetToName(marketIndex)}`);
    }
  }

  async monitorPosition(position, marketIndex, direction) {
    try {
      const settings = await this.fetchSettings();
      const { trailingStopLoss } = settings;

      // Verify position still exists
      const currentPosition = await this.getPosition(marketIndex, direction);
      if (!currentPosition || currentPosition.size === 0) {
        this.stopMonitoring(marketIndex, direction);
        return;
      }

      const triggerOrders = await this.getTriggerOrders(marketIndex, direction);
      const isShort = currentPosition.size < 0;

      const stopLoss = triggerOrders.find((order) =>
        isShort
          ? order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL
          : order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL
      );
      const takeProfit = triggerOrders.find((order) =>
        isShort
          ? order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL
          : order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL
      );

      if (!stopLoss || !takeProfit) {
        logger.info(`No stop loss or take profit found, stopping monitoring`);
        this.stopMonitoring(marketIndex, direction);
        return;
      }

      const entryPrice = Math.abs(currentPosition.costOfTrades / currentPosition.size);
      const currentPrice = this.getCalculatedMarkPrice(marketIndex);
      const takeProfitPrice = takeProfit.orderPrice / 1e6;
      const currentStopLossPrice = stopLoss.orderPrice / 1e6;

      // Calculate progress
      const totalDistanceToTP = Math.abs(takeProfitPrice - entryPrice);
      const currentProgress = isShort
        ? entryPrice - currentPrice
        : currentPrice - entryPrice;
      const progressPercent = currentProgress / totalDistanceToTP;

      // Only log if price has changed
      if (this.lastCheckedPrice !== currentPrice) {
        console.log(`Position progress update:`, {
          marketIndex,
          direction: isShort ? "SHORT" : "LONG",
          entryPrice: entryPrice.toFixed(4),
          currentPrice: currentPrice.toFixed(4),
          stopLossPrice: currentStopLossPrice.toFixed(4),
          takeProfitPrice: takeProfitPrice.toFixed(4),
          progress: (progressPercent * 100).toFixed(2) + "%",
          thresholdNeeded: (trailingStopLoss.progressThreshold * 100).toFixed(2) + "%"
        });
        this.lastCheckedPrice = currentPrice;
      }

      // Check if we should close position
      if (progressPercent >= trailingStopLoss.progressThreshold) {
        // TODO: await this.closePosition(marketIndex, direction);
        this.stopMonitoring(marketIndex, direction);
      }
    } catch (error) {
      logger.error(`Error in position monitoring:`, error);
    }
  }
  
  // New helper method to adjust stop loss
  async adjustStopLoss(marketIndex, position, currentPrice, entryPrice, 
    takeProfitPrice, trailingStopLoss) {
    this.isAdjusting = true;
  
    try {
      const isShort = position.size < 0;
      const totalDistanceToTP = Math.abs(takeProfitPrice - entryPrice);
  
      const newStopLoss = this.roundToTickSize(
        isShort
          ? entryPrice - totalDistanceToTP * trailingStopLoss.stopLossDistance
          : entryPrice + totalDistanceToTP * trailingStopLoss.stopLossDistance
      );
  
      const newTrigger = this.roundToTickSize(
        isShort
          ? entryPrice - totalDistanceToTP * trailingStopLoss.triggerDistance
          : entryPrice + totalDistanceToTP * trailingStopLoss.triggerDistance
      );
  
      logger.info(`Adjusting stop loss:`, {
        marketIndex,
        currentPrice: currentPrice.toFixed(4),
        newStopLoss: newStopLoss.toFixed(4),
        newTrigger: newTrigger.toFixed(4)
      });
  
      const newPrices = {
        orderPrice: utils.convertDecimalToNativeInteger(newStopLoss),
        triggerPrice: utils.convertDecimalToNativeInteger(newTrigger)
      };
  
      const adjustmentSuccess = await this.adjustStopLossOrder(
        newPrices,
        marketIndex,
        position.size
      );
  
      if (adjustmentSuccess) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this.client.updateState();
        this.stopMonitoring(marketIndex);
      }
    } finally {
      this.isAdjusting = false;
    }
  }
  
  stopMonitoring(marketIndex) {
    const state = this.monitoringState.get(marketIndex);
    if (state?.interval) {
      clearInterval(state.interval);
      this.monitoringState.delete(marketIndex);
      logger.info(`Stopped monitoring for market ${marketIndex}`);
    }
  }
  
  
  async cancelTriggerOrders(marketIndex, direction = "long") {
    const client = direction === "long" ? this.longClient : this.shortClient;
    await client.updateState();

    const openTriggerOrders = await this.getTriggerOrders(marketIndex, direction);

    if (openTriggerOrders && openTriggerOrders.length > 0) {
      logger.info(`Found Trigger Orders for ${direction}, Cancelling...`, openTriggerOrders);

      await client.cancelAllTriggerOrders(marketIndex);

      logger.info(`${direction} Trigger Orders Cancelled.`);
    }
  }
  async openPositionWithTPSLVersioned(direction, marketIndex, makerOrTaker = "maker") {
    try {
      const client = direction === "long" ? this.longClient : this.shortClient;
      logger.info(`Opening ${direction} position for ${assets.assetToName(marketIndex)}`);

      const settings = this.fetchSettings();
      logger.info(`Using settings:`, settings);

      const balance = Exchange.riskCalculator.getCrossMarginAccountState(client.account).balance;
      const side = direction === "long" ? types.Side.BID : types.Side.ASK;

      const { currentPrice, adjustedPrice, positionSize, nativeLotSize } =
        this.calculatePricesAndSize(side, marketIndex, balance, settings, "taker");

      const { takeProfitPrice, takeProfitTrigger, stopLossPrice, stopLossTrigger } = 
        this.calculateTPSLPrices(direction, adjustedPrice, settings);

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

      await this.updatePriorityFees();
      await client.updateState(true, true);

      let transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 450_000,
        })
      );

      let triggerBit_TP = client.findAvailableTriggerOrderBit();
      let triggerBit_SL = client.findAvailableTriggerOrderBit(triggerBit_TP + 1);

      const mainOrderIx = this.createMainOrderInstruction(
        marketIndex,
        adjustedPrice,
        nativeLotSize,
        side,
        "taker",
        direction
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
        client.provider,
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
      logger.error("Error opening position with TP/SL:", error);
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

  createMainOrderInstruction(marketIndex, adjustedPrice, nativeLotSize, side, makerOrTaker = "maker", direction = "long") {
    const client = direction === "long" ? this.longClient : this.shortClient;
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

    return client.createPlacePerpOrderInstruction(
      marketIndex,
      nativePrice,
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
    const client = direction === "long" ? this.longClient : this.shortClient;
    const tp_side = direction === "long" ? types.Side.ASK : types.Side.BID;
    const triggerDirection =
      direction === "long"
        ? types.TriggerDirection.GREATERTHANOREQUAL
        : types.TriggerDirection.LESSTHANOREQUAL;

    const nativeTakeProfit = utils.convertDecimalToNativeInteger(takeProfitPrice);
    const nativeTrigger = utils.convertDecimalToNativeInteger(takeProfitTrigger);

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
        triggerDirection: direction === "long" ? "GREATER_THAN_OR_EQUAL" : "LESS_THAN_OR_EQUAL",
        triggerOrderBit,
      },
    });

    return client.createPlaceTriggerOrderIx(
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

  createSLOrderInstruction(direction, marketIndex, stopLossPrice, stopLossTrigger, nativeLotSize, triggerOrderBit = 1) {
    const client = direction === "long" ? this.longClient : this.shortClient;
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
        triggerDirection: direction === "long" ? "LESS_THAN_OR_EQUAL" : "GREATER_THAN_OR_EQUAL",
        triggerOrderBit,
      },
    });

    return client.createPlaceTriggerOrderIx(
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
