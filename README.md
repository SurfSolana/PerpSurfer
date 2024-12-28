# PerpSurfer Trading Bot

The PerpSurfer Trading Bot is an automated trading system for Zeta Markets perpetual futures. It features intelligent market sentiment analysis, sophisticated risk management, dynamic trailing stop losses, and real-time market signal integration.

## Features

The PerpSurfer bot provides a complete perpetual futures trading solution with:

- AI-powered market sentiment analysis for trade filtering
- Real-time trading signals through secure WebSocket connection
- Intelligent position entry and management
- Dynamic trailing stop loss with automatic adjustment at profit targets
- Smart priority fee management using Helius API
- Optional Telegram notifications for trade monitoring
- Multi-market support for major assets (SOL, ETH, BTC)

## How It Works

The PerpSurfer trading system operates as an integrated solution that:
- Receives real-time trading signals through our secure WebSocket connection
- Analyzes market sentiment using data from top 100 cryptocurrencies
- Validates trade signals against current market conditions
- Manages position entry using optimized priority fees
- Places coordinated take-profit and stop-loss orders
- Continuously monitors position progress
- Adjusts stop-loss levels automatically when reaching profit targets

Our risk management system includes:
- Market sentiment-based position filtering
- Automatic stop-loss placement with each trade
- Dynamic trailing stop-loss adjustment based on profit targets
- Priority fee optimization for reliable execution
- Intelligent position size management based on account balance

## Setup Instructions

### 1. Get Required API Keys

The bot requires several API keys for full functionality:

1. Trading Signals API:
   - Join our Discord server: https://discord.gg/dpzudaBwSa
   - Complete the server verification process
   - Navigate to the #PerpSurfer channel
   - Request an API key from the moderators

2. RPC Endpoint:
   - Get an RPC endpoint from any provider (Helius, QuickNode, etc.)
   - Save your RPC URL

3. Helius API Key (for priority fees only):
   - Visit https://helius.dev
   - Create an account
   - Create a new API key (free tier is sufficient)
   - **Important**: Save only the API key, not the RPC URL
   - This is used specifically for optimizing transaction priority fees

4. CoinMarketCap API Key (for market sentiment):
   - Visit https://coinmarketcap.com/api
   - Sign up for a free API key
   - Save your API key

### 2. Wallet Setup

The bot requires a dedicated trading wallet:

1. Visit Zeta Markets using our affiliate link: https://dex.zeta.markets/?r=surf
2. Create a new wallet
   - Important: Always use a fresh wallet, never your main one
3. Export your private key:
   - In SolFlare, click on your wallet address
   - Select "Export Private Key"
   - Save the exported array format [1,2,3,...]

4. Create your wallet file:
   ```bash
   # Create a secure directory for wallet
   mkdir -p ~/.perpsurfer/wallet
   
   # Create and secure wallet file
   nano ~/.perpsurfer/wallet/trading-wallet.json
   ```

   Paste your private key array into the file.

### 3. Project Installation

Install pnpm if you haven't already:
```bash
npm install -g pnpm
```

Install the project:
```bash
# Clone the repository
git clone https://github.com/SurfSolana/PerpSurfer
cd PerpSurfer

# Install dependencies
pnpm install
```

### 4. Configuration

1. Create your environment file:
   ```bash
   cp dotenv.example.txt .env
   ```

2. Edit the `.env` file with your details:
   ```env
   # Trading Signals API
   WS_API_KEY=your_api_key_from_discord
   WS_HOST=api.nosol.lol
   WS_PORT=8080

   # RPC Url (Chainstack, Helius, Shyft, Quicknode, etc.)
   RPC_TRADINGBOT=your_rpc_endpoint_from_any_provider

   # Priority Fee API Key
   HELIUS_API_KEY=your_helius_api_key_for_priority_fees_only

   # Market Sentiment Analysis
   CMC_API_KEY=your_coinmarketcap_api_key

   # Wallet Path - Update with your actual path
   KEYPAIR_FILE_PATH=/home/yourusername/.perpsurfer/wallet/trading-wallet.json
   ```

