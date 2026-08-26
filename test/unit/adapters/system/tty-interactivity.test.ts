import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createConfirmationAnswerReader,
  type ConfirmationAnswerStreams,
} from '../../../../src/adapters/system/confirmation-answer-reader.js';
import { createTtyInteractivityCheck } from '../../../../src/adapters/system/tty-interactivity.js';

class ConfirmationInput extends EventEmitter {
  paused = false;
  pauseCalls = 0;
  resumeCalls = 0;

  pause(): this {
    this.pauseCalls += 1;
    this.paused = true;
    return this;
  }

  resume(): this {
    this.resumeCalls += 1;
    this.paused = false;
    return this;
  }
}

function streams(): {
  readonly stdin: ConfirmationInput;
  readonly stderr: Writable;
  readonly output: string[];
} {
  const output: string[] = [];
  return {
    stdin: new ConfirmationInput(),
    stderr: new Writable({
      write(chunk, _encoding, callback) {
        output.push(chunk.toString());
        callback();
      },
    }),
    output,
  };
}

function adapterStreams(input: ConfirmationInput, stderr: Writable): ConfirmationAnswerStreams {
  return { stdin: input as unknown as ConfirmationAnswerStreams['stdin'], stderr };
}

describe('createTtyInteractivityCheck()', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])('reports stdin=%s and stderr=%s as interactive=%s', (stdinTTY, stderrTTY, expected) => {
    const processInfo = {
      stdin: { isTTY: stdinTTY },
      stderr: { isTTY: stderrTTY },
    } as unknown as Pick<NodeJS.Process, 'stdin' | 'stderr'>;

    expect(createTtyInteractivityCheck(processInfo)()).toBe(expected);
  });
});

