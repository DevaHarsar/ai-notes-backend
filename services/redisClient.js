// backend/services/redisClient.js
// Redis client for rate limiting and purchase verification storage

const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  // TLS is required for Upstash Cloud Redis
  tls: process.env.REDIS_URL?.includes('upstash.io') ? {} : undefined,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError(err) {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
});

redis.on('connect', () => {
  console.log('✅ Redis connected');
});

redis.on('error', (err) => {
  console.error('❌ Redis error:', err);
});

/**
 * Increment counter with TTL
 * Used for rate limiting (RPM, RPD, TPM, TPD)
 */
async function incrementCounter(key, ttl) {
  const current = await redis.incr(key);
  if (current === 1) {
    // First increment, set TTL
    await redis.expire(key, ttl);
  }
  return current;
}

/**
 * Get current counter value
 */
async function getCounter(key) {
  const value = await redis.get(key);
  return value ? parseInt(value, 10) : 0;
}

/**
 * Check and increment rate limit counters atomically
 * TWO-LAYER RATE LIMITING:
 * 1. GLOBAL limits (Groq API shared by all users)
 * 2. PER-USER limits (your app's per-user quotas)
 * Returns { allowed: boolean, usage: object }
 */
async function checkAndIncrementLimits(userId, tokensEstimated) {
  const now = new Date();
  const minute = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
  const day = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;

  // ===== LAYER 1: GLOBAL LIMITS (Groq API) =====
  const globalRpmKey = `global:rpm:${minute}`;
  const globalRpdKey = `global:rpd:${day}`;
  const globalTpmKey = `global:tpm:${minute}`;
  const globalTpdKey = `global:tpd:${day}`;

  // ===== LAYER 2: PER-USER LIMITS (Your App) =====
  const userRpdKey = `user:rpd:${userId}:${day}`;
  const userTpdKey = `user:tpd:${userId}:${day}`;

  // Groq API Global Limits (llama-3.1-8b-instant)
  const globalLimits = {
    rpm: 30,        // 30 req/min globally
    rpd: 14400,     // 14.4K req/day globally
    tpm: 6000,      // 6K tokens/min globally
    tpd: 500000,    // 500K tokens/day globally
  };

  // Your App's Per-User Limits (for FREE users)
  const userLimits = {
    rpd: parseInt(process.env.RATE_LIMIT_RPD || '50', 10),      // 50 req/day per free user
    tpd: parseInt(process.env.RATE_LIMIT_TPD || '20000', 10),   // 20K tokens/day per free user
  };

  // Get current GLOBAL usage
  const globalUsage = {
    rpm: await getCounter(globalRpmKey),
    rpd: await getCounter(globalRpdKey),
    tpm: await getCounter(globalTpmKey),
    tpd: await getCounter(globalTpdKey),
  };

  // Get current PER-USER usage
  const userUsage = {
    rpd: await getCounter(userRpdKey),
    tpd: await getCounter(userTpdKey),
  };

  // ===== CHECK GLOBAL LIMITS FIRST (Groq API) =====
  if (globalUsage.rpm >= globalLimits.rpm) {
    return { 
      allowed: false, 
      usage: { ...globalUsage, userRpd: userUsage.rpd, userTpd: userUsage.tpd },
      limits: { ...globalLimits, userRpd: userLimits.rpd, userTpd: userLimits.tpd },
      reason: 'Global requests per minute limit exceeded (Groq API)' 
    };
  }
  if (globalUsage.rpd >= globalLimits.rpd) {
    return { 
      allowed: false, 
      usage: { ...globalUsage, userRpd: userUsage.rpd, userTpd: userUsage.tpd },
      limits: { ...globalLimits, userRpd: userLimits.rpd, userTpd: userLimits.tpd },
      reason: 'Global requests per day limit exceeded (Groq API)' 
    };
  }
  if (globalUsage.tpm + tokensEstimated > globalLimits.tpm) {
    return { 
      allowed: false, 
      usage: { ...globalUsage, userRpd: userUsage.rpd, userTpd: userUsage.tpd },
      limits: { ...globalLimits, userRpd: userLimits.rpd, userTpd: userLimits.tpd },
      reason: 'Global tokens per minute limit exceeded (Groq API)' 
    };
  }
  if (globalUsage.tpd + tokensEstimated > globalLimits.tpd) {
    return { 
      allowed: false, 
      usage: { ...globalUsage, userRpd: userUsage.rpd, userTpd: userUsage.tpd },
      limits: { ...globalLimits, userRpd: userLimits.rpd, userTpd: userLimits.tpd },
      reason: 'Global tokens per day limit exceeded (Groq API - 500K/day)' 
    };
  }

  // ===== CHECK PER-USER LIMITS (Your App) =====
  if (userUsage.rpd >= userLimits.rpd) {
    return { 
      allowed: false, 
      usage: { ...globalUsage, userRpd: userUsage.rpd, userTpd: userUsage.tpd },
      limits: { ...globalLimits, userRpd: userLimits.rpd, userTpd: userLimits.tpd },
      reason: 'User requests per day limit exceeded (Your App Quota)' 
    };
  }
  if (userUsage.tpd + tokensEstimated > userLimits.tpd) {
    return { 
      allowed: false, 
      usage: { ...globalUsage, userRpd: userUsage.rpd, userTpd: userUsage.tpd },
      limits: { ...globalLimits, userRpd: userLimits.rpd, userTpd: userLimits.tpd },
      reason: 'User tokens per day limit exceeded (Your App Quota)' 
    };
  }

  // ===== ALL CHECKS PASSED - INCREMENT COUNTERS =====
  // Increment GLOBAL request counters
  await incrementCounter(globalRpmKey, 60);    // 1 minute TTL
  await incrementCounter(globalRpdKey, 86400); // 24 hours TTL

  // Increment PER-USER request counter
  await incrementCounter(userRpdKey, 86400);
  
  // ⚠️ DO NOT increment tokens here - only after actual API response
  // See recordActualTokenUsage() function

  return {
    allowed: true,
    usage: {
      rpm: globalUsage.rpm + 1,
      rpd: globalUsage.rpd + 1,
      tpm: globalUsage.tpm, // Not incremented - will be updated after API
      tpd: globalUsage.tpd, // Not incremented - will be updated after API
      userRpd: userUsage.rpd + 1,
      userTpd: userUsage.tpd, // Not incremented - will be updated after API
    },
    limits: {
      ...globalLimits,
      userRpd: userLimits.rpd,
      userTpd: userLimits.tpd,
    },
  };
}

