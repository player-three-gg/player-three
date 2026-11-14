import { describe, expect, it } from 'vitest';
import { encodeLine, LineDecoder, MAX_LINE_BYTES, parseLine } from '../src/protocol.ts';

const feed = (decoder: LineDecoder, ...chunks: (string | Buffer)[]) => {
  const out: string[] = [];
  let status = 'ok';
  for (const c of chunks) {
    status = decoder.push(typeof c === 'string' ? Buffer.from(c) : c, out);
    if (status !== 'ok') break;
  }
  return { out, status };
};

describe('framing', () => {
  it('splits lines across and within chunks', () => {
    const d = new LineDecoder();
    expect(feed(d, '{"a":', '1}\n{"b"', ':2}\n{"c":3}\n{"d"')).toEqual({ out: ['{"a":1}', '{"b":2}', '{"c":3}'], status: 'ok' });
    expect(feed(d, ':4}\n')).toEqual({ out: ['{"d":4}'], status: 'ok' });
  });

  it('decodes multi-byte UTF-8 split between chunks and rejects invalid UTF-8', () => {
    const bytes = Buffer.from('{"s":"±"}\n');
    const at = bytes.indexOf(0xb1);
    expect(feed(new LineDecoder(), bytes.subarray(0, at), bytes.subarray(at)).out).toEqual(['{"s":"±"}']);
    expect(feed(new LineDecoder(), Buffer.from([0x7b, 0xff, 0x7d, 0x0a])).status).toBe('bad_utf8');
  });

  it(`accepts a line of exactly ${MAX_LINE_BYTES} bytes before the newline and nothing longer`, () => {
    const exact = 'x'.repeat(MAX_LINE_BYTES);
    expect(feed(new LineDecoder(), exact.slice(0, 1000), `${exact.slice(1000)}\n`).out[0]!.length).toBe(MAX_LINE_BYTES);
    expect(feed(new LineDecoder(), `${exact}x\n`).status).toBe('too_large');
    // An unterminated line fails as soon as it passes the limit, without waiting for its newline.
    expect(feed(new LineDecoder(), exact, 'x').status).toBe('too_large');
    expect(feed(new LineDecoder(), exact).status).toBe('ok');
  });

  it('encodes one message per line within the limit', () => {
    expect(encodeLine({ op: 'ready', surfaceHash: 'h' })).toBe('{"op":"ready","surfaceHash":"h"}\n');
    const fill = MAX_LINE_BYTES - '{"p":""}'.length;
    expect(encodeLine({ p: 'x'.repeat(fill) }).length).toBe(MAX_LINE_BYTES + 1);
    expect(() => encodeLine({ p: 'x'.repeat(fill + 1) })).toThrow(/exceeds/);
    // The limit counts UTF-8 bytes, not UTF-16 code units.
    expect(() => encodeLine({ p: '±'.repeat(fill / 2 + 1) })).toThrow(/exceeds/);
  });

  it('parses only JSON objects', () => {
    expect(parseLine('{"op":"hello"}')).toEqual({ op: 'hello' });
    for (const bad of ['[1]', '"s"', 'null', '1', '{', '']) expect(parseLine(bad)).toBeUndefined();
  });
});
