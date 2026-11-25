import { describe, expect, it } from 'vitest';

import {
  appendLine,
  appendOutput,
  MAX_LINE_CHARS,
  MAX_SCREEN_CHARS,
  MAX_TERMINAL_LINES,
  MAX_HELD_ESCAPE,
  plain,
  serverMessage,
  unfinished,
} from './terminal-view';

const empty = { lines: [], open: false };

describe('the terminal view', () => {
  it('removes escape sequences and control characters, and keeps the text', () => {
    expect(plain('\u001b[1;31merror\u001b[0m: \u001b]0;title\u0007done\u0008\ttab')).toBe(
      'error: done\ttab',
    );
  });

  it('splits output at newlines and joins a line that came in two frames', () => {
    let screen = appendOutput(empty, 'stdout', 'first line\nsec');
    screen = appendOutput(screen, 'stdout', 'ond line\n');
    expect(screen.lines.map((l) => l.text)).toEqual(['first line', 'second line']);
    expect(screen.open).toBe(false);
    screen = appendOutput(screen, 'stderr', 'oops');
    screen = appendOutput(screen, 'stdout', 'out\n\n');
    expect(screen.lines.map((l) => [l.kind, l.text])).toEqual([
      ['stdout', 'first line'],
      ['stdout', 'second line'],
      ['stderr', 'oops'],
      ['stdout', 'out'],
      ['stdout', ''],
    ]);
  });

  it('starts a new line after a command or a note, and keeps the last lines only', () => {
    let screen = appendOutput(empty, 'stdout', 'prompt');
    screen = appendLine(screen, { kind: 'input', text: 'ls' });
    screen = appendOutput(screen, 'stdout', 'a.txt\n');
    expect(screen.lines.map((l) => l.text)).toEqual(['prompt', 'ls', 'a.txt']);
    for (let i = 0; i < MAX_TERMINAL_LINES; i++)
      screen = appendLine(screen, { kind: 'note', text: String(i) });
    expect(screen.lines).toHaveLength(MAX_TERMINAL_LINES);
  });

  it('reads the exit and the end, and nothing else', () => {
    expect(serverMessage('{"type":"exit","code":3}')).toEqual({ exit: 3 });
    expect(serverMessage('{"type":"end","reason":"time_limit"}')).toEqual({ reason: 'time_limit' });
    for (const data of ['not json', '{"type":"exit","code":"3"}', '{"type":"other"}', '[]', 'null'])
      expect(serverMessage(data)).toBeUndefined();
  });

  it('bounds a line that never ends, keeping its start, marked truncated', () => {
    let screen: ReturnType<typeof appendOutput> = empty;
    // 32 KiB at a time without a newline, as the audit's probe sent (#477).
    for (let i = 0; i < 64; i++) screen = appendOutput(screen, 'stdout', 'x'.repeat(32 * 1024));
    expect(screen.lines).toHaveLength(1);
    expect(screen.lines[0]?.text).toHaveLength(MAX_LINE_CHARS);
    expect(screen.lines[0]?.truncated).toBe(true);
    // The rest of that line is dropped up to its newline; the next line starts afresh.
    screen = appendOutput(screen, 'stdout', 'tail\nnext\n');
    expect(screen.lines.map((l) => [l.text.slice(0, 4), l.truncated ?? false])).toEqual([
      ['xxxx', true],
      ['next', false],
    ]);
  });

  it('never cuts a character in two', () => {
    const screen = appendOutput(empty, 'stdout', `${'x'.repeat(MAX_LINE_CHARS - 1)}🚀end\n`);
    expect(screen.lines[0]?.text).toBe('x'.repeat(MAX_LINE_CHARS - 1));
  });

  it('bounds the whole screen in characters as well as in lines', () => {
    let screen: ReturnType<typeof appendOutput> = empty;
    const line = `${'y'.repeat(MAX_LINE_CHARS - 1)}\n`;
    for (let i = 0; i < 1000; i++) screen = appendOutput(screen, 'stdout', line);
    const total = screen.lines.reduce((sum, l) => sum + l.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_SCREEN_CHARS);
    expect(screen.lines.length).toBeLessThan(1000);
    // The newest lines are the ones kept.
    expect(screen.lines.at(-1)?.text).toBe('y'.repeat(MAX_LINE_CHARS - 1));
  });

  it('keeps a line open across a frame that only changes the color', () => {
    let screen = appendOutput(empty, 'stdout', 'hello');
    screen = appendOutput(screen, 'stdout', '\u001b[0m');
    screen = appendOutput(screen, 'stdout', ' world\n');
    expect(screen.lines.map((l) => l.text)).toEqual(['hello world']);
  });

  it('holds an escape sequence cut between two frames until its end comes', () => {
    // Frames as a shell sends them: the color code split in two.
    const first = unfinished('', 'ok \u001b[31');
    expect(first).toEqual({ text: 'ok ', held: '\u001b[31' });
    const second = unfinished(first.held, 'merror\u001b[0m\n');
    expect(second).toEqual({ text: '\u001b[31merror\u001b[0m\n', held: '' });
    let screen = appendOutput(empty, 'stdout', first.text);
    screen = appendOutput(screen, 'stdout', second.text);
    expect(screen.lines.map((l) => l.text)).toEqual(['ok error']);
    // A title cut before its end, and a lone escape, wait too.
    expect(unfinished('', 'a\u001b]0;tit')).toEqual({ text: 'a', held: '\u001b]0;tit' });
    expect(unfinished('', 'a\u001b]0;title\u001b')).toEqual({
      text: 'a',
      held: '\u001b]0;title\u001b',
    });
    expect(unfinished('', 'b\u001b')).toEqual({ text: 'b', held: '\u001b' });
  });

  it('lets through complete sequences, plain text, and an unfinished one past its bound', () => {
    expect(unfinished('', 'a\u001b[0mb')).toEqual({ text: 'a\u001b[0mb', held: '' });
    expect(unfinished('', 'a\u001b]0;t\u0007b')).toEqual({ text: 'a\u001b]0;t\u0007b', held: '' });
    expect(unfinished('', 'plain text\n')).toEqual({ text: 'plain text\n', held: '' });
    // A newline ends what a title could be: the line shows.
    expect(unfinished('', '\u001b]0;x\nprompt$ ').held).toBe('');
    const long = `\u001b]0;${'t'.repeat(MAX_HELD_ESCAPE)}`;
    expect(unfinished('', long)).toEqual({ text: long, held: '' });
  });
});
