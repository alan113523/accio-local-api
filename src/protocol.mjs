import { randomUUID } from 'node:crypto';
import { ApiError } from './auth.mjs';
import { imagePart } from './images.mjs';

const fail = message => { throw new ApiError(400, 'unsupported_request', message); };
function text(value, label) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return fail(`${label} must contain text`);
  return value.map(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return fail('This release supports text and client function tools only');
    return block.text;
  }).join('\n');
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function toolId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) fail('Invalid tool call ID');
  return value;
}
function toolName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) fail('Invalid tool name');
  return value;
}
function jsonArguments(value) {
  if (typeof value !== 'string') fail('Tool arguments must be a JSON string');
  try { return JSON.stringify(object(JSON.parse(value), 'Tool arguments')); }
  catch { fail('Tool arguments must be a JSON object'); }
}
function toolResponse(value) {
  if (typeof value !== 'string') return JSON.stringify({ result: text(value, 'tool result') });
  try { return JSON.stringify(JSON.parse(value)); }
  catch { return JSON.stringify({ result: value }); }
}

function messageParts(value, protocol, label) {
  if (value == null) return [];
  if (typeof value === 'string') return value ? [{ text: value, thought: false }] : [];
  if (!Array.isArray(value)) fail(`${label} must contain text or images`);
  return value.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return { text: block.text, thought: false };
    const image = imagePart(block, protocol);
    if (image) return image;
    return fail('Supported message content blocks are text and images');
  });
}

function toolResultParts(id, name, value, protocol) {
  if (!Array.isArray(value)) return [{ function_response: { id, name, response_json: toolResponse(value) } }];
  const content = messageParts(value, protocol, 'tool result');
  const response = { result: content.filter(part => 'text' in part).map(part => part.text).join('\n') };
  return [{ function_response: { id, name, response_json: JSON.stringify(response) } },
    ...content.filter(part => !('text' in part))];
}

