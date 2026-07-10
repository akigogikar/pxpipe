import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/worker.js';

/**
 * IMPROVEMENT_PLAN §2 — the Worker's tracker writes to console.log, which
 * Cloudflare ingests as Workers Logs: an OFF-MACHINE third-party sink. On 4xx
 * the ProxyEvent carries the gzipped transformed prompt body and the caller's
 * cwd/git_branch/os_version. These must never appear in the default Worker
 * track payload; PXPIPE_TRACK_BODY_SAMPLES=1 is the explicit opt-in.
 */

const FORBIDDEN_KEYS = [
  'req_body_sample_b64',
  'req_body_sample_path',
  'error_body',
  'cwd',
  'git_branch',
  'os_version',
];

const ctx = {
  waitUntil: (_p: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function messagesRequest(): Request {
  return new Request('https://pxpipe.example.workers.dev/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'SECRET_PROMPT_MARKER do not exfiltrate' }],
    }),
  });
}

/** Run the worker against a stubbed upstream 400 and return parsed JSONL track rows. */
async function collectTrackRows(env: Record<string, string>): Promise<Record<string, unknown>[]> {
  const logged: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'echoes SECRET_PROMPT_MARKER back' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
  try {
    const res = await worker.fetch(messagesRequest(), env as never, ctx);
    expect(res.status).toBe(400);
    // fire() finalizes async (lazy gzip on 4xx) — give the IIFE time to land.
    for (let i = 0; i < 40; i++) {
      if (logged.some((l) => l.trimStart().startsWith('{'))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    logSpy.mockRestore();
    vi.unstubAllGlobals();
  }
  return logged
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('worker track payload privacy (Workers Logs is off-machine)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('default: 4xx event is metadata-only — no body sample, error_body, or machine env keys', async () => {
    const rows = await collectTrackRows({});
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const k of FORBIDDEN_KEYS) expect(row).not.toHaveProperty(k);
      // Belt and braces: the raw prompt must not appear anywhere in the row.
      expect(JSON.stringify(row)).not.toContain('SECRET_PROMPT_MARKER');
    }
    // Metadata still present so dashboards keep working.
    const evRow = rows.find((r) => r.status === 400);
    expect(evRow).toBeDefined();
    expect(evRow).toHaveProperty('duration_ms');
  });

  it('PXPIPE_TRACK_BODY_SAMPLES=1: operator opt-in restores the body sample', async () => {
    const rows = await collectTrackRows({ PXPIPE_TRACK_BODY_SAMPLES: '1' });
    const withSample = rows.find((r) => typeof r.req_body_sample_b64 === 'string');
    expect(withSample, 'expected a row carrying req_body_sample_b64 after opt-in').toBeDefined();
  });
});
