// When the AI service turns Miu's sign-in away during a run (an expired or
// revoked ChatGPT or Claude sign-in, a dead API key), the CLI still says
// "logged in": only the run finds out. The run records it here, and the
// dashboard holds the queue until the sign-in changes, instead of starting run
// after run that ends with no result.
import fs from 'node:fs';
import path from 'node:path';
import { signInStamp } from './connections.mjs';

// What the CLIs print when the service refuses the sign-in.
export const REFUSED = /unauthori[sz]ed|\b401\b|invalid[_ ]grant|refresh token|token (has )?(expired|been revoked|is invalid)|not logged in|authentication (failed|error)|invalid (x-)?api[ -]key|oauth token has expired/i;

const file = (runs) => path.join(runs, '.auth-refused.json');

// The refusal in a run's agent output, if there is one.
export function refusalIn(runDir) {
  for (const f of ['agent-codex.jsonl', 'agent-transcript.jsonl', 'run.log']) {
    let text = '';
    try { text = fs.readFileSync(path.join(runDir, f), 'utf8').slice(-20000); } catch { continue; }
    // Only the CLI's own errors: a run that tests a login page sees 401s that are not Miu's.
    const own = (l) => /"type":"(error|turn\.failed)"|\] (codex|claude): |"is_error":true|"subtype":"error/.test(l);
    const line = text.split('\n').reverse().find((l) => own(l) && REFUSED.test(l));
    if (line) return (line.match(/"message":"([^"]+)"/)?.[1] ?? line).replace(/^\[qa [\d:]+\] /, '').slice(0, 200);
  }
  return null;
}

export function recordRefusal(runs, engine, mode, message) {
  fs.writeFileSync(file(runs), JSON.stringify({ engine, mode, stamp: signInStamp(engine, mode), message, at: new Date().toISOString() }, null, 2));
}

// The standing refusal for this engine, or null once the sign-in has changed
// (and then the record is cleared).
export function refusal(runs, engine, mode) {
  let r;
  try { r = JSON.parse(fs.readFileSync(file(runs), 'utf8')); } catch { return null; }
  if (r.engine !== engine) return null;
  if (r.stamp !== signInStamp(engine, mode)) { fs.rmSync(file(runs), { force: true }); return null; }
  return r;
}
