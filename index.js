// backend/index.js
// Main Express server for AI Notes & Translator
// Handles purchase verification, model routing, and rate limiting

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const modelRouteRouter = require('./routes/modelRoute');
const verifyPurchaseRouter = require('./routes/verifyPurchase');
const rewardRouteRouter = require('./routes/rewardRoute');
const configRouteRouter = require('./routes/configRoute');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet()); // Security headers
app.use(cors()); // Enable CORS
app.use(compression()); // Compress responses
app.use(express.json({ limit: '10mb' })); // Parse JSON bodies

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


// Routes
app.use('/api', modelRouteRouter);
app.use('/api', verifyPurchaseRouter);
app.use('/api', rewardRouteRouter);
app.use('/api', configRouteRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 AI Notes Backend running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Groq API Key: ${process.env.GROQ_API_KEY ? '✓ Set' : '✗ Missing'}`);
  console.log(`📦 Google Play API: ${process.env.GOOGLE_APPLICATION_CREDENTIALS ? '✓ Set' : '✗ Missing'}`);
});

module.exports = app;
