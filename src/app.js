const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config/env');
const poseRoutes = require('./routes/poseRoutes');
const securityHeaders = require('./middleware/securityHeaders');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { checkConnection: checkPostgres } = require('./db/postgres');
const { checkConnection: checkMongo } = require('./db/mongo');

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);

// By default no other website may call this API from a browser. The bundled web UI is served by this
// same server, so it needs no CORS. List extra origins in ALLOWED_ORIGINS to open it to specific sites.
if (config.allowedOrigins.length > 0) {
  app.use(cors({ origin: config.allowedOrigins, allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'] }));
}

// Small JSON bodies only: the only JSON the API accepts is a record update (keypoints for up to
// POSE_MAX_PEOPLE people, a few tens of KB at most).
app.use(express.json({ limit: '256kb' }));

// Liveness plus a yes/no for each database. Never the driver's error text (host names, ports, users).
app.get('/health', async (req, res) => {
  const status = { server: 'ok', postgres: 'ok', mongo: 'ok' };
  try {
    await checkPostgres();
  } catch (err) {
    status.postgres = 'error';
    console.error('[health] postgres:', err.message);
  }
  try {
    await checkMongo();
  } catch (err) {
    status.mongo = 'error';
    console.error('[health] mongo:', err.message);
  }
  const healthy = status.postgres === 'ok' && status.mongo === 'ok';
  res.status(healthy ? 200 : 503).json(status);
});

// The web UI (HTML, JS, CSS) holds no data, so it is served without the API key; every data route is protected.
app.use(express.static(path.join(__dirname, '../public')));

app.use('/', poseRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
