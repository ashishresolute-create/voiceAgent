// src/memory/longTerm.ts
import { PrismaClient } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import type { PatientContext } from '../agent/orchestrator';
import type { Language } from '../utils/languageDetect';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();
const anthropic = new Anthropic();

export class LongTermMemory {
  /**
   * Load full patient context: identity, preferences, recent memories,
   * upcoming appointments. Called once at call start.
   */
  async getPatientContext(phone: string): Promise<PatientContext | null> {
    let patient = await prisma.patient.findUnique({
      where: { phone },
      include: {
        memories: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        appointments: {
          where: {
            status: { notIn: ['CANCELLED'] },
            slot: { startTime: { gte: new Date() } },
          },
          include: { doctor: true, slot: true },
          orderBy: { slot: { startTime: 'asc' } },
          take: 3,
        },
      },
    });

    if (!patient) {
      // Auto-create patient record on first contact
      patient = await prisma.patient.create({
        data: { phone },
        include: { memories: true, appointments: { include: { doctor: true, slot: true } } },
      });
    }

    return {
      patientId: patient.id,
      name: patient.name ?? undefined,
      preferredLang: patient.preferredLang as Language,
      recentMemories: patient.memories.map((m) => m.content),
      upcomingAppointments: patient.appointments.map(
        (a) =>
          `${a.doctor.name} on ${a.slot.startTime.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} at ${a.slot.startTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
      ),
    };
  }

  /**
   * Semantic search over patient memories using pgvector.
   * Returns the most relevant past interactions for the current query.
   */
  async searchMemories(patientId: string, query: string, topK = 3): Promise<string[]> {
    try {
      const embedding = await this.embed(query);

      // Raw query for pgvector similarity search
      const results = await prisma.$queryRaw<Array<{ content: string; distance: number }>>`
        SELECT content, embedding <=> ${embedding}::vector AS distance
        FROM "Memory"
        WHERE "patientId" = ${patientId}
          AND embedding IS NOT NULL
        ORDER BY distance ASC
        LIMIT ${topK}
      `;

      return results.map((r) => r.content);
    } catch (err) {
      logger.debug({ err }, 'Vector search failed, using recency fallback');
      const memories = await prisma.memory.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        take: topK,
      });
      return memories.map((m) => m.content);
    }
  }

  /**
   * Summarize and persist the session to long-term memory after each call.
   */
  async saveSessionSummary(
    phone: string,
    sessionState: Record<string, unknown>
  ): Promise<void> {
    const patient = await prisma.patient.findUnique({ where: { phone } });
    if (!patient) return;

    // Update preferred language if changed in session
    if (sessionState.language) {
      await prisma.patient.update({
        where: { id: patient.id },
        data: { preferredLang: sessionState.language as string },
      }).catch(() => {});
    }

    // Generate a concise summary of this interaction
    const summary = await this.generateSummary(sessionState);
    if (!summary) return;

    let embedding: number[] | null = null;
    try {
      embedding = await this.embed(summary);
    } catch {
      logger.debug('Embedding generation failed');
    }

    await prisma.memory.create({
      data: {
        patientId: patient.id,
        content: summary,
        type: 'INTERACTION_SUMMARY',
        ...(embedding ? { embedding: embedding as any } : {}),
      },
    });

    logger.info({ patientId: patient.id }, 'Session summary saved to long-term memory');
  }

  private async generateSummary(sessionState: Record<string, unknown>): Promise<string | null> {
    try {
      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `Summarize this patient call session in 1-2 sentences for medical records. Session state: ${JSON.stringify(sessionState)}`,
          },
        ],
      });
      const block = resp.content[0];
      return block.type === 'text' ? block.text : null;
    } catch {
      return null;
    }
  }

  private async embed(text: string): Promise<number[]> {
    // Use OpenAI text-embedding-3-small (1536 dims, matches schema)
    // Replace with any embedding provider
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    });
    const data = (await resp.json()) as { data: [{ embedding: number[] }] };
    return data.data[0].embedding;
  }
}
