// src/outbound/router.ts
import { Router } from 'express';
import { CampaignScheduler } from './scheduler';
import { logger } from '../utils/logger';

export function createOutboundRouter(): Router {
  const router = Router();
  const scheduler = new CampaignScheduler();

  // Trigger a reminder campaign for a specific appointment
  router.post('/reminder/:appointmentId', async (req, res) => {
    try {
      const { appointmentId } = req.params;
      const { scheduledAt } = req.body;

      const jobId = await scheduler.scheduleReminder(
        appointmentId,
        scheduledAt ? new Date(scheduledAt) : undefined
      );

      res.json({ success: true, jobId });
    } catch (err) {
      logger.error({ err }, 'Failed to schedule reminder');
      res.status(500).json({ error: 'Failed to schedule reminder' });
    }
  });

  // Trigger follow-up campaign for all appointments from N days ago
  router.post('/follow-up', async (req, res) => {
    try {
      const { daysAgo = 1 } = req.body;
      const count = await scheduler.scheduleFollowUps(Number(daysAgo));
      res.json({ success: true, scheduled: count });
    } catch (err) {
      logger.error({ err }, 'Failed to schedule follow-ups');
      res.status(500).json({ error: 'Failed to schedule follow-ups' });
    }
  });

  // Campaign status
  router.get('/status/:jobId', async (req, res) => {
    try {
      const status = await scheduler.getJobStatus(req.params.jobId);
      res.json(status);
    } catch (err) {
      res.status(404).json({ error: 'Job not found' });
    }
  });

  return router;
}
