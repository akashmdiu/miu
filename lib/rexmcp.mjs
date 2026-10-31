// A small client for rexenv's MCP server (`rex mcp`, stdio, one JSON message
// per line). The harness uses it to check the stack before a run and to delete
// the scratch sites a run created; the agent talks to the same server through
// the Agent SDK.
import { spawn } from 'node:child_process';

export class RexMcp {
  constructor() {
    this.child = spawn(process.env.QA_REX_BIN ?? 'rex', ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.next = 1;
    this.waiting = new Map();
    this.child.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) > -1) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const w = msg.id != null && this.waiting.get(msg.id);
        if (w) { this.waiting.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result); }
      }
    });
    this.child.on('error', (e) => { for (const w of this.waiting.values()) w.reject(e); this.waiting.clear(); });
  }

  request(method, params, timeoutMs = 300000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`rexenv ${method} timed out`)); }, timeoutMs);
      this.waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async init() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'miu', version: '1' } }, 20000);
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return this;
  }

  // Calls a tool and returns its JSON payload (rexenv answers with one text block of JSON).
  async call(name, args = {}, timeoutMs) {
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = (r?.content ?? []).map((c) => c.text ?? '').join('');
    let data; try { data = JSON.parse(text); } catch { data = { text }; }
    if (r?.isError) throw new Error(data.error ?? data.detail ?? text);
    return data;
  }

  close() { try { this.child.kill(); } catch { /* gone */ } }
}

export async function withRex(fn) {
  const rex = await new RexMcp().init();
  try { return await fn(rex); } finally { rex.close(); }
}
