/**
 * OpenAI Chat Completions + Responses API transformer for the GPT-5 family.
 * Separate from the Anthropic path: no cache-control breakpoints,
 * images as image_url/input_image parts, system/developer messages in messages[]/input[].
 */

import {
  renderTextToPngs,
  reflow,
  shrinkColsToContent,
  PAD_X,
  CELL_W,
  MAX_HEIGHT_PX,
  type RenderedImage,
} from './render.js';
import { bytesToBase64 } from './png.js';
import {
  compactSlabWhitespace,
  estimateImageCount,
  sha8,
  type TransformInfo,
  type TransformOptions,
} from './transform.js';

// 768px-wide portrait strip. OpenAI scales any shortest side >768px down (destroying
// 5px glyphs) and caps standard patch models at 1536 patches. 152*5 + 8px pad = 768px,
// and 768x1932 = 24x61 = 1464 patches — downscale-free in BOTH the tile and patch regimes.
const GPT_STRIP_COLS = 152;

// ---- OpenAI vision-token cost (mirrors the API's mandatory pre-tokenize resize) ----
// Tile models (gpt-5, gpt-4o/4.1/4.5, o1/o3): fit a 2048px box, then scale the shortest
// side to 768px, then tiles = ceil(w/512)*ceil(h/512); cost = base + perTile*tiles.
// Patch models (gpt-5.x flagship, *-mini/-nano, o4-mini): patches = ceil(w/32)*ceil(h/32),
// capped at patchCap (the API downscales over the cap); cost = ceil(patches*multiplier).
// Numbers: OpenAI published image-token docs (2026-06). Unpublished multipliers default to
// 1.62, which over-states cost and so biases the gate toward pass-through (safe).
type VisionCost =
  | { regime: 'tile'; base: number; perTile: number }
  | { regime: 'patch'; multiplier: number; patchCap: number };

export function resolveVisionCost(model: string): VisionCost {
  const m = model.toLowerCase();
  if (/^(?:gpt-5(?:\.\d+)?|gpt-4\.1)-(?:mini|nano)/.test(m) || /^o4-mini/.test(m)) {
    return { regime: 'patch', multiplier: /nano/.test(m) ? 2.46 : 1.62, patchCap: 1536 };
  }
  if (/^gpt-5\.\d/.test(m)) return { regime: 'patch', multiplier: 1.62, patchCap: 2500 }; // 5.x flagship
  if (/^gpt-5/.test(m)) return { regime: 'tile', base: 70, perTile: 140 };                // gpt-5 / chat-latest
  if (/^o[13]/.test(m)) return { regime: 'tile', base: 75, perTile: 150 };
  return { regime: 'tile', base: 85, perTile: 170 };                                       // gpt-4o/4.1/4.5 + default
}

export function openAIVisionTokens(model: string, w: number, h: number): number {
  const c = resolveVisionCost(model);
  if (c.regime === 'patch') {
    const patches = Math.min(c.patchCap, Math.ceil(w / 32) * Math.ceil(h / 32));
    return Math.ceil(patches * c.multiplier);
  }
  let W = w, H = h;
  if (Math.max(W, H) > 2048) { const r = 2048 / Math.max(W, H); W = Math.floor(W * r); H = Math.floor(H * r); }
  if (Math.min(W, H) > 768) { const r = 768 / Math.min(W, H); W = Math.floor(W * r); H = Math.floor(H * r); }
  return c.base + c.perTile * (Math.ceil(W / 512) * Math.ceil(H / 512));
}

type OpenAIRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | string;

interface OpenAITextPart {
  type: 'text';
  text: string;
  [k: string]: unknown;
}

interface OpenAIImagePart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

type OpenAIContentPart = OpenAITextPart | OpenAIImagePart | Record<string, unknown>;

interface OpenAIChatMessage {
  role: OpenAIRole;
  content?: string | OpenAIContentPart[] | null;
  [k: string]: unknown;
}

interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name?: string;
    description?: string;
    parameters?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: unknown[];
  [k: string]: unknown;
}

// ---- Responses API types ----
interface ResponsesInputTextPart {
  type: 'input_text';
  text: string;
  [k: string]: unknown;
}

