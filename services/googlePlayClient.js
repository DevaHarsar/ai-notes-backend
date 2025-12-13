// backend/services/googlePlayClient.js
// Google Play Developer API client for purchase verification

const { google } = require('googleapis');

let androidPublisher = null;

/**
 * Initialize Google Play Developer API client
 */
function initializePlayClient() {
  if (androidPublisher) return androidPublisher;

  try {
    const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    
    if (!credentials) {
      console.warn('⚠️ Google Play credentials not configured');
      return null;
    }

    // Parse credentials (can be file path or JSON string)
    let auth;
    try {
      // Try as JSON string first
      const credJson = JSON.parse(credentials);
      auth = new google.auth.GoogleAuth({
        credentials: credJson,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });
    } catch {
      // Fall back to file path
      auth = new google.auth.GoogleAuth({
        keyFile: credentials,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });
    }

    androidPublisher = google.androidpublisher({
      version: 'v3',
      auth,
    });

    console.log('✅ Google Play API client initialized');
    return androidPublisher;
  } catch (error) {
    console.error('❌ Failed to initialize Google Play API:', error);
    return null;
  }
}

/**
 * Verify a product purchase (one-time or consumable)
 */
async function verifyProductPurchase(productId, purchaseToken) {
  const client = initializePlayClient();
  if (!client) {
    throw new Error('Google Play API not configured');
  }

  const packageName = process.env.GOOGLE_PACKAGE_NAME;
  
  try {
    const response = await client.purchases.products.get({
      packageName,
      productId,
      token: purchaseToken,
    });

    const purchase = response.data;
    
    // Check purchase state (0 = purchased, 1 = canceled, 2 = pending)
    if (purchase.purchaseState !== 0) {
      return {
        valid: false,
        reason: 'Purchase not completed',
        purchaseState: purchase.purchaseState,
      };
    }

    // Check if already consumed (for consumables)
    if (purchase.consumptionState === 1) {
      return {
        valid: false,
        reason: 'Purchase already consumed',
      };
    }

    return {
      valid: true,
      orderId: purchase.orderId,
      purchaseTime: purchase.purchaseTimeMillis,
      acknowledgementState: purchase.acknowledgementState,
      consumptionState: purchase.consumptionState,
    };
  } catch (error) {
    console.error('Product purchase verification error:', error);
    throw new Error(`Verification failed: ${error.message}`);
  }
}

/**
 * Verify a subscription purchase
 */
async function verifySubscriptionPurchase(subscriptionId, purchaseToken) {
  const client = initializePlayClient();
  if (!client) {
    throw new Error('Google Play API not configured');
  }

  const packageName = process.env.GOOGLE_PACKAGE_NAME;
  
  try {
    const response = await client.purchases.subscriptions.get({
      packageName,
      subscriptionId,
      token: purchaseToken,
    });

    const subscription = response.data;
    
    // Check if subscription is active
    const now = Date.now();
    const expiryTime = parseInt(subscription.expiryTimeMillis, 10);
    
    if (expiryTime < now) {
      return {
        valid: false,
        reason: 'Subscription expired',
        expiryTime,
      };
    }

    return {
      valid: true,
      orderId: subscription.orderId,
      startTime: subscription.startTimeMillis,
      expiryTime: subscription.expiryTimeMillis,
      autoRenewing: subscription.autoRenewing,
      paymentState: subscription.paymentState,
    };
  } catch (error) {
    console.error('Subscription verification error:', error);
    throw new Error(`Verification failed: ${error.message}`);
  }
}

/**
 * Acknowledge a purchase (required for one-time purchases)
 */
async function acknowledgePurchase(productId, purchaseToken) {
  const client = initializePlayClient();
  if (!client) {
    throw new Error('Google Play API not configured');
  }

  const packageName = process.env.GOOGLE_PACKAGE_NAME;
  
  try {
    await client.purchases.products.acknowledge({
      packageName,
      productId,
      token: purchaseToken,
    });
    return true;
  } catch (error) {
    console.error('Purchase acknowledgement error:', error);
    return false;
  }
}

module.exports = {
  verifyProductPurchase,
  verifySubscriptionPurchase,
  acknowledgePurchase,
};
