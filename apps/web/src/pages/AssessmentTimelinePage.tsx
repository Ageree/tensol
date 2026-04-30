import { useInfiniteQuery } from '@tanstack/react-query';
import { type VirtualItem, useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { type TimelineItem, getTimelinePage } from '../api/timeline.ts';

interface Props {
  assessmentId: string;
  kind?: 'audit' | 'browser' | 'all';
}

export const AssessmentTimelinePage = ({ assessmentId, kind = 'all' }: Props) => {
  const parentRef = useRef<HTMLDivElement>(null);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['assessment-timeline-extended', assessmentId, kind],
    queryFn: ({ pageParam }) => getTimelinePage(assessmentId, kind, pageParam as string | null),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const allItems: TimelineItem[] = data?.pages.flatMap((p) => p.items) ?? [];

  const virtualizer = useVirtualizer({
    count: hasNextPage ? allItems.length + 1 : allItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 300;
    if (nearBottom && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  };

  if (isLoading) return <p data-testid="timeline-loading">Loading timeline…</p>;

  return (
    <div data-testid="assessment-timeline-page">
      <h2>Timeline</h2>
      <div
        ref={parentRef}
        onScroll={handleScroll}
        style={{ height: '600px', overflowY: 'auto' }}
        data-testid="timeline-scroll-container"
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
          {virtualItems.map((vi: VirtualItem) => {
            const isLoader = vi.index >= allItems.length;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {isLoader ? (
                  <p data-testid="timeline-load-more">Loading more…</p>
                ) : (
                  <div data-testid={`timeline-item-${allItems[vi.index]?.id}`}>
                    <span>{allItems[vi.index]?.occurredAt}</span>
                    {' — '}
                    <span>{allItems[vi.index]?.action}</span>
                    {' — '}
                    <span>{allItems[vi.index]?.kind}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {isFetchingNextPage && <p data-testid="timeline-fetching">Fetching more…</p>}
    </div>
  );
};
