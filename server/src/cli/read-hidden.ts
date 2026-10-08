export interface HiddenInput {
  isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Reads one line from a TTY without echo. Raw mode is always switched off, the stream paused and
 * every listener removed on success, Ctrl-C, end-of-input and stream errors.
 */
export function readHidden(prompt: string, input: HiddenInput, output: { write(s: string): unknown }): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    let done = false;
    const finish = (outcome: () => void): void => {
      if (done) return;
      done = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      try { input.setRawMode(false); } finally { input.pause(); }
      output.write('\n');
      outcome();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(() => resolve(value));
        if (ch === '\u0003') return finish(() => reject(new Error('Cancelled.')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else value += ch;
      }
    };
    const onEnd = (): void => finish(() => reject(new Error('Input ended before the password was entered.')));
    const onError = (error: Error): void => finish(() => reject(error));
    output.write(prompt);
    try {
      input.setRawMode(true);
      input.setEncoding('utf8');
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('error', onError);
      input.resume();
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
