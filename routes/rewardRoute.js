// backend/routes/rewardRoute.js
// API route for modular ad reward logic

const express = require('express');
const router = express.Router();
const { incrementRewardQuota } = require('../services/redisClient');

/**
 * POST /api/reward
 * Reward user with tokens/requests for a specific module/action after ad watch
 * Body: { userId, module, rewardType, amount }
 */
router.post('/reward', async (req, res) => {
  try {
    const { userId, module, rewardType, amount } = req.body;
    if (!userId || !module || !rewardType || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, module, rewardType, amount',
      });
    }
    const result = await incrementRewardQuota(userId, module, rewardType, amount);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Reward error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

module.exports = router;
