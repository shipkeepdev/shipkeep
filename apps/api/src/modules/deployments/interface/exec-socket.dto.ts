import { plainToInstance } from 'class-transformer';
import { Equals, IsBoolean, IsInt, Max, Min, validateSync } from 'class-validator';

import type { BrowserFrame } from '../../fleet/application/exec-relay';

/** A terminal side, in characters. */
const TERMINAL_SIDE = 1000;

/** `{"type":"resize","cols":n,"rows":n}`: the browser's terminal changed size. */
export class ResizeMessageDto {
  @Equals('resize') type!: 'resize';
  @IsInt() @Min(1) @Max(TERMINAL_SIDE) cols!: number;
  @IsInt() @Min(1) @Max(TERMINAL_SIDE) rows!: number;
}

/** `{"type":"close","kill":b}`: the browser ends the session, stopping the command or not. */
export class CloseMessageDto {
  @Equals('close') type!: 'close';
  @IsBoolean() kill!: boolean;
}

/** A browser's text message as a frame, validated at the edge; undefined when it is none. */
export function controlFrame(message: unknown): BrowserFrame | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const type = (message as Record<string, unknown>)['type'];
  if (type === 'resize') {
    const resize = plainToInstance(ResizeMessageDto, message);
    if (validateSync(resize, { forbidUnknownValues: true }).length > 0) return undefined;
    return { kind: 'resize', cols: resize.cols, rows: resize.rows };
  }
  if (type === 'close') {
    const close = plainToInstance(CloseMessageDto, message);
    if (validateSync(close, { forbidUnknownValues: true }).length > 0) return undefined;
    return { kind: 'close', kill: close.kill };
  }
  return undefined;
}
