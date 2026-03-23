// src/outbound/caller.ts
import twilio from 'twilio';
import { logger } from '../utils/logger';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

interface DialOptions {
  to: string;
  campaignType: 'REMINDER' | 'FOLLOW_UP';
  context: {
    patientName?: string;
    doctorName: string;
    appointmentTime: string;
  };
}

export class OutboundCaller {
  private client: twilio.Twilio;

  constructor() {
    this.client = twilio(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!
    );
  }

  async dial(opts: DialOptions): Promise<string> {
    const { to, campaignType, context } = opts;

    // Pass campaign context as URL params — webhook reads them and seeds the agent
    const params = new URLSearchParams({
      campaignType,
      patientName: context.patientName ?? '',
      doctorName: context.doctorName,
      appointmentTime: context.appointmentTime,
    });

    logger.info({ to, campaignType }, 'Initiating outbound call');

    const call = await this.client.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER!,
      url: `${BASE_URL}/outbound-call?${params}`,
      statusCallback: `${BASE_URL}/outbound/status`,
      statusCallbackMethod: 'POST',
      machineDetection: 'DetectMessageEnd', // AMD: skip voicemail
      machineDetectionTimeout: 8,
    });

    logger.info({ callSid: call.sid }, 'Outbound call initiated');
    return call.sid;
  }
}
