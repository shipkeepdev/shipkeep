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

/**
 * A browser's text message as a frame, validated at the edge; undefined when it is none. Its shape
 * is checked first, flat: exactly the expected keys, each a primitive, so that the DTO
 * transformation never walks anything a browser nested.
 */
export function controlFrame(message: unknown): BrowserFrame | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const value = message as Record<string, unknown>;
  if (value['type'] === 'resize') {
    if (!flat(value, { type: 'string', cols: 'number', rows: 'number' })) return undefined;
    const resize = plainToInstance(ResizeMessageDto, {
      type: value['type'],
      cols: value['cols'],
      rows: value['rows'],
    });
    if (validateSync(resize, { forbidUnknownValues: true }).length > 0) return undefined;
    return { kind: 'resize', cols: resize.cols, rows: resize.rows };
  }
  if (value['type'] === 'close') {
    if (!flat(value, { type: 'string', kill: 'boolean' })) return undefined;
    const close = plainToInstance(CloseMessageDto, { type: value['type'], kill: value['kill'] });
    if (validateSync(close, { forbidUnknownValues: true }).length > 0) return undefined;
    return { kind: 'close', kill: close.kill };
  }
  return undefined;
}

/** Exactly these own keys, each of this primitive type. */
function flat(
  value: Record<string, unknown>,
  shape: Record<string, 'string' | 'number' | 'boolean'>,
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === Object.keys(shape).length &&
    keys.every((key) => Object.hasOwn(shape, key) && typeof value[key] === shape[key])
  );
}
