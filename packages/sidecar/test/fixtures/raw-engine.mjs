// A scriptable misbehaving engine for the sidecar tests: `node raw-engine.mjs <socket> <mode>`.
// Prints every line it receives to stdout (one per line) so tests can assert what the host sent.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const [path, mode] = process.argv.slice(2);
const MAX = 1_048_576;
const tug = JSON.parse(readFileSync(new URL('../../conformance/tug.manifest.json', import.meta.url), 'utf8'));
const socket = connect(path);
const send = (msg) => socket.write(`${JSON.stringify(msg)}\n`);
const padded = (msg, bytes) => {
  const base = JSON.stringify({ ...msg, pad: '' });
  return `${JSON.stringify({ ...msg, pad: 'x'.repeat(bytes - Buffer.byteLength(base)) })}\n`;
};

let nextId = 0;
let buffered = '';
socket.setEncoding('utf8');
socket.on('data', (text) => {
  buffered += text;
  for (let nl = buffered.indexOf('\n'); nl !== -1; nl = buffered.indexOf('\n')) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    process.stdout.write(`${line.length > 2000 ? JSON.stringify({ op: 'long', bytes: Buffer.byteLength(line) }) : line}\n`);
    onMessage(JSON.parse(line));
  }
});
socket.on('error', () => {});
socket.on('close', () => process.exit(0));

function onMessage(msg) {
  if (msg.op === 'ready' && mode === 'tug-then-hangup') {
    send({ op: 'host', id: ++nextId, method: 'createMatch', args: [{ seed: 1, controllers: { north: { puller: 'agent' } } }] });
  }
  if (msg.op === 'result' && mode === 'tug-then-hangup') {
    if (msg.data?.session) send({ op: 'host', id: ++nextId, method: 'mintSeatToken', args: [msg.data.session, 'north', 'puller'] });
    else if (msg.data?.token) setTimeout(() => socket.destroy(), 500);
  }
  if (msg.op !== 'call') return;
  if (mode === 'silent') return;
  if (mode === 'hangup') return socket.destroy();
  if (mode === 'wrong-id') return send({ op: 'result', id: msg.id + 1000, ok: true, data: null });
  if (mode === 'refuse') return send({ op: 'result', id: msg.id, ok: false, code: 'unknown_method', message: 'nope' });
  if (mode === 'tug-then-hangup') {
    const data = msg.method === 'create' || msg.method === 'step' ? { tick: 0 } : msg.method === 'outcome' ? 'running' : null;
    return send({ op: 'result', id: msg.id, ok: true, data });
  }
  send({ op: 'result', id: msg.id, ok: true, data: { method: msg.method, args: msg.args } });
}

socket.on('connect', () => {
  if (mode === 'oversize') socket.write(padded({ op: 'hello' }, MAX + 1));
  else if (mode === 'exact') socket.write(padded({ op: 'hello' }, MAX));
  else if (mode === 'split') {
    // One message delivered byte-group by byte-group, then two messages in one write.
    const line = `${JSON.stringify({ op: 'host', id: 1, method: 'first' })}\n`;
    let i = 0;
    const drip = setInterval(() => {
      socket.write(line.slice(i, i + 5));
      i += 5;
      if (i >= line.length) {
        clearInterval(drip);
        socket.write(`${JSON.stringify({ op: 'host', id: 2, method: 'second' })}\n${JSON.stringify({ op: 'host', id: 3, method: 'third' })}\n`);
      }
    }, 5);
  } else if (mode === 'garbage') socket.write('this is not json\n');
  else if (mode === 'bad-manifest') send({ op: 'hello', protocol: 1, manifest: { id: 'x' }, hooks: [] });
  else if (mode === 'bad-protocol') send({ op: 'hello', protocol: 99, manifest: tug, hooks: [] });
  else if (mode === 'tug-then-hangup') send({ op: 'hello', protocol: 1, manifest: tug, hooks: [] });
});
