import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A local stand-in for api.telegram.org (the worker's TELEGRAM_API_ROOT): records every API call, answers ok. */
export async function telegramStub() {
  const calls: { method: string; body: any }[] = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body: any = {}; try { body = JSON.parse(raw || '{}'); } catch { /* form data */ }
      calls.push({ method: String(req.url).split('/').pop() ?? '', body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  return { calls, root: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise<void>(r => srv.close(() => r())) };
}
