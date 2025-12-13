// backend/routes/configRoute.js
// API endpoint for frontend to fetch initial config

const express = require('express');
const router = express.Router();

/**
 * GET /api/config/initialTokens
 * Return initial tokens for new users based on tier
 */
router.get('/config/initialTokens', (req, res) => {
  const { userId } = req.query;
  
  // Default: 20000 free tokens for new users (matches daily quota limit)
  // This allows users to fully utilize their daily 20k token allowance
  // Can be extended to check user tier (free vs premium)
  const initialTokens = 20000;
  
  res.json({
    success: true,
    userId,
    initialTokens,
    tier: 'free', // 'free' or 'premium'
  });
});

/**
 * GET /api/config/features
 * Return feature flags and app configuration
 */
router.get('/config/features', (req, res) => {
  res.json({
    success: true,
    features: {
      adRewards: true,
      inAppPurchases: true,
      premiumTier: true,
    },
    adRewards: {
      pdf: 1000,
      chat: 500,
      math: 750,
      translation: 400,
      qa: 600,
    },
  });
});

module.exports = router;
