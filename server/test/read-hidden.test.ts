import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { readHidden } from '../src/cli/read-hidden';

class FakeTty extends EventEmitter {
  raw: boolean | null = null; paused = false;
  setRawMode(m: boolean) { this.raw = m; } resume() { this.paused = false; } pause() { this.paused = true; } setEncoding() {}
  listenerTotal() { return ['data', 'end', 'error'].reduce((n, e) => n + this.listenerCount(e), 0); }
}
const out = () => { const w: string[] = []; return { w, write: (s: string) => { w.push(s); } }; };

describe('readHidden terminal handling', () => {
  it('returns the typed value (backspace honoured), never echoes it, and restores the terminal', async () => {
    const tty = new FakeTty(), o = out();
    const p = readHidden('pw: ', tty, o);
    expect(tty.raw).toBe(true);
    tty.emit('data', 'abcX\u007fd\r');
    await expect(p).resolves.toBe('abcd');
    expect(tty.raw).toBe(false); expect(tty.paused).toBe(true); expect(tty.listenerTotal()).toBe(0);
    expect(o.w.join('')).not.toContain('abcd');
  });
  it('restores on Ctrl-C', async () => {
    const tty = new FakeTty(); const p = readHidden('pw: ', tty, out());
    tty.emit('data', 'ab\u0003');
    await expect(p).rejects.toThrow('Cancelled');
    expect(tty.raw).toBe(false); expect(tty.paused).toBe(true); expect(tty.listenerTotal()).toBe(0);
  });
  it('restores on end of input', async () => {
    const tty = new FakeTty(); const p = readHidden('pw: ', tty, out());
    tty.emit('end');
    await expect(p).rejects.toThrow();
    expect(tty.raw).toBe(false); expect(tty.listenerTotal()).toBe(0);
  });
  it('restores on stream error', async () => {
    const tty = new FakeTty(); const p = readHidden('pw: ', tty, out());
    tty.emit('error', new Error('boom'));
    await expect(p).rejects.toThrow('boom');
    expect(tty.raw).toBe(false); expect(tty.paused).toBe(true); expect(tty.listenerTotal()).toBe(0);
  });
  it('restores when setup fails', async () => {
    const tty = new FakeTty(); tty.setEncoding = () => { throw new Error('setup'); };
    await expect(readHidden('pw: ', tty, out())).rejects.toThrow('setup');
    expect(tty.raw).toBe(false); expect(tty.listenerTotal()).toBe(0);
  });
});
