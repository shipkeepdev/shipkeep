/** What the terminal shows: the person's commands and the container's output. */
export interface TerminalLine {
  readonly kind: 'input' | 'stdout' | 'stderr' | 'note';
  readonly text: string;
}

/** Lines the terminal keeps. */
export const MAX_TERMINAL_LINES = 2000;

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

/** Appends output, splitting it at newlines and joining a line that came in two frames. */
export function appendOutput(screen: Screen, kind: 'stdout' | 'stderr', text: string): Screen {
  const lines = [...screen.lines];
  const parts = plain(text).split('\n');
  parts.forEach((part, index) => {
    const last = lines.at(-1);
    if (index === 0 && screen.open && last?.kind === kind) {
      lines[lines.length - 1] = { kind, text: last.text + part };
    } else if (index < parts.length - 1 || part !== '') {
      lines.push({ kind, text: part });
    }
  });
  return { lines: lines.slice(-MAX_TERMINAL_LINES), open: parts.at(-1) !== '' };
}

/** Adds a line of its own: a command typed, or a note of the terminal. */
export function appendLine(screen: Screen, line: TerminalLine): Screen {
  return { lines: [...screen.lines, line].slice(-MAX_TERMINAL_LINES), open: false };
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