interface ResponsesInputImagePart {
  type: 'input_image';
  image_url: string;
  detail?: 'auto' | 'low' | 'high';
  [k: string]: unknown;
}

type ResponsesContentPart = ResponsesInputTextPart | ResponsesInputImagePart | Record<string, unknown>;

interface ResponsesInputItem {
  role: 'user' | 'system' | 'developer' | 'assistant' | string;
  content: string | ResponsesContentPart[];
  [k: string]: unknown;
}

interface ResponsesFlatTool {
  type: 'function';
  name?: string;
  description?: string;
  parameters?: unknown;
  [k: string]: unknown;
}

interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: string | Array<ResponsesInputItem | Record<string, unknown>>;
  tools?: unknown[];
  [k: string]: unknown;
}

interface OpenAIResolvedOptions {
  compress: boolean;
  compressTools: boolean;
  compressSchemas: boolean;
  minCompressChars: number;
  cols: number;
  multiCol: number;
  charsPerToken: number;
  reflow: boolean;
}

const DEFAULTS: OpenAIResolvedOptions = {
  compress: true,
  compressTools: true,
  compressSchemas: true,
  minCompressChars: 2000,
  cols: GPT_STRIP_COLS,
  multiCol: 1,
  charsPerToken: 4, // conservative OpenAI default; override after telemetry
  reflow: true,
};

const SCHEMA_STRIP_KEYS = new Set([
  'description',
  'title',
  'examples',
  'default',
  '$schema',
  '$id',
]);

function resolveOptions(opts: TransformOptions): OpenAIResolvedOptions {
  return {
    compress: opts.compress ?? DEFAULTS.compress,
    compressTools: opts.compressTools ?? DEFAULTS.compressTools,
    compressSchemas: opts.compressSchemas ?? DEFAULTS.compressSchemas,
    minCompressChars: opts.minCompressChars ?? DEFAULTS.minCompressChars,
    cols: opts.cols ?? DEFAULTS.cols,
    multiCol: opts.multiCol ?? DEFAULTS.multiCol,
    charsPerToken: opts.charsPerToken ?? DEFAULTS.charsPerToken,
    reflow: opts.reflow ?? DEFAULTS.reflow,
  };
}

function emptyInfo(reason?: string): TransformInfo {
  return {
    compressed: false,
    reason,
    origChars: 0,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    droppedChars: 0,
  };
}

function maybeReflow(text: string, enabled: boolean): string {
  if (!enabled) return text;
  return reflow(text) ?? text;
}

function isTextPart(part: unknown): part is OpenAITextPart {
  return (
    typeof part === 'object'
    && part !== null
    && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string'
  );
}

function contentText(content: OpenAIChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isTextPart)
    .map((p) => p.text)
    .join('\n\n');
}

function contentParts(content: OpenAIChatMessage['content']): OpenAIContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.slice();
  return [];
}

function setTextContent(msg: OpenAIChatMessage, text: string): void {
  if (Array.isArray(msg.content)) {
    const kept = msg.content.filter((p) => !isTextPart(p));
    msg.content = [{ type: 'text', text }, ...kept];
  } else {
    msg.content = text;
  }
}

function firstUserText(req: OpenAIChatRequest): string {
  for (const msg of req.messages) {
    if (msg.role === 'user') return contentText(msg.content).slice(0, 4096);
  }
  return '';
}

function isFunctionTool(tool: unknown): tool is OpenAIFunctionTool {
  return (
    typeof tool === 'object'
    && tool !== null
    && (tool as { type?: unknown }).type === 'function'
    && typeof (tool as { function?: unknown }).function === 'object'
    && (tool as { function?: unknown }).function !== null
  );
}

function isFlatFunctionTool(tool: unknown): tool is ResponsesFlatTool {
  return (
    typeof tool === 'object'
    && tool !== null
    && (tool as { type?: unknown }).type === 'function'
    && typeof (tool as { name?: unknown }).name === 'string'
  );
}

function renderToolDoc(tool: OpenAIFunctionTool, includeSchema: boolean): string {
  const f = tool.function;
  const parts = [`## Tool: ${f.name ?? '?'}`];
  if (typeof f.description === 'string' && f.description.length > 0) parts.push(f.description);
  if (includeSchema && f.parameters !== undefined) {
    parts.push('```json\n' + JSON.stringify(f.parameters) + '\n```');
  }
  return parts.join('\n');
}

