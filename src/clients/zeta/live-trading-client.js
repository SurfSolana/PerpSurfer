import { Wallet, CrossClient, Exchange, Network, Market, utils, types, assets, constants, events } from "@zetamarkets/sdk";
import { PublicKey, Connection, Keypair, Transaction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import fs from "fs";
import dotenv from "dotenv";
import logger from "../../utils/logger.js";
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
    this.priorityFeeMultiplier = 5;
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

    // this.trailingSettings = {
    //   progressThreshold: 0.6,
    //   triggerPricePosition: 0.55,
    //   orderPricePosition: 0.5,
    // };

    // this.trailingSettings = {
    //   progressThreshold: 0.36,
    //   triggerPricePosition: 0.1,
    //   orderPricePosition: 0.05,
    // };
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
      this.client = await CrossClient.load(this.connection, this.wallet, undefined, undefined, undefined, undefined, true, undefined);

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

      const newFee = recentFees?.slice(0, 10).reduce((sum, fee) => sum + fee.prioritizationFee, 0) / 10 || this.currentPriorityFee;

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
      // Overly unnecessary logging:
      // console.log("Position check:", {
      //   marketIndex,
      //   hasPosition: !!positions[0],
      //   size: positions[0]?.size || 0,
      // });
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

  async openPosition(direction, marketIndex = constants.Asset.SOL, makerOrTaker = "taker") {
    try {
      logger.info(`Opening ${direction} position for ${assets.assetToName(marketIndex)}`);
      const txid = await this.openPositionWithTPSLVersioned(direction, marketIndex, makerOrTaker);

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
      logger.error(`Failed to open ${direction} position for ${assets.assetToName(marketIndex)}`, errorContext);

      // Rethrow a cleaner error for upper layers
      throw new Error(`Position opening failed: ${error.message}`);
    }
  }

  async openPositionWithTPSLVersioned(direction, marketIndex = this.activeMarket, makerOrTaker = "taker") {
    try {
      logger.info(`Opening ${direction} position for ${assets.assetToName(marketIndex)}`);

      const openTriggerOrders = await this.getTriggerOrders(marketIndex);
      // Keep track of cancelled bits to avoid reuse
      const cancelledBits = [];

      if (openTriggerOrders && openTriggerOrders.length > 0) {
        logger.info("Found Trigger Orders, Cancelling...", openTriggerOrders);

        // await this.updatePriorityFees();
        const triggerOrderTxs = [];

        for (const triggerOrder of openTriggerOrders) {
          await this.client.updateState(true, true);
          const tx = await this.client.cancelTriggerOrder(triggerOrder.triggerOrderBit);
          cancelledBits.push(triggerOrder.triggerOrderBit);
          triggerOrderTxs.push(tx);
        }

        logger.info("Trigger Orders Cancelled.", triggerOrderTxs);
      }

      const settings = await this.fetchSettings();
      logger.info(`Using settings:`, settings);

      const balance = Exchange.riskCalculator.getCrossMarginAccountState(this.client.account).balance;
      const side = direction === "long" ? types.Side.BID : types.Side.ASK;

      const { currentPrice, adjustedPrice, positionSize, nativeLotSize } = this.calculatePricesAndSize(side, marketIndex, balance, settings, "taker");

      const { takeProfitPrice, takeProfitTrigger, stopLossPrice, stopLossTrigger } = this.calculateTPSLPrices(direction, adjustedPrice, settings);

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

      // Forcefully increment bits if they collide with cancelled ones or exceed 127
      while (cancelledBits.includes(triggerBit_TP) || cancelledBits.includes(triggerBit_SL) || triggerBit_SL > 127) {
        triggerBit_TP = (triggerBit_TP + 1) % 128;
        triggerBit_SL = (triggerBit_TP + 1) % 128;
      }

      const mainOrderIx = this.createMainOrderInstruction(marketIndex, adjustedPrice, nativeLotSize, side, "taker");
      const tpOrderIx = this.createTPOrderInstruction(direction, marketIndex, takeProfitPrice, takeProfitTrigger, nativeLotSize, triggerBit_TP);
      const slOrderIx = this.createSLOrderInstruction(direction, marketIndex, stopLossPrice, stopLossTrigger, nativeLotSize, triggerBit_SL);

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

  async fetchSettings() {
    try {
      const settings = {
        leverageMultiplier: 4.8,
        takeProfitPercentage: 0.04,
        stopLossPercentage: 0.02,
        trailingStopLoss: {
          progressThreshold: 0.6, // Updated default
          stopLossDistance:  0.4,
        },
      };

      // logger.info("Parsed settings:", settings); // Debug log
      return settings;
    } catch (error) {
      logger.error("Error fetching settings:", error);
      throw error;
    }
  }

  calculateTPSLPrices(direction, price, settings) {
    if (!direction || !price || !settings) {
      throw new Error("Invalid inputs for TP/SL calculation");
    }

    const { takeProfitPercentage, stopLossPercentage } = settings;
    const isLong = direction === "long";

    const takeProfitPrice = this.roundToTickSize(isLong ? price + price * takeProfitPercentage : price - price * takeProfitPercentage);

    const takeProfitTrigger = this.roundToTickSize(isLong ? price + (takeProfitPrice - price) * 0.95 : price - (price - takeProfitPrice) * 0.95);

    const stopLossPrice = this.roundToTickSize(isLong ? price - price * stopLossPercentage : price + price * stopLossPercentage);

    const stopLossTrigger = this.roundToTickSize(isLong ? price - (price - stopLossPrice) * 0.95 : price + (stopLossPrice - price) * 0.95);

    // console.log("Calculated TP/SL Prices:", {
    //   direction,
    //   entryPrice: price.toFixed(4),
    //   takeProfit: {
    //     price: takeProfitPrice.toFixed(4),
    //     trigger: takeProfitTrigger.toFixed(4),
    //     percentage: (takeProfitPercentage * 100).toFixed(2) + "%",
    //   },
    //   stopLoss: {
    //     price: stopLossPrice.toFixed(4),
    //     trigger: stopLossTrigger.toFixed(4),
    //     percentage: (stopLossPercentage * 100).toFixed(2) + "%",
    //   },
    // });

    return {
      takeProfitPrice,
      takeProfitTrigger,
      stopLossPrice,
      stopLossTrigger,
    };
  }

  calculatePricesAndSize(side, marketIndex, balance, settings, makerOrTaker = "taker") {
    if (side === undefined || side === null || !marketIndex || !balance || !settings) {
      throw new Error("Invalid inputs for price and size calculation");
    }

    Exchange.getPerpMarket(marketIndex).forceFetchOrderbook();
    const orderbook = Exchange.getOrderbook(marketIndex);

    if (!orderbook?.asks?.[0]?.price || !orderbook?.bids?.[0]?.price) {
      throw new Error("Invalid orderbook data for price calculation");
    }

    const currentPrice = side === types.Side.BID ? orderbook.asks[0].price : orderbook.bids[0].price;
    const slippage = 0.0001;

    const adjustedPrice =
      makerOrTaker === "taker" ?
        side === types.Side.BID ?
          currentPrice + slippage
        : currentPrice - slippage
      : side === types.Side.BID ? currentPrice * (1 + slippage * 5)
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

  createMainOrderInstruction(marketIndex, adjustedPrice, nativeLotSize, side, makerOrTaker = "taker") {
    return this.client.createPlacePerpOrderInstruction(marketIndex, utils.convertDecimalToNativeInteger(adjustedPrice), nativeLotSize, side, {
      orderType: makerOrTaker === "maker" ? types.OrderType.POSTONLYSLIDE : types.OrderType.LIMIT,
      tifOptions: {
        expiryOffset: 180,
      },
    });
  }

  createTPOrderInstruction(direction, marketIndex, takeProfitPrice, takeProfitTrigger, nativeLotSize, triggerOrderBit = 0) {
    const tp_side = direction === "long" ? types.Side.ASK : types.Side.BID;
    const triggerDirection = direction === "long" ? types.TriggerDirection.GREATERTHANOREQUAL : types.TriggerDirection.LESSTHANOREQUAL;

    return this.client.createPlaceTriggerOrderIx(marketIndex, utils.convertDecimalToNativeInteger(takeProfitPrice), nativeLotSize, tp_side, utils.convertDecimalToNativeInteger(takeProfitTrigger), triggerDirection, new BN(0), types.OrderType.FILLORKILL, triggerOrderBit, {
      reduceOnly: true,
      tag: constants.DEFAULT_ORDER_TAG,
    });
  }

  createSLOrderInstruction(direction, marketIndex, stopLossPrice, stopLossTrigger, nativeLotSize, triggerOrderBit = 1) {
    const sl_side = direction === "long" ? types.Side.ASK : types.Side.BID;
    const triggerDirection = direction === "long" ? types.TriggerDirection.LESSTHANOREQUAL : types.TriggerDirection.GREATERTHANOREQUAL;

    return this.client.createPlaceTriggerOrderIx(marketIndex, utils.convertDecimalToNativeInteger(stopLossPrice), nativeLotSize, sl_side, utils.convertDecimalToNativeInteger(stopLossTrigger), triggerDirection, new BN(0), types.OrderType.FILLORKILL, triggerOrderBit, {
      reduceOnly: true,
      tag: constants.DEFAULT_ORDER_TAG,
    });
  }

}
