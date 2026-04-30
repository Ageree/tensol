import type { Page } from 'playwright';
import { z } from 'zod';
import type { ActInput, BrowserDriverFacade, ExtractResult, ObserveResult } from './types.ts';

const ActInputSchema = z.object({
  action: z.enum(['click', 'fill', 'navigate']),
  selector: z.string().optional(),
  value: z.string().optional(),
});

export class PlaywrightBrowserDriverFacade implements BrowserDriverFacade {
  constructor(private readonly scopeGuard?: (url: string) => Promise<void>) {}

  async act(page: unknown, input: ActInput): Promise<void> {
    const p = page as Page;
    const validated = ActInputSchema.parse(input);

    switch (validated.action) {
      case 'navigate': {
        const url = validated.value ?? '';
        if (this.scopeGuard) {
          await this.scopeGuard(url);
        }
        await p.goto(url);
        break;
      }
      case 'click': {
        if (validated.selector) {
          await p.locator(validated.selector).click();
        }
        break;
      }
      case 'fill': {
        if (validated.selector && validated.value !== undefined) {
          await p.locator(validated.selector).fill(validated.value);
        }
        break;
      }
    }
  }

  async observe(page: unknown): Promise<ObserveResult> {
    const p = page as Page;
    const elements = await p.locator('a, button, input, [role]').all();
    const results = await Promise.all(
      elements.map(async (el) => {
        const roleAttr = await el.getAttribute('role');
        const base = {
          selector: (await el.evaluate((node) => {
            const tag = node.tagName.toLowerCase();
            const id = (node as HTMLElement).id ? `#${(node as HTMLElement).id}` : '';
            return `${tag}${id}`;
          })) as string,
          text: (await el.textContent()) ?? '',
        };
        return roleAttr !== null ? { ...base, role: roleAttr } : base;
      }),
    );
    return { elements: results, url: p.url() };
  }

  async extract(
    page: unknown,
    schema: { parse: (data: unknown) => unknown },
  ): Promise<ExtractResult> {
    const p = page as Page;
    const raw = await p.evaluate(() => {
      return {
        title: document.title,
        url: window.location.href,
        headings: Array.from(document.querySelectorAll('h1,h2,h3')).map((h) => h.textContent),
        links: Array.from(document.querySelectorAll('a[href]')).map(
          (a) => (a as HTMLAnchorElement).href,
        ),
      };
    });
    const data = schema.parse(raw) as Record<string, unknown>;
    return { data, url: p.url() };
  }
}