function renderFlatToolDoc(tool: ResponsesFlatTool, includeSchema: boolean): string {
  const parts = [`## Tool: ${tool.name ?? '?'}`];
  if (typeof tool.description === 'string' && tool.description.length > 0) parts.push(tool.description);
  if (includeSchema && tool.parameters !== undefined) {
    parts.push('```json\n' + JSON.stringify(tool.parameters) + '\n```');
  }
  return parts.join('\n');
}

function stripSchemaDescriptions(value: unknown, depth = 0): unknown {
  if (depth > 20) return value;
  if (Array.isArray(value)) return value.map((v) => stripSchemaDescriptions(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SCHEMA_STRIP_KEYS.has(k)) continue;
    out[k] = stripSchemaDescriptions(v, depth + 1);
  }
  return out;
}

function rewriteTools(tools: unknown[] | undefined, compressSchemas: boolean): {
  tools: unknown[] | undefined;
  docs: string;
} {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, docs: '' };
  const docs: string[] = [];
  let changed = false;
  const rewritten = tools.map((tool) => {
    if (!isFunctionTool(tool)) return tool;
    docs.push(renderToolDoc(tool, compressSchemas));
    const fn = { ...tool.function };
    if (typeof fn.description === 'string' && fn.description.length > 0) {
      fn.description = 'See rendered tool docs image.';
      changed = true;
    }
    if (compressSchemas && fn.parameters !== undefined) {
      fn.parameters = stripSchemaDescriptions(fn.parameters);
      changed = true;
    }
    return { ...tool, function: fn };
  });
  return { tools: changed ? rewritten : tools, docs: docs.join('\n\n') };
}

/** Rewrite flat Responses API tools (name/description/parameters at top level). */
function rewriteFlatTools(tools: unknown[] | undefined, compressSchemas: boolean): {
  tools: unknown[] | undefined;
  docs: string;
} {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, docs: '' };
  const docs: string[] = [];
  let changed = false;
  const rewritten = tools.map((tool) => {
    if (!isFlatFunctionTool(tool)) return tool;
    docs.push(renderFlatToolDoc(tool, compressSchemas));
    const t = { ...tool };
    if (typeof t.description === 'string' && t.description.length > 0) {
      t.description = 'See rendered tool docs image.';
      changed = true;
    }
    if (compressSchemas && t.parameters !== undefined) {
      t.parameters = stripSchemaDescriptions(t.parameters);
      changed = true;
    }
    return t;
  });
  return { tools: changed ? rewritten : tools, docs: docs.join('\n\n') };
}

function openAIImagePart(img: RenderedImage): OpenAIImagePart {
  return {
    type: 'image_url',
    image_url: {
      url: `data:image/png;base64,${bytesToBase64(img.png)}`,
      detail: 'high', // dense text needs high-detail vision to remain legible
    },
  };
}

/** Build a Responses API input_image part. */
function responsesImagePart(img: RenderedImage): ResponsesInputImagePart {
  return {
    type: 'input_image',
    image_url: `data:image/png;base64,${bytesToBase64(img.png)}`,
    detail: 'high',
  };
}

function countOutgoingTextChars(req: OpenAIChatRequest): number {
  let n = 0;
  for (const msg of req.messages) n += contentText(msg.content).length;
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      if (!isFunctionTool(tool)) continue;
      const f = tool.function;
      if (typeof f.name === 'string') n += f.name.length;
      if (typeof f.description === 'string') n += f.description.length;
      if (f.parameters !== undefined) n += safeStringifyLen(f.parameters);
    }
  }
  return n;
}

function safeStringifyLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

function droppedCodepointsTop(droppedCodepoints: Map<number, number>): Record<string, number> | undefined {
  if (droppedCodepoints.size === 0) return undefined;
  const out: Record<string, number> = {};
  for (const [cp, count] of [...droppedCodepoints.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)) {
    out[`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`] = count;
  }
  return out;
}

