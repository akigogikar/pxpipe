/**
 * Tests for GPT-5 applicability gate, OpenAI vision-token cost model,
 * Chat Completions transformer, and Responses API transformer.
 */
import { describe, expect, it } from 'vitest';
import { isPxpipeSupportedGptModel } from '../src/core/applicability.js';
import { openAIVisionTokens, resolveVisionCost, transformOpenAIChatCompletions, transformOpenAIResponses } from '../src/core/openai.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Task 1: applicability gate ──────────────────────────────────────────────

describe('isPxpipeSupportedGptModel', () => {
  it('matches the whole GPT-5 family', () => {
    expect(isPxpipeSupportedGptModel('gpt-5')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.5')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5-mini')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6-nano')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6[1m]')).toBe(true); // variant tag stripped
  });

  it('rejects non-GPT-5 models', () => {
    expect(isPxpipeSupportedGptModel('gpt-4o')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-50')).toBe(false);
    expect(isPxpipeSupportedGptModel('')).toBe(false);
    expect(isPxpipeSupportedGptModel(null)).toBe(false);
    expect(isPxpipeSupportedGptModel(undefined)).toBe(false);
  });
});

// ── Task 2: OpenAI vision-token cost ────────────────────────────────────────

describe('openAIVisionTokens', () => {
  it('gpt-5 at 768x1932 → 70 + 140*8 = 1190 (tile: 2×4 tiles)', () => {
    // 768x1932 with gpt-5 (tile): fits 2048 box (no resize needed); min(768,1932)=768≤768 (no resize);
    // tiles = ceil(768/512)*ceil(1932/512) = 2*4 = 8; cost = 70 + 140*8 = 1190.
    expect(openAIVisionTokens('gpt-5', 768, 1932)).toBe(1190);
  });

  it('gpt-4o at 768x1932 → 85 + 170*8 = 1445', () => {
    expect(openAIVisionTokens('gpt-4o', 768, 1932)).toBe(1445);
  });

  it('gpt-5-mini at 768x1932 → ceil(1464 * 1.62) = 2372', () => {
    // patch model: patches = ceil(768/32)*ceil(1932/32) = 24*61 = 1464; capped at 1536; 1464 < 1536.
    // cost = ceil(1464 * 1.62) = ceil(2371.68) = 2372.
    expect(openAIVisionTokens('gpt-5-mini', 768, 1932)).toBe(2372);
  });

  it('gpt-5 at 2048x2048 → collapses to 768x768 → 4 tiles → 630', () => {
    // 2048x2048: fits 2048 box exactly; min(2048,2048)=2048 > 768 → scale by 768/2048=0.375
    // W=floor(2048*0.375)=768, H=floor(2048*0.375)=768; tiles=ceil(768/512)*ceil(768/512)=2*2=4
    // cost = 70 + 140*4 = 630.
    expect(openAIVisionTokens('gpt-5', 2048, 2048)).toBe(630);
  });

  it('resolveVisionCost returns correct regimes', () => {
    expect(resolveVisionCost('gpt-5').regime).toBe('tile');
    expect(resolveVisionCost('gpt-5.6').regime).toBe('patch');
    expect(resolveVisionCost('gpt-5-mini').regime).toBe('patch');
    expect(resolveVisionCost('gpt-5.6-nano').regime).toBe('patch');
    expect(resolveVisionCost('gpt-4o').regime).toBe('tile');
    expect(resolveVisionCost('o1').regime).toBe('tile');
  });
});

// ── Task 2c + 3: Chat Completions transformer ────────────────────────────────

const BIG_SYSTEM = 'System instruction with lots of detail. '.repeat(500); // ~20k chars
const BIG_TOOL_DESC = 'Tool description with lots of context. '.repeat(200); // ~8k chars

