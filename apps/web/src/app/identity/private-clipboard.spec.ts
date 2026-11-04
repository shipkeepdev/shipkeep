import { TestBed } from '@angular/core/testing';

import { PRIVATE_CLIPBOARD, PrivateClipboard } from './private-clipboard';

describe('private clipboard feedback', () => {
  it('copies only on request and never forwards raw clipboard errors', async () => {
    const write = vi.fn<(value: string) => Promise<void>>();
    TestBed.configureTestingModule({
      providers: [PrivateClipboard, { provide: PRIVATE_CLIPBOARD, useValue: write }],
    });
    const clipboard = TestBed.inject(PrivateClipboard);
    expect(write).not.toHaveBeenCalled();
    write.mockRejectedValueOnce(new Error('private clipboard fixture'));
    await clipboard.copy('private fixture');
    expect(write).toHaveBeenCalledWith('private fixture');
    expect(clipboard.message()).toContain('copy it manually');
    expect(clipboard.message()).not.toContain('fixture');
    write.mockResolvedValue();
    await clipboard.copy('private fixture');
    expect(clipboard.message()).toContain('Copied');
    clipboard.reset();
    expect(clipboard.message()).toBeNull();
  });
  it('ignores a late copy result after the page is destroyed', async () => {
    let finish: (() => void) | undefined;
    const write = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    TestBed.configureTestingModule({
      providers: [PrivateClipboard, { provide: PRIVATE_CLIPBOARD, useValue: write }],
    });
    const clipboard = TestBed.inject(PrivateClipboard);
    const pending = clipboard.copy('private fixture');
    TestBed.resetTestingModule();
    finish?.();
    await pending;
    expect(clipboard.message()).toBeNull();
  });
});