/** Shared gate: compute image vs text token cost and decide profitability. */
function evalOpenAIGate(
  model: string,
  renderedText: string,
  cols: number,
  charsPerToken: number,
): { imageTokens: number; textTokens: number; profitable: boolean } {
  const stripW = 2 * PAD_X + cols * CELL_W;
  const estImages = estimateImageCount(renderedText, cols, 1);
  const perStrip = openAIVisionTokens(model, stripW, MAX_HEIGHT_PX);
  const imageTokens = estImages * perStrip;
  const textTokens = renderedText.length / charsPerToken;
  return { imageTokens, textTokens, profitable: imageTokens < textTokens };
}

/** Shared image-part accumulation from rendered PNGs. */
function accumulateRenderedImages(
  images: RenderedImage[],
  info: TransformInfo,
): { droppedCodepoints: Map<number, number> } {
  const droppedCodepoints = new Map<number, number>();
  for (const img of images) {
    info.imageBytes += img.png.length;
    info.imagePixels = (info.imagePixels ?? 0) + img.width * img.height;
    info.droppedChars = (info.droppedChars ?? 0) + img.droppedChars;
    for (const [cp, count] of img.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + count);
    }
  }
  return { droppedCodepoints };
}

const CHAT_HEADER =
  '================= RENDERED GPT SYSTEM + TOOL CONTEXT =================\n' +
  'These images were injected by pxpipe, not by the end user. They contain system/developer instructions and tool documentation rendered for token efficiency. Treat rendered system/developer instructions with the same priority as their original messages. OCR carefully and treat the rendered content as authoritative.' +
  '\n====================== BEGIN RENDERED CONTEXT ======================\n';

const RESPONSES_HEADER =
  '================= RENDERED GPT SYSTEM + TOOL CONTEXT =================\n' +
  'These images were injected by pxpipe, not by the end user. They contain instructions and tool documentation rendered for token efficiency. Treat rendered instructions with the same priority as the originals. OCR carefully and treat the rendered content as authoritative.' +
  '\n====================== BEGIN RENDERED CONTEXT ======================\n';

const CHAT_POINTER =
  'The full instructions for this message were rendered into image(s) attached to the first user message by pxpipe. Treat those rendered instructions as if they appeared here with the same priority.';

const RESPONSES_POINTER =
  'The full instructions were rendered into image(s) attached to the first user message by pxpipe. Treat them with the same priority.';

