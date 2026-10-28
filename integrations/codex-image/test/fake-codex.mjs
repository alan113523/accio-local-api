import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
  for (const line of lines.filter(Boolean)) {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') out({ id: msg.id, result: {} });
    else if (msg.method === 'thread/start') {
      if (msg.params.config.features.computer_use !== false || msg.params.config.features.shell_tool !== false) throw new Error('relay tools were not restricted');
      out({ id: msg.id, result: { thread: { id: 'test-thread' } } });
    } else if (msg.method === 'turn/start') {
      out({ id: msg.id, result: {} });
      if (process.env.FAKE_IMAGE_MODE !== 'noimage') {
        const source = join(process.cwd(), 'fake-source.png'); writeFileSync(source, png);
        out({ method: 'item/completed', params: { item: { type: 'imageGeneration', status: 'completed', savedPath: source } } });
      }
      out({ method: 'turn/completed', params: { turn: { status: process.env.FAKE_IMAGE_MODE === 'failed' ? 'failed' : 'completed' } } });
    }
  }
});
