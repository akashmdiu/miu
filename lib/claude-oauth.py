#!/usr/bin/env python3
# Signs in to a Claude subscription for Miu through the Claude CLI's own
# sign-in (`claude setup-token`), which only draws its screen on a terminal, so
# it runs here in a pseudo-terminal. lib/connections.mjs talks to it in JSON
# lines:
#   out {"url": "..."}        the sign-in page to open
#   in  {"code": "..."}       the code the Claude page shows after sign-in
#   out {"token": "..."}      the long-lived (one year) subscription token
#   out {"error": "..."}      on any failure
# The token is printed once, to lib/connections.mjs, and never logged.
import json, os, pty, re, select, subprocess, sys, time

ANSI = re.compile(rb'\x1b\[[0-9;?]*[a-zA-Z]')
# A whole OSC 8 link: the output can arrive cut in the middle of one.
LINK = re.compile(rb'\x1b\]8;[^;]*;(https://[^\x1b\x07]+)(?=\x1b|\x07)')
TOKEN = re.compile(rb'(sk-ant-oat\d*-[A-Za-z0-9_-]{20,})')

def say(o):
    sys.stdout.write(json.dumps(o) + '\n'); sys.stdout.flush()

def main():
    claude = sys.argv[1] if len(sys.argv) > 1 else 'claude'
    # The CLI would open a browser tab of its own; the dashboard opens the page.
    env = dict(os.environ, BROWSER='/usr/bin/true', COLUMNS='400', LINES='50')
    master, slave = pty.openpty()
    proc = subprocess.Popen([claude, 'setup-token'], stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
    os.close(slave)
    buf, url, sent = b'', None, False
    deadline = time.time() + 600
    while time.time() < deadline:
        fds = [master] + ([sys.stdin] if url and not sent else [])
        ready, _, _ = select.select(fds, [], [], 0.5)
        if master in ready:
            try: chunk = os.read(master, 65536)
            except OSError: break
            if not chunk: break
            buf += chunk
            if not url:
                m = LINK.search(buf)
                if m:
                    url = m.group(1).decode()
                    say({'url': url})
            if sent:
                t = TOKEN.search(ANSI.sub(b'', buf).replace(b'\r', b'').replace(b'\n', b''))
                if t:
                    say({'token': t.group(1).decode()})
                    proc.terminate(); return 0
        if sys.stdin in ready:
            line = sys.stdin.readline()
            if not line: break
            code = str(json.loads(line).get('code', '')).strip()
            if not re.fullmatch(r'[A-Za-z0-9_#.\-]{10,400}', code):
                say({'error': 'That does not look like the code from the Claude page.'})
                continue
            buf = b''
            os.write(master, code.encode() + b'\r')
            sent = True
        if proc.poll() is not None and not select.select([master], [], [], 0.2)[0]:
            break
    proc.kill()
    tail = ANSI.sub(b'', buf).decode('utf8', 'replace')
    msg = 'The sign-in timed out.' if time.time() >= deadline else 'The sign-in did not finish.'
    if re.search(r'invalid|error|expired', tail, re.I): msg = 'Claude did not accept the code. Start the sign-in again.'
    say({'error': msg})
    return 1

if __name__ == '__main__':
    sys.exit(main())