describe('transformOpenAIChatCompletions (gpt-5.6)', () => {
  it('compresses big system + tools, injects images, replaces static text', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      messages: [
        { role: 'system', content: BIG_SYSTEM },
        { role: 'user', content: 'hello' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'do_thing',
          description: BIG_TOOL_DESC,
          parameters: { type: 'object', description: 'Param root.', properties: { x: { type: 'string', description: 'x param' } } },
        },
      }],
    }));

    const result = await transformOpenAIChatCompletions(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);

    const out = JSON.parse(dec.decode(result.body)) as Record<string, unknown>;
    const messages = out.messages as Array<{ role: string; content: unknown }>;
    const firstUser = messages.find((m) => m.role === 'user')!;
    expect(Array.isArray(firstUser.content)).toBe(true);
    const parts = firstUser.content as Array<{ type: string; image_url?: { url: string } }>;
    // First part is an image.
    expect(parts[0]!.type).toBe('image_url');
    expect(parts[0]!.image_url!.url).toMatch(/^data:image\/png;base64,/);

    // Image width should be 768px (152 cols * 5px + 8px pad).
    expect(result.info.firstImageWidth).toBe(768);

    // System message replaced with pointer.
    const sysMsg = messages.find((m) => m.role === 'system')!;
    expect(typeof sysMsg.content === 'string'
      ? sysMsg.content
      : (sysMsg.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('rendered into image');

    // Tool description replaced.
    const tools = out.tools as Array<{ function: { description?: string } }>;
    expect(tools[0]!.function.description).toBe('See rendered tool docs image.');
    // Schema descriptions stripped.
    const params = tools[0]!.function as { parameters?: { description?: string; properties?: { x?: { description?: string } } } };
    expect((params.parameters as { description?: string } | undefined)?.description).toBeUndefined();
  });

  it('returns compressed=false with not_profitable reason for small input', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      messages: [
        { role: 'system', content: 'short' },
        { role: 'user', content: 'hi' },
      ],
    }));
    // Default minCompressChars=2000, so 'short' is below threshold.
    const result = await transformOpenAIChatCompletions(body);
    expect(result.info.compressed).toBe(false);
    expect(result.info.reason).toMatch(/below_min_chars|not_profitable/);
  });
});

// ── Task 3: Responses API transformer ───────────────────────────────────────

const BIG_INSTRUCTIONS = 'These are detailed instructions. '.repeat(600); // ~20k chars
const BIG_FLAT_TOOL_DESC = 'Flat tool description with lots of context. '.repeat(200); // ~8k chars

describe('transformOpenAIResponses (gpt-5.6)', () => {
  it('compresses instructions + flat tools, injects input_image parts into first user item', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: BIG_INSTRUCTIONS,
      input: [
        { role: 'user', content: 'Please do the thing.' },
      ],
      tools: [{
        type: 'function',
        name: 'do_thing',
        description: BIG_FLAT_TOOL_DESC,
        parameters: { type: 'object', description: 'Param root.', properties: { x: { type: 'string', description: 'x param' } } },
      }],
    }));

    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);

    const out = JSON.parse(dec.decode(result.body)) as Record<string, unknown>;
    // instructions replaced with pointer.
    expect(out.instructions as string).toContain('rendered into image');
    expect(out.instructions as string).not.toContain('These are detailed');

    // First user item gains input_image parts.
    const inputItems = out.input as Array<{ role: string; content: unknown }>;
    const firstUser = inputItems.find((i) => i.role === 'user')!;
    expect(Array.isArray(firstUser.content)).toBe(true);
    const parts = firstUser.content as Array<{ type: string; image_url?: string }>;
    expect(parts[0]!.type).toBe('input_image');
    expect(parts[0]!.image_url).toMatch(/^data:image\/png;base64,/);

    // Flat tool description replaced.
    const tools = out.tools as Array<{ description?: string; parameters?: { description?: string } }>;
    expect(tools[0]!.description).toBe('See rendered tool docs image.');
    expect((tools[0]!.parameters as { description?: string } | undefined)?.description).toBeUndefined();
  });

  it('handles bare string input (wraps into user item with images)', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: BIG_INSTRUCTIONS,
      input: 'Do the thing please.',
    }));

    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);

    const out = JSON.parse(dec.decode(result.body)) as Record<string, unknown>;
    // input should now be an array.
    expect(Array.isArray(out.input)).toBe(true);
    const inputItems = out.input as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    expect(inputItems[0]!.role).toBe('user');
    const parts = inputItems[0]!.content;
    expect(parts[0]!.type).toBe('input_image');
    // Original string preserved as input_text part.
    const textParts = parts.filter((p) => p.type === 'input_text');
    expect(textParts.some((p) => p.text?.includes('Do the thing'))).toBe(true);
  });

  it('returns compressed=false with not_profitable/below_min reason for small input', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: 'Short.',
      input: [{ role: 'user', content: 'hi' }],
    }));
    const result = await transformOpenAIResponses(body);
    expect(result.info.compressed).toBe(false);
    expect(result.info.reason).toMatch(/below_min_chars|not_profitable/);
  });
});
