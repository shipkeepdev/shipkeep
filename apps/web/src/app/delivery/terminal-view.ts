/** What the terminal shows: the person's commands and the container's output. */
export interface TerminalLine {
  readonly kind: 'input' | 'stdout' | 'stderr' | 'note';
  readonly text: string;
  /** The line was longer: its start is kept, the rest up to its newline dropped. */
  readonly truncated?: boolean;
}

/** Lines the terminal keeps. */
export const MAX_TERMINAL_LINES = 2000;
/** The longest line kept, in characters: output that never ends a line stays bounded (#477). */
export const MAX_LINE_CHARS = 4096;
/** All the lines kept, in characters: the oldest go first past it. */
export const MAX_SCREEN_CHARS = 1 << 20;

/** Why a session ended, as the API says it (SPEC 3.1), in words for the person. */
export const END_REASONS: Readonly<Record<string, string>> = {
  exited: 'The command exited.',
  time_limit: 'The session reached its time limit.',
  closed: 'The session was closed.',
  failed: 'The session failed.',
  not_joined: 'The server did not join the session in time.',
  agent_left: 'The server left the session.',
  browser_left: 'The session was closed.',
  flooded: 'Too much input was waiting: the session was closed.',
  signed_out: 'You signed out: the session was closed.',
  access_removed: 'You no longer have access to this container.',
  shutdown: 'The control plane restarted: the session was closed.',
};

/**
 * Removes terminal escape sequences (colors, cursor moves, titles) from output: this terminal
 * shows text, not a screen.
 */
export function plain(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- escape sequences are what is removed
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      // eslint-disable-next-line no-control-regex -- escape sequences are what is removed
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex -- other control characters but tab and newline
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  );
}

/** The terminal's text, and whether its last line waits for the rest of its output. */
export interface Screen {
  readonly lines: readonly TerminalLine[];
  readonly open: boolean;
}

/**
 * Appends output, splitting it at newlines and joining a line that came in two frames. A line is
 * kept up to MAX_LINE_CHARS, then marked truncated, and the screen up to its line and character
 * bounds, the newest kept.
 */
export function appendOutput(screen: Screen, kind: 'stdout' | 'stderr', text: string): Screen {
  const lines = [...screen.lines];
  const parts = plain(text).split('\n');
  parts.forEach((part, index) => {
    const last = lines.at(-1);
    if (index === 0 && screen.open && last?.kind === kind) {
      lines[lines.length - 1] = extended(last, part);
    } else if (index < parts.length - 1 || part !== '') {
      lines.push(extended({ kind, text: '' }, part));
    }
  });
  return { lines: bounded(lines), open: parts.at(-1) !== '' };
}

/** Adds a line of its own: a command typed, or a note of the terminal. */
export function appendLine(screen: Screen, line: TerminalLine): Screen {
  return {
    lines: bounded([...screen.lines, extended({ ...line, text: '' }, line.text)]),
    open: false,
  };
}

/** A line with `part` added, within MAX_LINE_CHARS; a truncated line takes nothing more. */
function extended(line: TerminalLine, part: string): TerminalLine {
  if (line.truncated) return line;
  const text = line.text + part;
  if (text.length <= MAX_LINE_CHARS) return { ...line, text };
  // Never between the two halves of a character outside the basic plane.
  const code = text.charCodeAt(MAX_LINE_CHARS - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? MAX_LINE_CHARS - 1 : MAX_LINE_CHARS;
  return { ...line, text: text.slice(0, end), truncated: true };
}

/** The newest lines within MAX_TERMINAL_LINES and MAX_SCREEN_CHARS. */
function bounded(lines: readonly TerminalLine[]): TerminalLine[] {
  const kept = lines.slice(-MAX_TERMINAL_LINES);
  let total = kept.reduce((sum, line) => sum + line.text.length, 0);
  let first = 0;
  while (total > MAX_SCREEN_CHARS && first < kept.length - 1) {
    total -= kept[first]?.text.length ?? 0;
    first++;
  }
  return kept.slice(first);
}

/** A text message of the server: the exit, or the end and its reason. */
export function serverMessage(data: string): { exit?: number; reason?: string } | undefined {
  try {
    const value = JSON.parse(data) as Record<string, unknown>;
    if (value['type'] === 'exit' && typeof value['code'] === 'number')
      return { exit: value['code'] };
    if (value['type'] === 'end' && typeof value['reason'] === 'string')
      return { reason: value['reason'] };
  } catch {
    return undefined;
  }
  return undefined;
}
