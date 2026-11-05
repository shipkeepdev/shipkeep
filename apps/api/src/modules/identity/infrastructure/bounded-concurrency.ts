import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Admits at most `active` concurrent operations and queues up to `queued` more without holding any
 * resource. Beyond that, callers fail fast with 503 instead of piling up.
 */
export class BoundedConcurrency {
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(
    private readonly active: number,
    private readonly queued: number,
    private readonly message: string,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.active) {
      if (this.#waiting.length >= this.queued) throw new ServiceUnavailableException(this.message);
      // The releasing caller hands its slot over directly, so #active stays unchanged.
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#active++;
    }
    try {
      return await operation();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
}
