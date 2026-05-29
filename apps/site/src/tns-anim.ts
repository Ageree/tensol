// Sthrip — IntersectionObserver wiring for [data-tns-reveal] / [data-tns-stagger]
// Flips data-in="1" on elements when they enter the viewport. CSS in
// styles.css does the rest. Mounted globally from main.tsx.

let observer: IntersectionObserver | null = null;

const SELECTOR = '[data-tns-reveal], [data-tns-stagger]';

const observeNew = (root: ParentNode = document): void => {
  if (!observer) return;
  root.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => {
    if (!el.dataset.in) observer!.observe(el);
  });
};

export const startTensolReveal = (): (() => void) => {
  if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
    return () => {};
  }

  if (observer) observer.disconnect();

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          (entry.target as HTMLElement).dataset.in = '1';
          observer!.unobserve(entry.target);
        }
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
  );

  observeNew();

  // Re-scan periodically so lazy-loaded routes pick up new reveal targets.
  const mutationObserver = new MutationObserver(() => observeNew());
  mutationObserver.observe(document.body, { childList: true, subtree: true });

  return () => {
    observer?.disconnect();
    observer = null;
    mutationObserver.disconnect();
  };
};
