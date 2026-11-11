import { IdentityRequestError } from '../identity/identity-api';

import { PagedList } from './paged-list';

interface Item {
  readonly id: string;
  readonly v: number;
}
type Page = { items: readonly Item[]; nextCursor: string | null };

/** A list whose next answers are queued by the test. */
function list(...answers: Page[]): { paged: PagedList<Item>; cursors: (string | undefined)[] } {
  const cursors: (string | undefined)[] = [];
  const paged = new PagedList<Item>((cursor) => {
    cursors.push(cursor);
    const answer = answers.shift();
    return answer ? Promise.resolve(answer) : Promise.reject(new Error('no answer'));
  });
  return { paged, cursors };
}
const item = (id: string, v = 1): Item => ({ id, v });
const ids = (paged: PagedList<Item>): string =>
  paged
    .items()
    .map((i) => `${i.id}${String(i.v)}`)
    .join(' ');
const key = (i: Item): string => i.id;

describe('PagedList.refreshFirst', () => {
  it('reloads the newest page and keeps the older pages already opened', async () => {
    const { paged, cursors } = list(
      { items: [item('e'), item('d')], nextCursor: 'd' },
      { items: [item('c'), item('b')], nextCursor: 'b' },
      { items: [item('f'), item('e', 2)], nextCursor: 'e' },
    );
    await paged.refresh();
    await paged.more();
    await paged.refreshFirst(key);
    expect(ids(paged)).toBe('f1 e2 d1 c1 b1');
    expect(paged.hasMore()).toBe(true);
    expect(cursors).toEqual([undefined, 'd', undefined]);
  });

  it('falls back to a full refresh when new items no longer reach what is shown', async () => {
    const { paged } = list(
      { items: [item('b'), item('a')], nextCursor: 'a' },
      { items: [item('d'), item('c')], nextCursor: 'c' },
      { items: [item('d'), item('c')], nextCursor: 'c' },
    );
    await paged.refresh();
    await paged.refreshFirst(key);
    // Keeping b and a after d and c would hide the gap between them.
    expect(ids(paged)).toBe('d1 c1');
  });

  it('takes the newest page as the whole list when it is the last one', async () => {
    const { paged } = list(
      { items: [item('b'), item('a')], nextCursor: 'a' },
      { items: [item('b', 2)], nextCursor: null },
    );
    await paged.refresh();
    await paged.refreshFirst(key);
    expect(ids(paged)).toBe('b2');
    expect(paged.hasMore()).toBe(false);
  });

  it('keeps what is shown when the reload fails', async () => {
    const { paged } = list({ items: [item('b'), item('a')], nextCursor: 'a' });
    await paged.refresh();
    await paged.refreshFirst(key);
    expect(ids(paged)).toBe('b1 a1');
    expect(paged.state()).toBe('ready');
    expect(paged.problem()).toBe('This list could not be loaded.');
  });

  it('keeps an older page appended while the newest page was loading', async () => {
    let release: (page: Page) => void = () => undefined;
    const answers: (() => Promise<Page>)[] = [
      () => Promise.resolve({ items: [item('d'), item('c')], nextCursor: 'c' }),
      () => new Promise<Page>((resolve) => (release = resolve)),
      () => Promise.resolve({ items: [item('b'), item('a')], nextCursor: 'a' }),
    ];
    const paged = new PagedList<Item>(() => answers.shift()?.() ?? Promise.reject(new Error()));
    await paged.refresh();
    const newest = paged.refreshFirst(key);
    await paged.more();
    release({ items: [item('e'), item('d', 2)], nextCursor: 'd' });
    await newest;
    expect(ids(paged)).toBe('e1 d2 c1 b1 a1');
    expect(paged.hasMore()).toBe(true);
  });

  it('clears the list when access to it is lost, as a full refresh does', async () => {
    const answers: (() => Promise<Page>)[] = [
      () => Promise.resolve({ items: [item('b'), item('a')], nextCursor: 'a' }),
      () => Promise.reject(new IdentityRequestError(404)),
    ];
    const paged = new PagedList<Item>(() => answers.shift()?.() ?? Promise.reject(new Error()));
    await paged.refresh();
    await paged.refreshFirst(key);
    expect(ids(paged)).toBe('');
    expect(paged.state()).toBe('failed');
    expect(paged.denied()).toBe(true);
  });
});
