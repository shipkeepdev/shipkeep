import { applyDecorators, type CustomDecorator, SetMetadata } from '@nestjs/common';

export const ANONYMOUS = 'shipkeep:identity:anonymous';
export function AllowAnonymous(): CustomDecorator {
  return SetMetadata(ANONYMOUS, true);
}

export const SIGNED_BODY = 'shipkeep:identity:signed-body';
/**
 * An anonymous route that a server calls, not a browser, authenticated by a signature over its
 * body that the route itself checks (a webhook). It carries no Origin, so it is spared the
 * cross-site check of anonymous mutations; the signature is what refuses a forged request.
 */
export function AllowSignedBody(): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(ANONYMOUS, true), SetMetadata(SIGNED_BODY, true));
}
