// backend/routes/verifyPurchase.js
// API route for Google Play purchase verification

const express = require('express');
const router = express.Router();
const {
  verifyProductPurchase,
  verifySubscriptionPurchase,
  acknowledgePurchase,
} = require('../services/googlePlayClient');
const { storePurchase, getPurchase } = require('../services/redisClient');

// Token amounts for each product
const TOKEN_AMOUNTS = {
  ai_notes_tokens_5k: 5000,
  ai_notes_tokens_15k: 15000,
  ai_notes_tokens_50k: 50000,
};

/**
 * POST /api/verifyPurchase
 * Verify Google Play purchase token
 */
router.post('/verifyPurchase', async (req, res) => {
  try {
    const { productId, purchaseToken, userId } = req.body;

    // Validation
    if (!productId || !purchaseToken || !userId) {
      return res.status(400).json({
        valid: false,
        error: 'Missing required fields: productId, purchaseToken, userId',
      });
    }

    // Determine if it's a subscription or product
    const isSubscription = productId.includes('subscription') || 
                          productId.includes('premium');

    let verification;
    
    if (isSubscription) {
      verification = await verifySubscriptionPurchase(productId, purchaseToken);
    } else {
      verification = await verifyProductPurchase(productId, purchaseToken);
    }

    if (!verification.valid) {
      return res.json({
        valid: false,
        reason: verification.reason,
      });
    }

    // Store purchase in Redis
    const purchaseData = {
      userId,
      productId,
      orderId: verification.orderId,
      purchaseTime: verification.purchaseTime || verification.startTime,
      expiryTime: verification.expiryTime,
      verified: true,
      verifiedAt: Date.now(),
    };

    await storePurchase(userId, purchaseData);

    // Acknowledge purchase if needed
    if (!isSubscription && verification.acknowledgementState === 0) {
      await acknowledgePurchase(productId, purchaseToken);
    }

    // Calculate tokens granted (for token packs)
    const tokensGranted = TOKEN_AMOUNTS[productId] || 0;

    res.json({
      valid: true,
      orderId: verification.orderId,
      purchaseTime: purchaseData.purchaseTime,
      tokensGranted,
      isPremium: isSubscription,
      expiryTime: verification.expiryTime,
    });
  } catch (error) {
    console.error('Purchase verification error:', error);
    res.status(500).json({
      valid: false,
      error: 'Verification failed',
      message: error.message,
    });
  }
});

/**
 * POST /api/refreshPurchase
 * Re-verify an existing purchase (for restore purchases)
 */
router.post('/refreshPurchase', async (req, res) => {
  try {
    const { userId, orderId } = req.body;

    if (!userId || !orderId) {
      return res.status(400).json({
        valid: false,
        error: 'Missing required fields: userId, orderId',
      });
    }

    // Get stored purchase
    const purchase = await getPurchase(userId, orderId);

    if (!purchase) {
      return res.json({
        valid: false,
        reason: 'Purchase not found',
      });
    }

    // Check if subscription is still valid
    if (purchase.expiryTime && purchase.expiryTime < Date.now()) {
      return res.json({
        valid: false,
        reason: 'Subscription expired',
      });
    }

    res.json({
      valid: true,
      orderId: purchase.orderId,
      productId: purchase.productId,
      purchaseTime: purchase.purchaseTime,
      expiryTime: purchase.expiryTime,
      isPremium: !!purchase.expiryTime,
    });
  } catch (error) {
    console.error('Refresh purchase error:', error);
    res.status(500).json({
      valid: false,
      error: 'Failed to refresh purchase',
    });
  }
});

module.exports = router;
