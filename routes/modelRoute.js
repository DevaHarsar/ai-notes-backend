// backend/routes/modelRoute.js
// API route for AI model requests and quota status

const express = require('express');
const router = express.Router();
const { routeModelRequest } = require('../services/modelRouter');
const { getQuotaStatus } = require('../services/redisClient');

/**
 * POST /api/routeModel
 * Route AI request with automatic model selection and rate limiting
 */
router.post('/routeModel', async (req, res) => {
  try {
    const {
      userId,
      prompt,
      systemPrompt,
      maxTokens,
      temperature,
      taskType,
      preferredModel,
    } = req.body;

    // Validation
    if (!userId || !prompt) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId and prompt',
      });
    }

    // Route request
    const result = await routeModelRequest({
      userId,
      prompt,
      systemPrompt,
      maxTokens: maxTokens || 1000,
      temperature: temperature || 0.7,
      taskType: taskType || 'general',
      preferredModel,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(429).json(result);
    }
  } catch (error) {
    console.error('Route model error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * GET /api/quotaStatus/:userId
 * Get current quota status without making a request
 */
router.get('/quotaStatus/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { usage, limits } = await getQuotaStatus(userId);

    res.json({
      userId,
      quotas: {
        // GLOBAL limits (Groq API)
        requestsPerMinute: {
          used: usage.rpm,
          limit: limits.rpm,
          remaining: limits.rpm - usage.rpm,
        },
        requestsPerDay: {
          used: usage.rpd,
          limit: limits.rpd,
          remaining: limits.rpd - usage.rpd,
        },
        tokensPerMinute: {
          used: usage.tpm,
          limit: limits.tpm,
          remaining: limits.tpm - usage.tpm,
        },
        tokensPerDay: {
          used: usage.tpd,
          limit: limits.tpd,
          remaining: limits.tpd - usage.tpd,
        },
        // PER-USER limits (Your App)
        userRequestsPerDay: {
          used: usage.userRpd,
          limit: limits.userRpd,
          remaining: limits.userRpd - usage.userRpd,
        },
        userTokensPerDay: {
          used: usage.userTpd,
          limit: limits.userTpd,
          remaining: limits.userTpd - usage.userTpd,
        },
      },
      recommendedModel: usage.tpd / limits.tpd > 0.7 ? 'compound-mini' : 'llama-3.1-8b-instant',
    });
  } catch (error) {
    console.error('Quota status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get quota status',
    });
  }
});

/**
 * DELETE /api/resetQuota/:userId
 * Reset quota for a specific user (for testing/debugging)
 */
router.delete('/resetQuota/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get Redis client
    const Redis = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    
    // Find all keys for this user
    const pattern = `*:${userId}:*`;
    const keys = await redis.keys(pattern);
    
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    
    await redis.quit();
    
    res.json({
      success: true,
      message: `Reset ${keys.length} quota keys for user ${userId}`,
      keysDeleted: keys,
    });
  } catch (error) {
    console.error('Reset quota error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset quota',
    });
  }
});

module.exports = router;
