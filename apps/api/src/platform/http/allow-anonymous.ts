import { type CustomDecorator, SetMetadata } from '@nestjs/common';

export const ANONYMOUS = 'shipkeep:identity:anonymous';
export function AllowAnonymous(): CustomDecorator {
  return SetMetadata(ANONYMOUS, true);
}
