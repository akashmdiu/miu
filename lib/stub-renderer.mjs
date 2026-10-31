// A stand-in for the UCSS renderer, for the Hubs of a QA run. The Hubs send
// their renders here (UCSS_RENDERER_URL), and the agent decides the answers by
// writing a rules file, since it may not start servers itself.
//
//   $QA_RUN_DIR/renderer-stub/rules.json      read on every request
//     [{ "method": "POST", "path": "^/measure", "status": 200,
//        "json": { ... } | "body": "...", "delay_ms": 0, "times": 1 }]
//     The first rule whose method and path (a regular expression) match
//     answers. "times" makes a rule answer that many requests, then stop
//     matching. With no match: 503 { "error": "no stub rule" }.
//   $QA_RUN_DIR/renderer-stub/requests.jsonl  one line per request
//     { at, method, path, headers, body, rule, status }
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export function startStub(runDir, port) {
  const dir = path.join(runDir, 'renderer-stub');
  fs.mkdirSync(dir, { recursive: true });
  const rulesFile = path.join(dir, 'rules.json');
  if (!fs.existsSync(rulesFile)) fs.writeFileSync(rulesFile, '[]\n');
  const used = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= 256 * 1024) chunks.push(c); });
    req.on('end', () => {
      let rules = [];
      try { rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8')); } catch { /* bad JSON answers like no rule */ }
      const idx = rules.findIndex((r, i) => (!r.method || r.method.toUpperCase() === req.method)
        && (!r.path || new RegExp(r.path).test(req.url))
        && (r.times == null || (used.get(i) ?? 0) < r.times));
      const rule = idx > -1 ? rules[idx] : null;
      if (rule) used.set(idx, (used.get(idx) ?? 0) + 1);
      const status = rule?.status ?? 503;
      const body = rule ? (rule.json !== undefined ? JSON.stringify(rule.json) : String(rule.body ?? '')) : JSON.stringify({ error: 'no stub rule' });
      const { authorization, ...headers } = req.headers;
      fs.appendFileSync(path.join(dir, 'requests.jsonl'), JSON.stringify({
        at: new Date().toISOString(), method: req.method, path: req.url,
        headers: { ...headers, ...(authorization ? { authorization: authorization.replace(/\S+$/, '***') } : {}) },
        body: Buffer.concat(chunks).toString('utf8').slice(0, 20000), rule: idx > -1 ? idx : null, status,
      }) + '\n');
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': rule && rule.json === undefined ? 'text/plain' : 'application/json' });
        res.end(body);
      }, Math.min(Number(rule?.delay_ms) || 0, 10 * 60 * 1000));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() }));
  });
}