/**
 * Get current quota status without incrementing
 * Returns BOTH global and per-user usage
 */
async function getQuotaStatus(userId) {
  const now = new Date();
  const minute = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
  const day = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;

  // GLOBAL keys (Groq API)
  const globalRpmKey = `global:rpm:${minute}`;
  const globalRpdKey = `global:rpd:${day}`;
  const globalTpmKey = `global:tpm:${minute}`;
  const globalTpdKey = `global:tpd:${day}`;

  // PER-USER keys (Your App)
  const userRpdKey = `user:rpd:${userId}:${day}`;
  const userTpdKey = `user:tpd:${userId}:${day}`;

  // Groq API Global Limits
  const globalLimits = {
    rpm: 30,
    rpd: 14400,
    tpm: 6000,
    tpd: 500000,
  };

  // Your App's Per-User Limits (for FREE users)
  const userLimits = {
    rpd: parseInt(process.env.RATE_LIMIT_RPD || '50', 10),
    tpd: parseInt(process.env.RATE_LIMIT_TPD || '20000', 10),
  };

  const usage = {
    rpm: await getCounter(globalRpmKey),
    rpd: await getCounter(globalRpdKey),
    tpm: await getCounter(globalTpmKey),
    tpd: await getCounter(globalTpdKey),
    userRpd: await getCounter(userRpdKey),
    userTpd: await getCounter(userTpdKey),
  };

  const limits = {
    ...globalLimits,
    userRpd: userLimits.rpd,
    userTpd: userLimits.tpd,
  };

  return { usage, limits };
}

