import { getMarketSentiment } from './market-sentiment.js';

const runTest = async () => {
  try {
    console.log('Fetching market sentiment...');
    console.log('-'.repeat(50));
    
    const result = await getMarketSentiment();
    
    console.log('Timestamp:', result.timestamp);
    console.log('Market Sentiment Index:', result.index);
    console.log('Sentiment:', result.sentiment);
    console.log('Long Positions Allowed:', result.canOpenLong);
    console.log('Short Positions Allowed:', result.canOpenShort);
    
    console.log('-'.repeat(50));
  } catch (error) {
    console.error('Test failed:', error.message);
  }
};

// Run the test
runTest();