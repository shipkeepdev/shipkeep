import { describe, expect, it } from 'vitest';

import {
  appendLine,
  appendOutput,
  MAX_TERMINAL_LINES,
  plain,
  serverMessage,
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
});
