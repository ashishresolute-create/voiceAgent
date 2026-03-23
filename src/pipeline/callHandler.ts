// src/pipeline/callHandler.ts
import type WebSocket from 'ws';
import { createSTTStream } from './stt';
import { createTTSStream } from './tts';
import { AgentOrchestrator } from '../agent/orchestrator';
import { SessionMemory } from '../memory/session';
import { LongTermMemory } from '../memory/longTerm';
import { detectLanguage, type Language } from '../utils/languageDetect';
import { logger } from '../utils/logger';
import { LatencyTracker } from '../utils/latency';

interface TwilioMessage {
  event: 'connected' | 'start' | 'media' | 'stop';
  streamSid?: string;
  start?: { callSid: string; customParameters: Record<string, string> };
  media?: { payload: string; track: string; chunk: string; timestamp: string };
}

export function handleCallWebSocket(ws: WebSocket): void {
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let patientPhone: string | null = null;
  let currentLang: Language = 'EN';
  let isSpeaking = false; // true while we're streaming TTS audio back
  let abortController: AbortController | null = null;

  const latency = new LatencyTracker();
  const sessionMemory = new SessionMemory();
  let orchestrator: AgentOrchestrator | null = null;

  // STT stream: feeds raw mulaw audio, emits transcript events
  const stt = createSTTStream({
    onTranscript: async (transcript, isFinal) => {
      if (!isFinal || !transcript.trim()) return;

      // Barge-in: if agent is speaking, abort and clear audio queue
      if (isSpeaking && abortController) {
        logger.info('Barge-in detected, interrupting TTS');
        abortController.abort();
        sendClearAudio(ws, streamSid!);
        isSpeaking = false;
      }

      latency.mark('stt_final');
      logger.info({ transcript, lang: currentLang }, 'STT final transcript');

      // Detect language per utterance
      const detectedLang = detectLanguage(transcript);
      if (detectedLang !== currentLang) {
        currentLang = detectedLang;
        sessionMemory.set('language', currentLang);
        logger.info({ currentLang }, 'Language switched');
      }

      // Run agent and stream response
      abortController = new AbortController();
      await streamAgentResponse(transcript);
    },
    onError: (err) => logger.error({ err }, 'STT error'),
  });

  async function streamAgentResponse(userText: string): Promise<void> {
    if (!orchestrator) return;

    latency.mark('llm_start');
    isSpeaking = true;

    const tts = createTTSStream({
      language: currentLang,
      onAudioChunk: (chunk: Buffer) => {
        if (abortController?.signal.aborted) return;
        sendAudioChunk(ws, streamSid!, chunk);
      },
      onDone: () => {
        isSpeaking = false;
        const total = latency.elapsed('stt_final', 'tts_done');
        logger.info({ latencyMs: total }, 'End-to-end latency');
      },
    });

    latency.mark('tts_start');

    try {
      for await (const token of orchestrator.streamResponse(userText, currentLang)) {
        if (abortController?.signal.aborted) break;
        tts.write(token);
      }
      latency.mark('tts_done');
      tts.end();
    } catch (err: any) {
      if (err?.name !== 'AbortError') logger.error({ err }, 'Agent stream error');
      isSpeaking = false;
    }
  }

  ws.on('message', async (raw: Buffer) => {
    let msg: TwilioMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start': {
        streamSid = msg.streamSid ?? null;
        callSid = msg.start?.callSid ?? null;
        patientPhone = msg.start?.customParameters?.from ?? null;

        logger.info({ callSid, patientPhone }, 'Call started');

        // Load patient context from long-term memory
        const ltm = new LongTermMemory();
        const patientContext = patientPhone
          ? await ltm.getPatientContext(patientPhone)
          : null;

        orchestrator = new AgentOrchestrator({
          sessionMemory,
          ltm,
          patientContext,
          callSid: callSid ?? 'unknown',
        });

        // Greet patient
        await streamAgentResponse('[CALL_START]');
        break;
      }

      case 'media': {
        if (!msg.media?.payload) return;
        const audio = Buffer.from(msg.media.payload, 'base64');
        stt.write(audio);
        break;
      }

      case 'stop': {
        logger.info({ callSid }, 'Call ended');
        stt.destroy();

        // Persist session summary to long-term memory
        if (orchestrator && patientPhone) {
          const ltm = new LongTermMemory();
          await ltm.saveSessionSummary(patientPhone, sessionMemory.getAll());
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    stt.destroy();
    abortController?.abort();
  });
}

function sendAudioChunk(ws: WebSocket, streamSid: string, chunk: Buffer): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    event: 'media',
    streamSid,
    media: { payload: chunk.toString('base64') },
  }));
}

function sendClearAudio(ws: WebSocket, streamSid: string): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ event: 'clear', streamSid }));
}