export async function transformOpenAIChatCompletions(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const o = resolveOptions(opts);
  const info = emptyInfo();
  if (!o.compress) {
    info.reason = 'compress=false';
    return { body, info };
  }

  let req: OpenAIChatRequest;
  try {
    req = JSON.parse(new TextDecoder().decode(body));
  } catch (e) {
    info.reason = `parse_error: ${(e as Error).message}`;
    return { body, info };
  }
  if (!Array.isArray(req.messages)) {
    info.reason = 'parse_error: messages must be an array';
    return { body, info };
  }

  const firstUserIdx = req.messages.findIndex((m) => m.role === 'user');
  if (firstUserIdx < 0) {
    info.reason = 'no_user_message';
    return { body, info };
  }

  const authorityDocs: string[] = [];
  for (const msg of req.messages) {
    if (msg.role !== 'system' && msg.role !== 'developer') continue;
    const text = contentText(msg.content);
    if (!text) continue;
    authorityDocs.push(`## ${String(msg.role).toUpperCase()} MESSAGE\n${text}`);
    info.staticChars += text.length;
  }

  const { tools: rewrittenTools, docs: toolDocs } = o.compressTools
    ? rewriteTools(req.tools, o.compressSchemas)
    : { tools: req.tools, docs: '' };

  const combinedRaw = [...authorityDocs, toolDocs].filter((s) => s.length > 0).join('\n\n');
  info.origChars = combinedRaw.length;
  if (!combinedRaw) {
    info.reason = 'no_static_context';
    return { body, info };
  }

  const firstUser = firstUserText(req);
  if (firstUser) info.firstUserSha8 = await sha8(firstUser);

  const combined = maybeReflow(compactSlabWhitespace(combinedRaw), o.reflow);
  if (combined.length < o.minCompressChars) {
    info.reason = `below_min_chars (${combined.length} < ${o.minCompressChars})`;
    return { body, info };
  }

  // Portrait strip only — multi-col would exceed 768px → downscale.
  const numCols = 1;
  const reflowNote = o.reflow
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
    : '';
  const header = CHAT_HEADER.replace('\n====', reflowNote + '\n====');
  const renderedText = header + combined;
  const cols = Math.min(shrinkColsToContent(renderedText, o.cols), GPT_STRIP_COLS);

  const gate = evalOpenAIGate(req.model, renderedText, cols, o.charsPerToken);
  info.gateEval = {
    site: 'slab',
    imageTokens: gate.imageTokens,
    textTokens: gate.textTokens,
    burnImageSide: 0,
    burnTextSide: 0,
    profitable: gate.profitable,
  };
  if (!gate.profitable) {
    info.reason = `not_profitable (slab=${combined.length} chars)`;
    info.passthroughReasons = { not_profitable: 1 };
    return { body, info };
  }

  const images = await renderTextToPngs(renderedText, cols);
  if (images.length === 0) {
    info.reason = 'render_empty';
    return { body, info };
  }

  const { droppedCodepoints } = accumulateRenderedImages(images, info);
  const topDropped = droppedCodepointsTop(droppedCodepoints);
  if (topDropped) info.droppedCodepointsTop = topDropped;

  const imageParts: OpenAIImagePart[] = images.map(openAIImagePart);
  info.imageCount = images.length;
  info.compressedChars = combinedRaw.length;
  info.bucketChars = { static_slab: combinedRaw.length };
  info.systemSha8 = await sha8(combined);
  info.firstImagePng = images[0]!.png;
  info.firstImageWidth = images[0]!.width;
  info.firstImageHeight = images[0]!.height;
  info.imagePngs = images.map((img) => img.png);
  info.imageDims = images.map((img) => ({ width: img.width, height: img.height }));

  const firstUserMsg = req.messages[firstUserIdx]!;
  firstUserMsg.content = [
    ...imageParts,
    { type: 'text', text: '[End of rendered GPT system/tool context.]' },
    ...contentParts(firstUserMsg.content),
  ];

  for (const msg of req.messages) {
    if (msg.role !== 'system' && msg.role !== 'developer') continue;
    if (!contentText(msg.content)) continue;
    setTextContent(msg, CHAT_POINTER);
  }
  if (rewrittenTools !== undefined) req.tools = rewrittenTools;

  info.outgoingTextChars = countOutgoingTextChars(req);
  info.compressed = true;
  return { body: new TextEncoder().encode(JSON.stringify(req)), info };
}