describe('createConfirmationAnswerReader()', () => {
  it('writes the escaped confirmation exchange to stderr and never renders a candidate across lines', async () => {
    const { stdin, stderr, output } = streams();
    const reader = createConfirmationAnswerReader(adapterStreams(stdin, stderr));
    const stdoutWrite = vi.spyOn(process.stdout, 'write');
    try {
      const answer = reader(new Map([['crafted', {
        file: 'crafted\n\u001B[2J-name',
        healingSummary: 'repair\r\nsummary',
      }]]));

      stdin.emit('data', Buffer.from('yes\n'));

      await expect(answer).resolves.toBe(true);
      expect(output.join('')).toBe('crafted\\x0A\\x1B[2J-name: repair\\x0D\\x0Asummary\nApply these healing changes? [y/N] ');
      expect(output[0]).toBe('crafted\\x0A\\x1B[2J-name: repair\\x0D\\x0Asummary\n');
      expect(output[0]!.slice(0, -1)).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stdin.paused).toBe(true);
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it('escapes every C0, DEL, and C1 control character in candidates', async () => {
    const { stdin, stderr, output } = streams();
    const reader = createConfirmationAnswerReader(adapterStreams(stdin, stderr));
    const controlCodes = [
      ...Array.from({ length: 32 }, (_value, code) => code),
      127,
      ...Array.from({ length: 32 }, (_value, index) => 128 + index),
    ];
    const controls = String.fromCharCode(...controlCodes);
    const escapedControls = controlCodes
      .map((code) => `\\x${code.toString(16).padStart(2, '0').toUpperCase()}`)
      .join('');
    const answer = reader(new Map([['crafted', {
      file: `fi${controls}le`,
      healingSummary: `su${controls}mmary`,
    }]]));

    stdin.emit('data', Buffer.from('no\n'));

    await expect(answer).resolves.toBe(false);
    expect(output.join('')).toBe(`fi${escapedControls}le: su${escapedControls}mmary\nApply these healing changes? [y/N] `);
    expect(escapedControls).toContain('\\x9B');
  });

  it('renders file names differing only by a control character differently', async () => {
    const { stdin, stderr, output } = streams();
    const reader = createConfirmationAnswerReader(adapterStreams(stdin, stderr));
    const answer = reader(new Map([
      ['first', { file: `check${String.fromCharCode(1)}out.test.md`, healingSummary: 'same repair' }],
      ['second', { file: `check${String.fromCharCode(2)}out.test.md`, healingSummary: 'same repair' }],
    ]));

    stdin.emit('data', Buffer.from('no\n'));

    await expect(answer).resolves.toBe(false);
    expect(output.join('')).toContain('check\\x01out.test.md: same repair\n');
    expect(output.join('')).toContain('check\\x02out.test.md: same repair\n');
  });

  it('renders a literal backslash and a control escape distinctly', async () => {
    const { stdin, stderr, output } = streams();
    const reader = createConfirmationAnswerReader(adapterStreams(stdin, stderr));
    const answer = reader(new Map([
      ['literal', { file: 'check\\x01out.test.md', healingSummary: 'literal backslash' }],
      ['control', { file: `check${String.fromCharCode(1)}out.test.md`, healingSummary: 'control character' }],
    ]));

    stdin.emit('data', Buffer.from('no\n'));

    await expect(answer).resolves.toBe(false);
    expect(output.join('')).toBe(
      'check\\\\x01out.test.md: literal backslash\n'
      + 'check\\x01out.test.md: control character\n'
      + 'Apply these healing changes? [y/N] ',
    );
  });

  it('declines immediately at EOF without waiting for data', async () => {
    const { stdin, stderr } = streams();
    const reader = createConfirmationAnswerReader(adapterStreams(stdin, stderr));
    const answer = reader(new Map());

    stdin.emit('end');

    await expect(answer).resolves.toBe(false);
    expect(stdin.paused).toBe(true);
  });

  it('declines and cleans up when cancellation arrives while awaiting input', async () => {
    const { stdin, stderr } = streams();
    const controller = new AbortController();
    const reader = createConfirmationAnswerReader(adapterStreams(stdin, stderr));
    const answer = reader(new Map(), controller.signal);

    controller.abort();

    await expect(answer).resolves.toBe(false);
    expect(stdin.paused).toBe(true);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.listenerCount('end')).toBe(0);
    expect(stdin.listenerCount('error')).toBe(0);
  });

  it('rejects on stdin error and performs cleanup exactly once', async () => {
    const { stdin, stderr } = streams();
    const reader = createConfirmationAnswerReader(adapterStreams(stdin, stderr));
    const failure = new Error('stdin failed');
    const pause = vi.spyOn(stdin, 'pause');
    const answer = reader(new Map());

    stdin.emit('error', failure);

    await expect(answer).rejects.toBe(failure);
    expect(pause).toHaveBeenCalledOnce();
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.listenerCount('end')).toBe(0);
    expect(stdin.listenerCount('error')).toBe(0);
  });

  it('declines an already-aborted signal before registering listeners or resuming stdin', async () => {
    const { stdin, stderr } = streams();
    const controller = new AbortController();
    controller.abort();
    const reader = createConfirmationAnswerReader(adapterStreams(stdin, stderr));
    const once = vi.spyOn(stdin, 'once');
    const addAbortListener = vi.spyOn(controller.signal, 'addEventListener');

    await expect(reader(new Map(), controller.signal)).resolves.toBe(false);
    expect(once).not.toHaveBeenCalled();
    expect(addAbortListener).not.toHaveBeenCalled();
    expect(stdin.resumeCalls).toBe(0);
    expect(stdin.pauseCalls).toBe(0);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.listenerCount('end')).toBe(0);
    expect(stdin.listenerCount('error')).toBe(0);
  });

  it('settles only once when data wins a same-tick abort race', async () => {
    const { stdin, stderr } = streams();
    const controller = new AbortController();
    const reader = createConfirmationAnswerReader(adapterStreams(stdin, stderr));
    const answer = reader(new Map(), controller.signal);

    stdin.emit('data', Buffer.from('yes\n'));
    controller.abort();

    await expect(answer).resolves.toBe(true);
    expect(stdin.pauseCalls).toBe(1);
  });

  it.each(['data', 'end'] as const)('removes every input and abort listener after %s resolution', async (event) => {
    const { stdin, stderr } = streams();
    const controller = new AbortController();
    const once = vi.spyOn(stdin, 'once');
    const removeInputListener = vi.spyOn(stdin, 'removeListener');
    const addAbortListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
    const reader = createConfirmationAnswerReader(adapterStreams(stdin, stderr));
    const answer = reader(new Map(), controller.signal);
    const listenerFor = (name: string): unknown => once.mock.calls.find(([registeredName]) => registeredName === name)?.[1];
    const onData = listenerFor('data');
    const onEnd = listenerFor('end');
    const onError = listenerFor('error');
    const onAbort = addAbortListener.mock.calls.find(([registeredName]) => registeredName === 'abort')?.[1];

    expect(onData).toBeTypeOf('function');
    expect(onEnd).toBeTypeOf('function');
    expect(onError).toBeTypeOf('function');
    expect(onAbort).toBeTypeOf('function');

    if (event === 'data') {
      stdin.emit('data', Buffer.from('yes\n'));
      await expect(answer).resolves.toBe(true);
    } else {
      stdin.emit('end');
      await expect(answer).resolves.toBe(false);
    }

    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.listenerCount('end')).toBe(0);
    expect(stdin.listenerCount('error')).toBe(0);
    expect(removeInputListener).toHaveBeenCalledWith('data', onData);
    expect(removeInputListener).toHaveBeenCalledWith('end', onEnd);
    expect(removeInputListener).toHaveBeenCalledWith('error', onError);
    expect(removeAbortListener).toHaveBeenCalledWith('abort', onAbort);
  });
});
