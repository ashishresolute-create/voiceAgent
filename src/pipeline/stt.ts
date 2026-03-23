// src/pipeline/stt.ts
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { Writable } from 'stream';
import { logger } from '../utils/logger';

interface STTOptions {
  onTranscript: (text: string, isFinal: boolean) => Promise<void>;
  onError: (err: Error) => void;
}

export function createSTTStream(options: STTOptions): Writable {
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);

  const connection = deepgram.listen.live({
    model: 'nova-2-general',
    language: 'multi',          // Deepgram multi-language handles EN/HI/TA
    encoding: 'mulaw',          // Twilio sends mulaw 8kHz
    sample_rate: 8000,
    channels: 1,
    interim_results: true,
    endpointing: 300,           // ms of silence to finalize utterance
    smart_format: true,
    punctuate: true,
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data.channel?.alternatives?.[0];
    if (!alt?.transcript) return;

    const isFinal = data.is_final ?? false;
    options.onTranscript(alt.transcript, isFinal).catch(options.onError);
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    logger.error({ err }, 'Deepgram error');
    options.onError(err instanceof Error ? err : new Error(String(err)));
  });

  // Writable stream that pipes Twilio mulaw audio into Deepgram
  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (connection.getReadyState() === 1) {
        connection.send(chunk);
      }
      callback();
    },
    destroy(err, callback) {
      connection.finish();
      callback(err);
    },
  });

  return writable;
}