3. Set up your configuration:
   ```bash
   cp config.sample.js config.js
   ```
   
   The config file contains settings for:
   - Active trading symbols
   - Telegram integration
   - Server identification

### 5. Optional Telegram Setup

For trade notifications:

1. Create a Telegram bot:
   - Message @BotFather on Telegram
   - Send /newbot
   - Follow the prompts
   - Save the provided API token

2. Get your Chat ID:
   - Message @userinfobot on Telegram
   - Save the ID number it provides

3. Add to your `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token
   TELEGRAM_CHAT_ID=your_chat_id
   ADMIN_CHAT_ID=your_chat_id
   ```

### 6. Testing Market Sentiment

Before running the bot, test the market sentiment analysis:
```bash
node src/utils/test-sentiment.js
```

This will display:
- Current market sentiment index
- Sentiment category (Extreme Fear to Extreme Greed)
- Whether long/short positions are allowed
- Timestamp of analysis

### 7. Running the Bot

Start the bot:
```bash
node src/live-trading.js
```

For production deployment, use PM2:
```bash
# Install PM2
npm install -g pm2

# Start the bot
pm2 start src/live-trading.js --name perpsurfer

# Make it start on system boot
pm2 startup
pm2 save
```

## Risk Management Configuration

The bot's risk management system is configured through settings in the ZetaClientWrapper class. These settings control position sizing, take profits, stop losses, and trailing stop loss behavior.

### Position Size and Leverage

The bot implements a carefully designed leverage system that accounts for the different maximum leverage limits available on Zeta Markets for different assets.

For SOL, ETH, and BTC positions:
- The bot will use your configured `leverageMultiplier` setting directly
- While Zeta Markets allows up to 20x leverage for these assets, you should never use the maximum leverage
- Example: With `leverageMultiplier: 4`, a $1000 wallet can take positions worth $4000

### Take Profit and Stop Loss

The take profit and stop loss are set as percentages of your entry price:

```javascript
takeProfitPercentage: 0.036,  // 3.6% take profit
stopLossPercentage: 0.018,    // 1.8% stop loss
```

For example, if you enter a long position at $100:
- Take Profit would be set at $103.60 (100 + 3.6%)
- Stop Loss would be set at $98.20 (100 - 1.8%)

### Market Sentiment System

The bot uses a sophisticated market analysis system that:
- Analyzes price movements of top 100 cryptocurrencies
- Calculates market breadth and magnitude scores
- Determines overall market sentiment
- Prevents trades during extreme market conditions:
  - No longs during "Extreme Fear"
  - No shorts during "Extreme Greed"

## Monitoring

The bot creates two log files:
- `error.log`: Contains error messages only
- `combined.log`: Contains all log messages

If configured, Telegram notifications will inform you about:
- Trade entries and exits
- Stop loss adjustments
- Error conditions
- System status updates

## Track Your Wallet

You can easily track your wallet on Zeta by going to:

```
https://dex.zeta.markets/portfolio/YOUR_WALLET_PUBLIC_KEY
```

## Best Practices

Security Practices:
1. Use a dedicated trading wallet only
2. Keep your API keys secure
3. Keep your wallet private key secure
4. Monitor your positions regularly
5. Start with small position sizes until comfortable
6. Regularly check market sentiment analysis

## Support

We're here to help:
1. Discord: https://discord.gg/dpzudaBwSa
2. Website: https://surfsolana.com/
3. Trading signals support: #PerpSurfer channel on Discord
4. Technical support: #support channel on Discord

## Disclaimer

Trading cryptocurrency perpetual futures carries significant risk. This bot is provided as-is, with no guarantees of profit or performance. Always start with small position sizes and monitor the bot's performance carefully. Past performance does not indicate future results.