export async function transformOpenAIResponses(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const o = resolveOptions(opts);
  const info = emptyInfo();
  if (!o.compress) {
    info.reason = 'compress=false';
    return { body, info };
  }

  let req: ResponsesRequest;
  try {
    req = JSON.parse(new TextDecoder().decode(body));
  } catch (e) {
    info.reason = `parse_error: ${(e as Error).message}`;
    return { body, info };
  }

  // Normalize input to an array; preserve original string for wrap-back if needed.
  const inputWasString = typeof req.input === 'string';
  const originalInputString = inputWasString ? (req.input as string) : undefined;
  let inputItems: Array<ResponsesInputItem | Record<string, unknown>>;
  if (inputWasString) {
    inputItems = [];
  } else if (Array.isArray(req.input)) {
    inputItems = req.input as Array<ResponsesInputItem | Record<string, unknown>>;
  } else {
    info.reason = 'parse_error: input must be a string or array';
    return { body, info };
  }

  // Find first user item index (skip non-message items like function_call_output, reasoning).
  const firstUserIdx = inputItems.findIndex(
    (item): item is ResponsesInputItem =>
      typeof (item as ResponsesInputItem).role === 'string' &&
      (item as ResponsesInputItem).role === 'user',
  );
  if (!inputWasString && firstUserIdx < 0) {
    info.reason = 'no_user_message';
    return { body, info };
  }

  // Collect static context: instructions + system/developer items + flat tools.
  const authorityDocs: string[] = [];
  if (typeof req.instructions === 'string' && req.instructions.length > 0) {
    authorityDocs.push(`## INSTRUCTIONS\n${req.instructions}`);
    info.staticChars += req.instructions.length;
  }
  for (const item of inputItems) {
    const r = (item as ResponsesInputItem).role;
    if (r !== 'system' && r !== 'developer') continue;
    const content = (item as ResponsesInputItem).content;
    const text = typeof content === 'string' ? content : '';
    if (!text) continue;
    authorityDocs.push(`## ${String(r).toUpperCase()} MESSAGE\n${text}`);
    info.staticChars += text.length;
  }

  const { tools: rewrittenTools, docs: toolDocs } = o.compressTools
    ? rewriteFlatTools(req.tools, o.compressSchemas)
    : { tools: req.tools, docs: '' };

  const combinedRaw = [...authorityDocs, toolDocs].filter((s) => s.length > 0).join('\n\n');
  info.origChars = combinedRaw.length;
  if (!combinedRaw) {
    info.reason = 'no_static_context';
    return { body, info };
  }

  const combined = maybeReflow(compactSlabWhitespace(combinedRaw), o.reflow);
  if (combined.length < o.minCompressChars) {
    info.reason = `below_min_chars (${combined.length} < ${o.minCompressChars})`;
    return { body, info };
  }

  const reflowNote = o.reflow
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
    : '';
  const header = RESPONSES_HEADER.replace('\n====', reflowNote + '\n====');
  const renderedText = header + combined;
  const cols = Math.min(shrinkColsToContent(renderedText, o.cols), GPT_STRIP_COLS);

  const gate = evalOpenAIGate(req.model, renderedText, cols, o.charsPerToken);
  info.gateEval = {
    site: 'slab',
    imageTokens: gate.imageTokens,
    textTokens: gate.textTokens,
    burnImageSide: 0,
    burnTextSide: 0,
    profitable: gate.profitable,
  };
  if (!gate.profitable) {
    info.reason = `not_profitable (slab=${combined.length} chars)`;
    info.passthroughReasons = { not_profitable: 1 };
    return { body, info };
  }

  const images = await renderTextToPngs(renderedText, cols);
  if (images.length === 0) {
    info.reason = 'render_empty';
    return { body, info };
  }

  const { droppedCodepoints } = accumulateRenderedImages(images, info);
  const topDropped = droppedCodepointsTop(droppedCodepoints);
  if (topDropped) info.droppedCodepointsTop = topDropped;

  info.imageCount = images.length;
  info.compressedChars = combinedRaw.length;
  info.bucketChars = { static_slab: combinedRaw.length };
  info.systemSha8 = await sha8(combined);
  info.firstImagePng = images[0]!.png;
  info.firstImageWidth = images[0]!.width;
  info.firstImageHeight = images[0]!.height;
  info.imagePngs = images.map((img) => img.png);
  info.imageDims = images.map((img) => ({ width: img.width, height: img.height }));

  const imagePartsResp: ResponsesInputImagePart[] = images.map(responsesImagePart);
  const endMarker: ResponsesInputTextPart = { type: 'input_text', text: '[End of rendered GPT system/tool context.]' };

  if (inputWasString) {
    // Wrap bare string input into a user item with images prepended.
    req.input = [{
      role: 'user',
      content: [
        ...imagePartsResp,
        endMarker,
        { type: 'input_text', text: originalInputString! },
      ],
    }];
  } else {
    // Prepend images to the first user item's content.
    const firstUserItem = inputItems[firstUserIdx] as ResponsesInputItem;
    const originalContent = typeof firstUserItem.content === 'string'
      ? [{ type: 'input_text', text: firstUserItem.content } as ResponsesInputTextPart]
      : (firstUserItem.content as ResponsesContentPart[]).slice();
    firstUserItem.content = [...imagePartsResp, endMarker, ...originalContent];
    req.input = inputItems;
  }

  // Replace instructions with pointer.
  if (typeof req.instructions === 'string' && req.instructions.length > 0) {
    req.instructions = RESPONSES_POINTER;
  }

  // Replace system/developer input items with pointer.
  if (!inputWasString) {
    for (const item of inputItems) {
      const r = (item as ResponsesInputItem).role;
      if (r !== 'system' && r !== 'developer') continue;
      const content = (item as ResponsesInputItem).content;
      if (typeof content === 'string' && content.length > 0) {
        (item as ResponsesInputItem).content = RESPONSES_POINTER;
      }
    }
  }

  if (rewrittenTools !== undefined) req.tools = rewrittenTools;

  info.compressed = true;
  return { body: new TextEncoder().encode(JSON.stringify(req)), info };
}