export function convertRequest(body, protocol, model) {
  object(body, 'request');
  const allowed = new Set(['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop',
    'stop_sequences', 'system', 'reasoning_effort', 'output_config', 'tools', 'tool_choice', 'stream_options', 'n', 'store',
    'metadata', 'user', 'parallel_tool_calls', 'thinking', 'context_management']);
  if (Object.keys(body).some(key => !allowed.has(key))) fail('Request contains an unsupported parameter');
  if (body.output_config && Object.keys(body.output_config).some(key => key !== 'effort')) fail('Only output_config.effort is supported');
  if (body.max_tokens != null && body.max_completion_tokens != null) fail('Use either max_tokens or max_completion_tokens');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 10000) fail('messages must be a nonempty array with at most 10000 items');
  if (body.stream != null && typeof body.stream !== 'boolean') fail('stream must be a boolean');
  if (body.n != null && body.n !== 1) fail('Only n=1 is supported');
  if (body.store === true || body.logprobs || body.response_format || body.seed != null) fail('Storage, logprobs, seeded sampling, and response_format are not supported');
  if (body.parallel_tool_calls === false) fail('Serial tool choice is not supported by this Accio transport');
  if (body.context_management != null) {
    const context = object(body.context_management, 'context_management');
    if (protocol !== 'anthropic' || Object.keys(context).some(key => key !== 'edits') || !Array.isArray(context.edits) ||
      context.edits.some(edit => !edit || Object.keys(edit).some(key => !['type', 'keep'].includes(key)) ||
        edit.type !== 'clear_thinking_20251015' || edit.keep !== 'all')) {
      fail('Only the no-op context_management clear_thinking with keep=all is supported');
    }
  }
  if (body.thinking != null) {
    const thinking = object(body.thinking, 'thinking');
    const adaptive = protocol === 'anthropic' && thinking.type === 'adaptive';
    const hiddenDisplay = adaptive && ['omitted', 'updates'].includes(thinking.display);
    if (Object.keys(thinking).some(key => key !== 'type' && !(key === 'display' && hiddenDisplay)) || (thinking.type !== 'disabled' && !adaptive)) {
      fail('Use Anthropic adaptive thinking or reasoning_effort; thinking token budgets and signed thinking blocks are not supported');
    }
  }
  const max = body.max_completion_tokens ?? body.max_tokens ?? 4096;
  if (!Number.isSafeInteger(max) || max < 1 || max > 131072) fail('max_tokens must be an integer between 1 and 131072');
  const effort = body.reasoning_effort ?? body.output_config?.effort ?? model.defaultReasoningEffort;
  if (effort && model.reasoningEfforts?.length && !model.reasoningEfforts.includes(effort)) fail('reasoning_effort is not supported by this model');
  const request = { model: model.modelCode, select_model_name: model.modelDisplayName,
    max_output_tokens: max, include_thoughts: false, ...(effort ? { reasoning_effort: effort } : {}), contents: [] };
  for (const [source, target, maxValue] of [['temperature', 'temperature', 2], ['top_p', 'top_p', 1]]) {
    if (body[source] != null) {
      if (typeof body[source] !== 'number' || !Number.isFinite(body[source]) || body[source] < 0 || body[source] > maxValue) fail(`Invalid ${source}`);
      request[target] = body[source];
    }
  }
  const stop = body.stop_sequences ?? body.stop;
  if (stop != null) {
    const list = typeof stop === 'string' ? [stop] : stop;
    if (!Array.isArray(list) || list.length > 16 || list.some(s => typeof s !== 'string')) fail('stop must contain at most 16 strings');
    request.stop_sequences = list;
  }
  const systems = [];
  if (protocol === 'anthropic' && body.system != null) systems.push(text(body.system, 'system'));
  const names = new Map();
  for (const message of body.messages) {
    object(message, 'message');
    if (message.role === 'system' || (message.role === 'developer' && protocol === 'openai')) {
      systems.push(text(message.content, message.role)); continue;
    }
    const parts = [];
    if (protocol === 'openai') {
      if (!['user', 'assistant', 'tool'].includes(message.role)) fail('Unsupported message role');
      if (message.role === 'tool') {
        const id = toolId(message.tool_call_id), name = names.get(id);
        if (!name) fail('Tool result must match an earlier assistant tool call');
        parts.push(...toolResultParts(id, name, message.content, protocol));
      } else {
        parts.push(...messageParts(message.content, protocol, 'content'));
        if (message.tool_calls != null) {
          if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) fail('tool_calls must belong to an assistant message');
          for (const call of message.tool_calls) {
            if (call.type !== 'function') fail('Only function tools are supported');
            const id = toolId(call.id), name = toolName(call.function?.name);
            names.set(id, name);
            parts.push({ function_call: { id, name, args_json: jsonArguments(call.function.arguments) } });
          }
        }
      }
    } else {
      if (!['user', 'assistant'].includes(message.role)) fail('Anthropic messages must use user or assistant roles');
      const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
      if (!Array.isArray(blocks)) fail('Invalid message content');
      for (const block of blocks) {
        if (block?.type === 'image') {
          parts.push(imagePart(block, protocol));
        } else if (block?.type === 'text') {
          if (typeof block.text !== 'string') fail('Invalid text block');
          parts.push({ text: block.text, thought: false });
        } else if (block.type === 'tool_use' && message.role === 'assistant') {
          const id = toolId(block.id), name = toolName(block.name); names.set(id, name);
          parts.push({ function_call: { id, name, args_json: JSON.stringify(object(block.input, 'tool input')) } });
        } else if (block.type === 'tool_result' && message.role === 'user') {
          const id = toolId(block.tool_use_id), name = names.get(id);
          if (!name) fail('Tool result must match an earlier tool_use');
          parts.push(...toolResultParts(id, name, block.content, protocol));
        } else fail('Supported content blocks are text, image, tool_use, and tool_result');
      }
    }
    if (parts.length) request.contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  if (!request.contents.length) fail('At least one user or assistant content item is required');
  if (systems.length) request.system_instruction = systems.join('\n\n');
  const choice = typeof body.tool_choice === 'object' ? body.tool_choice?.type : body.tool_choice;
  if (choice != null && !['auto', 'none'].includes(choice)) fail('Only auto and none tool_choice are supported');
  if (body.tools != null) {
    if (!Array.isArray(body.tools) || body.tools.length > 256) fail('tools must contain at most 256 client functions');
    if (choice !== 'none') request.tools = body.tools.map(raw => {
      const tool = protocol === 'openai' ? raw.function : raw;
      if (protocol === 'openai' && raw.type !== 'function') fail('Only client function tools are supported');
      if (typeof tool?.type === 'string') fail('Server-side tools are not supported');
      return { name: toolName(tool?.name), description: tool.description || '',
        parameters_json: JSON.stringify(object(protocol === 'openai' ? tool.parameters : tool.input_schema, 'tool schema')) };
    });
  }
  return request;
}

