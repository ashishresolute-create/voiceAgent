// src/pipeline/tts.ts
import { ElevenLabsClient } from 'elevenlabs';
import { logger } from '../utils/logger';
import type { Language } from '../utils/languageDetect';

interface TTSOptions {
  language: Language;
  onAudioChunk: (chunk: Buffer) => void;
  onDone: () => void;
}

const VOICE_IDS: Record<Language, string> = {
  EN: process.env.ELEVENLABS_VOICE_ID_EN ?? 'EXAVITQu4vr4xnSDxMaL',
  HI: process.env.ELEVENLABS_VOICE_ID_HI ?? 'EXAVITQu4vr4xnSDxMaL',
  TA: process.env.ELEVENLABS_VOICE_ID_TA ?? 'EXAVITQu4vr4xnSDxMaL',
};

export interface TTSStream {
  write(text: string): void;
  end(): void;
}

export function createTTSStream(options: TTSOptions): TTSStream {
  const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY! });
  const voiceId = VOICE_IDS[options.language];

  let textBuffer = '';
  let streamPromise: Promise<void> | null = null;
  let resolveStream: (() => void) | null = null;
  const textQueue: string[] = [];
  let ended = false;
  let started = false;

  async function startStream(): Promise<void> {
    // Use websocket streaming API for lowest latency
    const audioStream = await client.textToSpeech.streamWithTimestamps(voiceId, {
      text: textQueue.join(''),
      model_id: 'eleven_turbo_v2',    // Lowest latency model
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.2,
        use_speaker_boost: true,
      },
      output_format: 'ulaw_8000',     // Matches Twilio's expected format
    });

    for await (const chunk of audioStream) {
      if (chunk.audio) {
        const audioBuffer = Buffer.from(chunk.audio, 'base64');
        options.onAudioChunk(audioBuffer);
      }
    }

    options.onDone();
  }

  // Sentence-aware chunking: flush when we see sentence boundary
  // This keeps latency low by not waiting for full LLM response
  function maybeFlush(force = false): void {
    const sentenceEnd = /[.!?।\n]/;
    const idx = textBuffer.search(sentenceEnd);

    if (force || idx >= 0) {
      const toSend = force ? textBuffer : textBuffer.slice(0, idx + 1);
      textBuffer = force ? '' : textBuffer.slice(idx + 1);

      if (toSend.trim()) {
        textQueue.push(toSend);

        if (!started) {
          started = true;
          streamPromise = startStream().catch((err) =>
            logger.error({ err }, 'TTS stream error')
          );
        }
      }
    }
  }

  return {
    write(text: string) {
      textBuffer += text;
      maybeFlush();
    },
    end() {
      ended = true;
      maybeFlush(true);
    },
  };
}