/**
 * Record actual token usage after API response
 * Called AFTER the AI API returns actual token counts
 * @param {string} userId
 * @param {number} actualTokensUsed - Actual tokens from API response
 * @returns {object} { success: boolean }
 */
async function recordActualTokenUsage(userId, actualTokensUsed) {
  try {
    const now = new Date();
    const minute = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
    const day = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;

    // Update GLOBAL token counters with ACTUAL tokens
    const globalTpmKey = `global:tpm:${minute}`;
    const globalTpdKey = `global:tpd:${day}`;
    
    // Update PER-USER token counter with ACTUAL tokens
    const userTpdKey = `user:tpd:${userId}:${day}`;

    // Increment with actual tokens (no estimation)
    await redis.incrby(globalTpmKey, actualTokensUsed);
    await redis.incrby(globalTpdKey, actualTokensUsed);
    await redis.incrby(userTpdKey, actualTokensUsed);

    // Set/extend TTLs if needed
    await redis.expire(globalTpmKey, 60);
    await redis.expire(globalTpdKey, 86400);
    await redis.expire(userTpdKey, 86400);

    return { success: true };
  } catch (error) {
    console.error('Error recording token usage:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Store purchase verification result
 */
async function storePurchase(userId, purchaseData) {
  const key = `purchase:${userId}:${purchaseData.orderId}`;
  await redis.setex(key, 31536000, JSON.stringify(purchaseData)); // 1 year TTL
  return true;
}

/**
 * Get purchase by order ID
 */
async function getPurchase(userId, orderId) {
  const key = `purchase:${userId}:${orderId}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : null;
}


/**
 * Increment quota for ad reward (modular, per module/action)
 * @param {string} userId
 * @param {string} module - e.g. 'pdf', 'translation', 'math', 'qa'
 * @param {string} rewardType - 'tokens' or 'requests'
 * @param {number} amount
 * @returns {object} { success: boolean, usage, limits }
 */
async function incrementRewardQuota(userId, module, rewardType, amount) {
  const now = new Date();
  const minute = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
  const day = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;

  // Use standard keys for quota, but can be extended for module-specific if needed
  let key;
  if (rewardType === 'tokens') {
    key = `tpd:${userId}:${day}`;
  } else if (rewardType === 'requests') {
    key = `rpd:${userId}:${day}`;
  } else {
    return { success: false, error: 'Invalid rewardType' };
  }

  // Increment the quota
  await redis.incrby(key, amount);

  // Return updated usage and limits
  const limits = {
    rpm: parseInt(process.env.RATE_LIMIT_RPM || '30', 10),     // 30 req/min (Groq global)
    rpd: parseInt(process.env.RATE_LIMIT_RPD || '10', 10),     // 10 req/day (per user)
    tpm: parseInt(process.env.RATE_LIMIT_TPM || '6000', 10),   // 6k tokens/min (Groq global)
    tpd: parseInt(process.env.RATE_LIMIT_TPD || '20000', 10),  // 20k tokens/day (per user)
  };
  const usage = {
    rpm: await getCounter(`rpm:${userId}:${minute}`),
    rpd: await getCounter(`rpd:${userId}:${day}`),
    tpm: await getCounter(`tpm:${userId}:${minute}`),
    tpd: await getCounter(`tpd:${userId}:${day}`),
  };
  return { success: true, usage, limits };
}

module.exports = {
  redis,
  incrementCounter,
  getCounter,
  checkAndIncrementLimits,
  recordActualTokenUsage,
  getQuotaStatus,
  storePurchase,
  getPurchase,
  incrementRewardQuota,
};
