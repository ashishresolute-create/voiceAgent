// src/outbound/scheduler.ts
import { Queue, Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { OutboundCaller } from './caller';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

const REDIS_CONNECTION = {
  host: new URL(process.env.REDIS_URL ?? 'redis://localhost:6379').hostname,
  port: Number(new URL(process.env.REDIS_URL ?? 'redis://localhost:6379').port || 6379),
};

interface CampaignJobData {
  type: 'REMINDER' | 'FOLLOW_UP';
  appointmentId: string;
  patientPhone: string;
  patientName?: string;
  doctorName: string;
  appointmentTime: string;
  campaignLogId: string;
}

export class CampaignScheduler {
  private queue: Queue<CampaignJobData>;
  private worker: Worker<CampaignJobData>;
  private caller: OutboundCaller;

  constructor() {
    this.caller = new OutboundCaller();

    this.queue = new Queue<CampaignJobData>('outbound-campaigns', {
      connection: REDIS_CONNECTION,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 }, // retry after 1min, 2min, 4min
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    });

    this.worker = new Worker<CampaignJobData>(
      'outbound-campaigns',
      async (job: Job<CampaignJobData>) => this.processJob(job),
      { connection: REDIS_CONNECTION, concurrency: 5 }
    );

    this.worker.on('completed', (job) => {
      logger.info({ jobId: job.id, type: job.data.type }, 'Campaign job completed');
    });

    this.worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, err }, 'Campaign job failed');
    });
  }

  async scheduleReminder(
    appointmentId: string,
    scheduledAt?: Date
  ): Promise<string> {
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { patient: true, doctor: true, slot: true },
    });

    if (!appointment) throw new Error(`Appointment ${appointmentId} not found`);

    // Default: remind 24h before appointment
    const fireAt = scheduledAt ?? new Date(appointment.slot.startTime.getTime() - 86_400_000);
    const delay = Math.max(0, fireAt.getTime() - Date.now());

    const campaignLog = await prisma.campaignLog.create({
      data: {
        patientId: appointment.patientId,
        type: 'REMINDER',
        scheduledAt: fireAt,
      },
    });

    const job = await this.queue.add(
      'reminder',
      {
        type: 'REMINDER',
        appointmentId,
        patientPhone: appointment.patient.phone,
        patientName: appointment.patient.name ?? undefined,
        doctorName: appointment.doctor.name,
        appointmentTime: appointment.slot.startTime.toISOString(),
        campaignLogId: campaignLog.id,
      },
      { delay }
    );

    logger.info(
      { jobId: job.id, delay: Math.round(delay / 1000) + 's' },
      'Reminder scheduled'
    );

    return job.id!;
  }

  async scheduleFollowUps(daysAgo: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysAgo);

    const appointments = await prisma.appointment.findMany({
      where: {
        status: 'COMPLETED',
        slot: {
          startTime: {
            gte: new Date(cutoff.getTime() - 86_400_000),
            lte: cutoff,
          },
        },
        // Don't send duplicate follow-ups
        patient: {
          campaignLogs: {
            none: {
              type: 'FOLLOW_UP',
              createdAt: { gte: cutoff },
            },
          },
        },
      },
      include: { patient: true, doctor: true, slot: true },
    });

    let scheduled = 0;
    for (const appt of appointments) {
      try {
        const campaignLog = await prisma.campaignLog.create({
          data: {
            patientId: appt.patientId,
            type: 'FOLLOW_UP',
            scheduledAt: new Date(),
          },
        });

        await this.queue.add('follow-up', {
          type: 'FOLLOW_UP',
          appointmentId: appt.id,
          patientPhone: appt.patient.phone,
          patientName: appt.patient.name ?? undefined,
          doctorName: appt.doctor.name,
          appointmentTime: appt.slot.startTime.toISOString(),
          campaignLogId: campaignLog.id,
        });

        scheduled++;
      } catch (err) {
        logger.error({ err, appointmentId: appt.id }, 'Failed to schedule follow-up');
      }
    }

    return scheduled;
  }

  async getJobStatus(jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job) throw new Error('Job not found');

    const state = await job.getState();
    return {
      jobId,
      state,
      data: job.data,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      finishedOn: job.finishedOn,
    };
  }

  private async processJob(job: Job<CampaignJobData>): Promise<void> {
    const { type, patientPhone, patientName, doctorName, appointmentTime, campaignLogId } =
      job.data;

    await prisma.campaignLog.update({
      where: { id: campaignLogId },
      data: { status: 'IN_PROGRESS' },
    });

    try {
      const outcome = await this.caller.dial({
        to: patientPhone,
        campaignType: type,
        context: { patientName, doctorName, appointmentTime },
      });

      await prisma.campaignLog.update({
        where: { id: campaignLogId },
        data: { status: 'COMPLETED', completedAt: new Date(), outcome },
      });
    } catch (err) {
      await prisma.campaignLog.update({
        where: { id: campaignLogId },
        data: { status: 'FAILED', outcome: String(err) },
      });
      throw err;
    }
  }
}