export function usageFromFrame(frame) {
  const usage = frame.usage_metadata ?? frame.usageMetadata;
  if (!usage) return undefined;
  const input = usage.prompt_token_count ?? usage.promptTokenCount ?? usage.input_tokens;
  const output = usage.candidates_token_count ?? usage.candidatesTokenCount ?? usage.output_tokens;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  const cached = usage.cached_content_token_count ?? usage.cachedContentTokenCount;
  const reasoning = usage.thoughts_token_count ?? usage.thoughtsTokenCount;
  return { prompt_tokens: input, completion_tokens: output,
    total_tokens: usage.total_token_count ?? usage.totalTokenCount ?? input + output,
    ...(Number.isFinite(cached) ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(Number.isFinite(reasoning) ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}) };
}

export class Completion {
  constructor(model) {
    this.id = 'chatcmpl_' + randomUUID().replaceAll('-', ''); this.model = model.alias;
    this.created = Math.floor(Date.now() / 1000); this.text = ''; this.tools = []; this.blocks = [];
    this.usage = undefined; this.finish = 'stop'; this.firstTextAt = null;
  }
  apply(frame) {
    const events = [];
    if ((frame.content?.parts || []).some(part => part.thought !== true &&
      (part.inline_data || part.inlineData || part.file_data || part.fileData))) {
      throw new ApiError(502, 'unsupported_image_response', 'Accio returned structured media that this chat protocol cannot deliver. Use an image tool to receive image files; the response was not discarded silently.');
    }
    this.usage = usageFromFrame(frame) || this.usage;
    const reason = frame.finish_reason ?? frame.finishReason;
    if (reason && /max|length/i.test(reason)) this.finish = 'length';
    if (reason && /safety|filter/i.test(reason)) this.finish = 'content_filter';
    for (const part of frame.content?.parts || []) {
      if (part.thought === true) continue;
      if (typeof part.text === 'string' && part.text) {
        this.text += part.text; this.firstTextAt ??= Date.now(); events.push({ type: 'text', text: part.text });
        if (this.blocks.at(-1)?.type === 'text') this.blocks.at(-1).text += part.text;
        else this.blocks.push({ type: 'text', text: part.text });
      }
      const call = part.function_call ?? part.functionCall;
      // Omitted protobuf booleans mean false. A tool-start frame can carry an
      // empty argument object; emit only the final complete call.
      if (call && (frame.turn_complete === true || frame.turnComplete === true)) {
        const id = call.id || 'call_' + randomUUID().replaceAll('-', '');
        if (this.tools.some(t => t.id === id)) continue;
        const args = call.args_json ?? call.argsJson ?? '{}';
        let input;
        try { input = object(JSON.parse(args), 'upstream tool input'); }
        catch { throw new ApiError(502, 'invalid_tool_arguments', 'Accio returned invalid tool arguments'); }
        const tool = { id, type: 'function', function: { name: call.name, arguments: JSON.stringify(input) } };
        this.tools.push(tool); this.blocks.push({ type: 'tool_use', id, name: call.name, input });
        events.push({ type: 'tool', tool, input, index: this.tools.length - 1 });
      }
    }
    if (this.tools.length && !['length', 'content_filter'].includes(this.finish)) this.finish = 'tool_calls';
    return events;
  }
  validate() {
    const reachedTokenLimit = this.finish === 'length' && this.usage?.completion_tokens > 0;
    if (!this.text && !this.tools.length && !reachedTokenLimit) throw new ApiError(502, 'empty_model_response', 'Accio returned no text or tool calls');
  }
  openai() {
    return { id: this.id, object: 'chat.completion', created: this.created, model: this.model,
      choices: [{ index: 0, finish_reason: this.finish, logprobs: null, message: { role: 'assistant', content: this.text || null,
        ...(this.tools.length ? { tool_calls: this.tools } : {}) } }], ...(this.usage ? { usage: this.usage } : {}) };
  }
  anthropic() {
    return { id: this.id.replace('chatcmpl_', 'msg_'), type: 'message', role: 'assistant', model: this.model,
      content: this.blocks,
      stop_reason: this.finish === 'tool_calls' ? 'tool_use' : this.finish === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: this.usage?.prompt_tokens ?? 0, output_tokens: this.usage?.completion_tokens ?? 0 },
      ...(this.usage ? {} : { accio_usage_unavailable: true }) };
  }
}
