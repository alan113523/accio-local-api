import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { generate, mimeOf } from './codex.mjs';
import { generateAccio } from './accio.mjs';

const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value });

export class ImageJobs {
  constructor(settings, run) { this.settings = settings; this.run = run; this.active = new Map(); }
  jobPath(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Use the job_id returned by image_generate or image_edit');
    return join(this.settings.stateDir, `${id}.json`);
  }
  async save(job) { await writeFile(this.jobPath(job.job_id), JSON.stringify(job, null, 2)); }
  async submit(name, args) {
    if (this.active.size) throw new Error('An image job is already running in this connection; use image_status before submitting another');
    const backend = args.backend ?? this.settings.backend ?? 'codex';
    if (!['codex', 'accio'].includes(backend)) throw new Error('backend must be codex or accio');
    if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 30000) throw new Error('prompt must contain 1–30000 characters');
    const references = args.reference_images ?? [];
    if (!Array.isArray(references) || references.length > 8 || references.some(p => typeof p !== 'string' || !isAbsolute(p))) throw new Error('reference_images must contain at most 8 absolute local paths');
    if (name === 'image_edit' && !references.length) throw new Error('image_edit requires reference_images');
    if (args.output_dir != null && (typeof args.output_dir !== 'string' || !isAbsolute(args.output_dir))) throw new Error('output_dir must be an absolute directory path');
    await mkdir(this.settings.stateDir, { recursive: true });
    const job = { job_id: randomUUID(), backend, status: 'running', phase: 'starting', created_at: new Date().toISOString(), owner_pid: process.pid };
    const outDir = args.output_dir || join(this.settings.outputDir, job.job_id);
    await mkdir(outDir, { recursive: true });
    await this.save(job);
    const run = this.run || (backend === 'accio' ? generateAccio : generate);
    const pending = run({ finalPrompt: args.prompt, referenceImages: references, outDir, backendSettings: this.settings,
      codexBin: this.settings.codexBin, codexArgs: this.settings.codexArgs || [], disabledMcp: this.settings.disabledMcp || [],
      timeoutSeconds: this.settings.timeoutSeconds || 600,
      progress: phase => { job.phase = phase; },
    }).then(async result => {
      if (!result.images?.length) throw new Error(`${backend} finished without producing an image file`);
      if (result.failures?.length) throw new Error(result.failures.join('; '));
      job.status = 'completed'; job.images = result.images; job.prompt = args.prompt;
      job.reference_images = references; job.completed_at = new Date().toISOString();
      await this.save(job);
    }).catch(async error => {
      job.status = 'failed'; job.error = error.message; job.completed_at = new Date().toISOString();
      await this.save(job);
    }).finally(() => this.active.delete(job.job_id));
    this.active.set(job.job_id, { job, pending });
    return textResult({ job_id: job.job_id, backend, status: 'running', next: 'Call image_status with this job_id. Generation can take several minutes; wait about 20 seconds between status checks.' });
  }
  async status(args) {
    const job = this.active.get(args.job_id)?.job || JSON.parse(await readFile(this.jobPath(args.job_id), 'utf8'));
    if (job.status === 'running' && !this.active.has(job.job_id)) {
      try { process.kill(job.owner_pid, 0); } catch { job.status = 'failed'; job.error = 'The image worker exited before reporting completion; submit a new job.'; }
    }
    const result = textResult(job);
    if (job.status === 'completed' && args.include_image !== false) {
      for (const img of job.images) {
        if (img.size <= 4 * 1024 * 1024) result.content.push({ type: 'image', data: (await readFile(img.path)).toString('base64'), mimeType: mimeOf(img.path) });
      }
    }
    if (job.status === 'failed') result.isError = true;
    return result;
  }
  async call(name, args) {
    try {
      if (name === 'image_generate' || name === 'image_edit') {
        if (this.submitting) throw new Error('An image job is already being submitted; use image_status before submitting another');
        this.submitting = true;
        try { return await this.submit(name, args); } finally { this.submitting = false; }
      }
      if (name === 'image_status') return await this.status(args);
      throw new Error('Unknown tool');
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  }
}

export function disabledMcpServers(configPath) {
  try { return [...readFileSync(configPath, 'utf8').matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]$/gm)].map(m => m[1]); }
  catch { return []; }
}

const imageProperties = {
  backend: { type: 'string', enum: ['codex', 'accio'], description: 'Optional backend override. Accio uses the local Accio API and Accio credits; Codex uses the installed Codex CLI and Codex quota. Default comes from bridge.json.' },
  prompt: { type: 'string', description: 'Exact image request: subject, composition, text, and constraints. For edits, state what changes and what stays unchanged.' },
  reference_images: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Absolute local paths of reference images or edit targets.' },
  output_dir: { type: 'string', description: 'Optional absolute directory for the result; the default is managed by the bridge.' },
};
export const TOOLS = [
  { name: 'image_generate', description: 'Generate an image using the configured backend (codex or accio). Accio-only users can choose backend=accio without installing Codex. Returns a job_id immediately; use image_status to retrieve the actual image. Uses the selected backend account credits. Do not claim success until image_status says completed.',
    inputSchema: { type: 'object', properties: imageProperties, required: ['prompt'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'image_edit', description: 'Edit or create an image from local reference images using the configured Codex or Accio backend. Requires reference_images; returns a job_id. Use image_status to obtain the result. Accio reference files must total at most 5 MiB.',
    inputSchema: { type: 'object', properties: imageProperties, required: ['prompt', 'reference_images'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'image_status', description: 'Read an image job and its selected backend. A completed job includes absolute file paths and, for images up to 4 MiB, actual inline image content. While running, wait about 20 seconds before checking again. A failed job is not a successful image.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, include_image: { type: 'boolean', default: true } }, required: ['job_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];
