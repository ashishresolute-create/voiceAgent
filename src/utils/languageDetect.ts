// src/utils/languageDetect.ts

export type Language = 'EN' | 'HI' | 'TA';

// Unicode ranges for script detection
const DEVANAGARI = /[\u0900-\u097F]/;   // Hindi
const TAMIL_SCRIPT = /[\u0B80-\u0BFF]/; // Tamil

/**
 * Fast rule-based language detection using Unicode script ranges.
 * Falls back to English. Deepgram's multi-language model also provides
 * language hints which can be used as a secondary signal.
 */
export function detectLanguage(text: string): Language {
  if (!text || text.trim().length === 0) return 'EN';

  const devanagariCount = (text.match(DEVANAGARI) ?? []).length;
  const tamilCount = (text.match(TAMIL_SCRIPT) ?? []).length;
  const totalChars = text.replace(/\s/g, '').length;

  if (totalChars === 0) return 'EN';

  const devanagariRatio = devanagariCount / totalChars;
  const tamilRatio = tamilCount / totalChars;

  // Threshold: > 15% of chars in a script = that language
  if (tamilRatio > 0.15) return 'TA';
  if (devanagariRatio > 0.15) return 'HI';
  return 'EN';
}

export function languageToLocale(lang: Language): string {
  const map: Record<Language, string> = {
    EN: 'en-IN',
    HI: 'hi-IN',
    TA: 'ta-IN',
  };
  return map[lang];
}
