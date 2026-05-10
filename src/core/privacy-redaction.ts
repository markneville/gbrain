/**
 * Fail-closed privacy redaction for salience/anomaly/report surfaces.
 *
 * These helpers are deterministic and deliberately conservative. They run on
 * structured outputs before the values can be emitted to remote MCP clients,
 * subagents, Telegram-facing cron/report code, or human CLI output. If a value
 * still matches a forbidden pattern after sanitization, the caller must refuse
 * to emit it rather than trusting prompt wording as a privacy layer.
 */

import type { AnomalyResult, SalienceResult } from './types.ts';

export const REDACTION = '[redacted]';

interface ForbiddenPattern {
  name: string;
  regex: RegExp;
  replacement?: string;
}

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  // Secrets / credentials.
  { name: 'bearer-token', regex: /\bBearer\s+[A-Za-z0-9._~+\/=:-]{12,}\b/gi, replacement: 'Bearer [redacted]' },
  { name: 'openai-key', regex: /\bsk-[A-Za-z0-9._-]{8,}\b/g, replacement: REDACTION },
  { name: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replacement: REDACTION },
  { name: 'github-token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, replacement: REDACTION },
  { name: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTION },
  { name: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTION },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: REDACTION },
  { name: 'secret-assignment', regex: /\b((?:api[_-]?key|secret|token|password|passwd|pwd))\s*[:=]\s*[^\s,;]{8,}/gi, replacement: '$1 redacted' },
  { name: 'secret-delimited', regex: /\b((?:api[_-]?key|access[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd))[-_:]((?=[A-Za-z0-9._~+/=-]{8,}\b)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]+)/gi, replacement: '$1-[redacted]' },

  // Passport / identity documents. Keep broad because MRZ leaks are catastrophic.
  { name: 'mrz-passport', regex: /P<[A-Z0-9<]{20,}/g, replacement: REDACTION },
  { name: 'mrz-second-line', regex: /\b[A-Z0-9<]{9}[0-9][A-Z]{3}[0-9<]{7}[MF<][0-9<]{7}[A-Z0-9<]{10,}\b/g, replacement: REDACTION },
  { name: 'passport-number-label', regex: /\bpassport(?:[-_\s]*(?:no\.?|number|#|id))?[-_\s:#]*[A-Z0-9]{6,12}\b/gi, replacement: 'passport [redacted]' },

  // Private postal addresses. Tests use fake addresses; this is generic enough
  // for US/UK street-address leakage without encoding private user data.
  { name: 'us-street-address', regex: /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:St|Street|Ave|Avenue|Dr|Drive|Rd|Road|Ln|Lane|Ct|Court|Way|Blvd|Boulevard|Pl|Place)\b(?:,?\s+[A-Za-z .'-]+)?(?:,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/gi, replacement: '[private address redacted]' },
  { name: 'uk-postcode-address', regex: /\b\d{1,5}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:Road|Street|Lane|Close|Avenue|Drive|Way|Court|Gardens)\b[^\n,;]*\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, replacement: '[private address redacted]' },

  // Raw transcript / corpus references should not leave local trust boundary.
  { name: 'raw-transcript', regex: /\b(?:raw\s+)?(?:transcript|session\s+transcript|chat\s+transcript|meeting\s+transcript)\b/gi, replacement: '[conversation redacted]' },
  { name: 'transcript-path', regex: /(?:^|[\s"'`])(?:\.\.\/|\/)?(?:sessions?|transcripts?|dream[-_ ]?corpus|chat)\/[A-Za-z0-9._/@-]+/gi, replacement: ' [conversation path redacted]' },

  // Health/admin terms are over-redacted in cockpit emissions. The safe output
  // should say meaning/risk/next action, not diagnostic or medication detail.
  { name: 'health-admin-detail', regex: /\b(?:NAION|disc\s+at\s+risk|HCTZ|hydrochlorothiazide|losartan|blood\s+pressure|\bBP\b|passport\s+renewal|expedited\s+passport|tax\s+(?:stress|debt|return|filing))\b/gi, replacement: '[sensitive detail redacted]' },
];

const RESIDUAL_FORBIDDEN_PATTERNS = FORBIDDEN_PATTERNS.map(p => ({
  name: p.name,
  regex: new RegExp(p.regex.source, p.regex.flags.replace('g', '')),
}));

export interface PrivacyGateResult<T> {
  value: T;
  redacted: boolean;
  matches: string[];
}

export class PrivacyRedactionError extends Error {
  constructor(public matches: string[]) {
    super(`privacy redaction failed closed: ${matches.join(', ')}`);
    this.name = 'PrivacyRedactionError';
  }
}

export function sanitizeTextForSafeEmit(input: string): PrivacyGateResult<string> {
  let value = input;
  const matches = new Set<string>();
  for (const pattern of FORBIDDEN_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(value)) {
      matches.add(pattern.name);
      pattern.regex.lastIndex = 0;
      value = value.replace(pattern.regex, pattern.replacement ?? REDACTION);
    }
  }
  return { value, redacted: matches.size > 0, matches: Array.from(matches).sort() };
}

export function sanitizeForSafeEmit<T>(input: T): PrivacyGateResult<T> {
  const matches = new Set<string>();

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const result = sanitizeTextForSafeEmit(value);
      for (const match of result.matches) matches.add(match);
      return result.value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) out[key] = walk(child);
      return out;
    }
    return value;
  };

  const value = walk(input) as T;
  assertSafeToEmit(value);
  return { value, redacted: matches.size > 0, matches: Array.from(matches).sort() };
}

export function safeSalienceResults(rows: SalienceResult[]): SalienceResult[] {
  return sanitizeForSafeEmit(rows).value;
}

export function safeAnomalyResults(rows: AnomalyResult[]): AnomalyResult[] {
  return sanitizeForSafeEmit(rows).value;
}

export function assertSafeToEmit(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const matches = RESIDUAL_FORBIDDEN_PATTERNS
    .filter(pattern => pattern.regex.test(text))
    .map(pattern => pattern.name);
  if (matches.length > 0) throw new PrivacyRedactionError(Array.from(new Set(matches)).sort());
}
