// backend/services/modelRouter.js
// Intelligent model selection and AI request routing
// Switches to fallback model when approaching limits

const Groq = require('groq-sdk');
const { checkAndIncrementLimits, recordActualTokenUsage, getQuotaStatus } = require('./redisClient');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Model configurations
const MODELS = {
  default: 'llama-3.1-8b-instant',
  fallback: 'compound-mini',
};

// Fallback threshold (70% of limits)
const FALLBACK_THRESHOLD = parseFloat(process.env.FALLBACK_THRESHOLD_PERCENT || '70') / 100;

// Hysteresis: stay in fallback for this many minutes
let fallbackModeUntil = null;
const FALLBACK_DURATION_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Estimate tokens from text (heuristic: 1 token ≈ 0.75 words)
 */
function estimateTokens(text) {
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.ceil(words * 0.75);
}

/**
 * Determine which model to use based on current usage
 */
async function selectModel(userId, preferredModel = MODELS.default) {
  const { usage, limits } = await getQuotaStatus(userId);

  // Check if we're in forced fallback mode (hysteresis)
  const now = Date.now();
  if (fallbackModeUntil && now < fallbackModeUntil) {
    return MODELS.fallback;
  }

  // Calculate usage percentages
  const tpdPercent = usage.tpd / limits.tpd;
  const rpmPercent = usage.rpm / limits.rpm;

  // Switch to fallback if approaching limits
  if (tpdPercent > FALLBACK_THRESHOLD || rpmPercent > FALLBACK_THRESHOLD) {
    // Activate fallback mode with hysteresis
    fallbackModeUntil = now + FALLBACK_DURATION_MS;
    return MODELS.fallback;
  }

  // Check if we can exit fallback mode (usage < 50%)
  if (tpdPercent < 0.5 && rpmPercent < 0.5) {
    fallbackModeUntil = null;
  }

  return preferredModel || MODELS.default;
}

/**
 * Route AI request to Groq with rate limiting and model selection
 */
async function routeModelRequest({
  userId,
  prompt,
  systemPrompt = '',
  maxTokens = 1000,
  temperature = 0.7,
  taskType = 'general',
  preferredModel = MODELS.default,
}) {
  try {
    // Estimate tokens for rate limiting
    const promptTokens = estimateTokens(prompt + systemPrompt);
    const estimatedTotalTokens = promptTokens + maxTokens;

    // Check rate limits
    const limitCheck = await checkAndIncrementLimits(userId, estimatedTotalTokens);
    
    if (!limitCheck.allowed) {
      return {
        success: false,
        error: limitCheck.reason,
        remainingQuota: {
          tokensPerMinute: limitCheck.limits.tpm - limitCheck.usage.tpm,
          tokensPerDay: limitCheck.limits.tpd - limitCheck.usage.tpd,
          requestsPerMinute: limitCheck.limits.rpm - limitCheck.usage.rpm,
          requestsPerDay: limitCheck.limits.rpd - limitCheck.usage.rpd,
        },
      };
    }

    // Select appropriate model
    const modelToUse = await selectModel(userId, preferredModel);

    // Build messages
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    // Call Groq API
    const chatCompletion = await groq.chat.completions.create({
      messages,
      model: modelToUse,
      temperature,
      max_tokens: maxTokens,
      top_p: 0.9,
    });

    const response = chatCompletion.choices[0]?.message?.content || '';
    const actualTokensUsed = chatCompletion.usage?.total_tokens || estimatedTotalTokens;

    // ✅ Record actual tokens AFTER API response
    await recordActualTokenUsage(userId, actualTokensUsed);

    // Log usage for monitoring
    console.log(`[${taskType}] User: ${userId}, Model: ${modelToUse}, Tokens: ${actualTokensUsed}`);

    return {
      success: true,
      response,
      modelUsed: modelToUse,
      tokensUsed: actualTokensUsed,
      remainingQuota: {
        tokensPerMinute: limitCheck.limits.tpm - limitCheck.usage.tpm,
        tokensPerDay: limitCheck.limits.tpd - limitCheck.usage.tpd,
        requestsPerMinute: limitCheck.limits.rpm - limitCheck.usage.rpm,
        requestsPerDay: limitCheck.limits.rpd - limitCheck.usage.rpd,
      },
    };
  } catch (error) {
    console.error('Model routing error:', error);
    return {
      success: false,
      error: error.message || 'AI request failed',
      modelUsed: null,
      tokensUsed: 0,
    };
  }
}

/**
 * Get recommended model without making a request
 */
async function getRecommendedModel(userId) {
  return await selectModel(userId);
}

module.exports = {
  routeModelRequest,
  getRecommendedModel,
  estimateTokens,
  MODELS,
};
