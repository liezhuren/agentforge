import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTask, listTasks } from './store.ts';

export const DEFAULT_PORT = 39517;

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    send(res, 200, { items: listTasks() });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readJsonBody(req);
    const title = typeof body.title === 'string' && body.title.length > 0 ? body.title : '未命名任务';
    send(res, 201, createTask(title));
    return;
  }
  send(res, 404, { error: 'not found' });
}

export function createApp(): Server {
  return createServer((req, res) => {
    void handle(req, res);
  });
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`task-board listening on http://127.0.0.1:${port}`);
  });
}
