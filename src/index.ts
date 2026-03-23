// src/index.ts
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { handleTwilioWebhook } from './telephony/webhook';
import { handleCallWebSocket } from './pipeline/callHandler';
import { createOutboundRouter } from './outbound/router';
import { logger } from './utils/logger';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Twilio webhook — initiates call, returns TwiML that upgrades to WebSocket
app.post('/incoming-call', handleTwilioWebhook);
app.post('/outbound-call', handleTwilioWebhook);
app.use('/outbound', createOutboundRouter());

const server = createServer(app);

// WebSocket server — Twilio streams audio here
const wss = new WebSocketServer({ server, path: '/audio-stream' });

wss.on('connection', (ws, req) => {
  logger.info({ url: req.url }, 'WebSocket connection established');
  handleCallWebSocket(ws);
});

const PORT = Number(process.env.PORT ?? 3000);
server.listen(PORT, () => {
  logger.info(`Voice agent server running on port ${PORT}`);
  logger.info(`WebSocket endpoint: ws://localhost:${PORT}/audio-stream`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
