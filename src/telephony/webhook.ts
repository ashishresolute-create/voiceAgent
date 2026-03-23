// src/telephony/webhook.ts
import type { Request, Response } from 'express';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const WS_URL = BASE_URL.replace(/^https?/, 'wss');

export function handleTwilioWebhook(req: Request, res: Response): void {
  const callSid = req.body.CallSid ?? 'unknown';
  const from = req.body.From ?? 'unknown';

  // TwiML: say a greeting while WebSocket handshake happens, then stream audio
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${WS_URL}/audio-stream">
      <Parameter name="callSid" value="${callSid}"/>
      <Parameter name="from" value="${from}"/>
    </Stream>
  </Connect>
</Response>`;

  res.setHeader('Content-Type', 'text/xml');
  res.send(twiml);
}
