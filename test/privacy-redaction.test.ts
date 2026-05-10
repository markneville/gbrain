import { describe, expect, test } from 'bun:test';
import {
  assertSafeToEmit,
  PrivacyRedactionError,
  safeAnomalyResults,
  safeSalienceResults,
  sanitizeForSafeEmit,
  sanitizeTextForSafeEmit,
} from '../src/core/privacy-redaction.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AnomalyResult, SalienceResult } from '../src/core/types.ts';

describe('privacy redaction gate', () => {
  test('redacts secrets before safe emit', () => {
    const r = sanitizeTextForSafeEmit('token=sk-testabcdefghijklmnop1234 and Bearer abcdefghijklmnop123456');
    expect(r.redacted).toBe(true);
    expect(r.value).not.toContain('sk-testabcdefghijklmnop1234');
    expect(r.value).not.toContain('abcdefghijklmnop123456');
    expect(r.matches).toContain('openai-key');
    expect(r.matches).toContain('bearer-token');
  });

  test('redacts passport identifiers and MRZ-shaped values', () => {
    const r = sanitizeTextForSafeEmit('passport number 123456789 MRZ P<GBRDOE<<JANE<<<<<<<<<<<<<<<<<<<<<<<<');
    expect(r.value).not.toContain('123456789');
    expect(r.value).not.toContain('P<GBRDOE');
    expect(r.matches).toContain('passport-number-label');
    expect(r.matches).toContain('mrz-passport');
  });

  test('redacts private street addresses', () => {
    const r = sanitizeTextForSafeEmit('Ship to 1234 Example Drive, Saint Louis MO 63101');
    expect(r.value).toContain('[private address redacted]');
    expect(r.value).not.toContain('1234 Example Drive');
    expect(r.matches).toContain('us-street-address');
  });

  test('redacts raw transcript references', () => {
    const r = sanitizeTextForSafeEmit('raw transcript in sessions/2026-05-08-chat.txt says something');
    expect(r.value).not.toContain('raw transcript');
    expect(r.value).not.toContain('sessions/2026-05-08-chat.txt');
    expect(r.matches).toContain('raw-transcript');
    expect(r.matches).toContain('transcript-path');
  });

  test('redacts slug/path delimiter secret forms without over-redacting ordinary prose', () => {
    const r = sanitizeTextForSafeEmit([
      'transcripts/passport-no-A12345678-secret-supersecretvalue12345',
      'reports/token-tokenvalue987654321',
      'ops/api-key-keyvalue123456789',
      'admin/password-passwordvalue123456789',
      'admin/pwd-pwdvalue123456789',
      'admin/client-secret-clientsecret123456789',
    ].join(' '));

    expect(r.redacted).toBe(true);
    expect(r.matches).toContain('secret-delimited');
    expect(r.value).not.toContain('supersecretvalue12345');
    expect(r.value).not.toContain('tokenvalue987654321');
    expect(r.value).not.toContain('keyvalue123456789');
    expect(r.value).not.toContain('passwordvalue123456789');
    expect(r.value).not.toContain('pwdvalue123456789');
    expect(r.value).not.toContain('clientsecret123456789');

    const ordinary = sanitizeTextForSafeEmit('secret-santa party, token-ring network, and password-reset docs');
    expect(ordinary.redacted).toBe(false);
    expect(ordinary.value).toContain('secret-santa');
    expect(ordinary.value).toContain('token-ring');
    expect(ordinary.value).toContain('password-reset');
  });

  test('redacts salience and anomaly slug secret values before residual checks', () => {
    const salience = safeSalienceResults([{
      slug: 'transcripts/passport-no-A12345678-secret-supersecretvalue12345',
      source_id: 'default',
      title: 'api-key-keyvalue123456789',
      type: 'note',
      updated_at: new Date('2026-05-08T00:00:00Z'),
      emotional_weight: 0.8,
      take_count: 2,
      take_avg_weight: 0.7,
      score: 4.2,
    } satisfies SalienceResult]);
    const anomalies = safeAnomalyResults([{
      cohort_kind: 'tag',
      cohort_value: 'token-tokenvalue987654321',
      count: 2,
      baseline_mean: 0,
      baseline_stddev: 0,
      sigma_observed: 2,
      page_slugs: ['admin/password-passwordvalue123456789', 'admin/pwd-pwdvalue123456789'],
    } satisfies AnomalyResult]);

    const serialized = JSON.stringify({ salience, anomalies });
    expect(serialized).not.toContain('supersecretvalue12345');
    expect(serialized).not.toContain('keyvalue123456789');
    expect(serialized).not.toContain('tokenvalue987654321');
    expect(serialized).not.toContain('passwordvalue123456789');
    expect(serialized).not.toContain('pwdvalue123456789');
  });

  test('fails closed on residual delimiter secret forms in parser/runtime output', () => {
    expect(() => assertSafeToEmit('secret-supersecretvalue12345')).toThrow(PrivacyRedactionError);
    expect(() => assertSafeToEmit({ slug: 'transcripts/token-tokenvalue987654321' })).toThrow(PrivacyRedactionError);
  });

  test('redacts unnecessary health/admin detail', () => {
    const r = sanitizeTextForSafeEmit('NAION and BP with Losartan plus expedited passport renewal');
    expect(r.value).not.toContain('NAION');
    expect(r.value).not.toContain('Losartan');
    expect(r.value).not.toContain('passport renewal');
    expect(r.matches).toContain('health-admin-detail');
  });

  test('sanitizes salience slugs and titles before emission', () => {
    const rows: SalienceResult[] = [{
      slug: 'personal/raw-transcript/sk-tes...cdef',
      source_id: 'default',
      title: 'Passport number 123456789 and 1234 Example Drive, Saint Louis MO 63101',
      type: 'note',
      updated_at: new Date('2026-05-08T00:00:00Z'),
      emotional_weight: 0.8,
      take_count: 2,
      take_avg_weight: 0.7,
      score: 4.2,
    }];
    const safe = safeSalienceResults(rows);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('sk-tes...cdef');
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain('1234 Example Drive');
    expect(serialized).toContain('[redacted]');
  });

  test('sanitizes anomaly cohort values and page slugs before emission', () => {
    const rows: AnomalyResult[] = [{
      cohort_kind: 'tag',
      cohort_value: 'BP and passport renewal',
      count: 3,
      baseline_mean: 0,
      baseline_stddev: 0,
      sigma_observed: 3,
      page_slugs: ['transcripts/2026-05-08.txt', 'admin/1234 Example Drive, Saint Louis MO 63101'],
    }];
    const safe = safeAnomalyResults(rows);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('BP');
    expect(serialized).not.toContain('passport renewal');
    expect(serialized).not.toContain('transcripts/2026-05-08.txt');
    expect(serialized).not.toContain('1234 Example Drive');
  });

  test('fails closed if a residual forbidden value remains', () => {
    expect(() => assertSafeToEmit('Bearer abcdefghijklmnop123456')).toThrow(PrivacyRedactionError);
  });

  test('recursively sanitizes generic report objects', () => {
    const r = sanitizeForSafeEmit({
      summary: 'NAION from raw transcript',
      evidence: ['api_key=abcdefghijk12345', '1234 Example Drive, Saint Louis MO 63101'],
    });
    const serialized = JSON.stringify(r.value);
    expect(serialized).not.toContain('NAION');
    expect(serialized).not.toContain('raw transcript');
    expect(serialized).not.toContain('abcdefghijk12345');
    expect(serialized).not.toContain('1234 Example Drive');
  });

  test('get_recent_salience operation emits only gated rows for remote clients', async () => {
    const ctx = fakeCtx({
      async getRecentSalience() {
        return [{
          slug: 'sessions/2026-05-08.txt',
          source_id: 'default',
          title: 'NAION at 1234 Example Drive, Saint Louis MO 63101',
          type: 'note',
          updated_at: new Date('2026-05-08T00:00:00Z'),
          emotional_weight: 0.8,
          take_count: 2,
          take_avg_weight: 0.7,
          score: 4.2,
        } satisfies SalienceResult];
      },
    });
    const out = await operationsByName.get_recent_salience.handler(ctx, {});
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('sessions/2026-05-08.txt');
    expect(serialized).not.toContain('NAION');
    expect(serialized).not.toContain('1234 Example Drive');
  });

  test('find_anomalies operation emits only gated rows for remote clients', async () => {
    const ctx = fakeCtx({
      async findAnomalies() {
        return [{
          cohort_kind: 'tag',
          cohort_value: 'passport renewal',
          count: 2,
          baseline_mean: 0,
          baseline_stddev: 0,
          sigma_observed: 2,
          page_slugs: ['admin/passport-number-123456789', '1234 Example Drive, Saint Louis MO 63101'],
        } satisfies AnomalyResult];
      },
    });
    const out = await operationsByName.find_anomalies.handler(ctx, {});
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('passport renewal');
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain('1234 Example Drive');
  });
});

function fakeCtx(engineMethods: Partial<BrainEngine>): OperationContext {
  return {
    engine: engineMethods as BrainEngine,
    config: {},
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
  } as unknown as OperationContext;
}
