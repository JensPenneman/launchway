import { ArrowDown, Download } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StreamState } from '@/api/events';
import { Button } from '@/components/ui/button';
import { downloadText } from '@/lib/download';
import { cn } from '@/lib/utils';

export interface LogViewerLine {
  key: string | number;
  text: string;
  /** Shown before the text (service name, time). */
  prefix?: string;
  tone?: 'default' | 'error' | 'system';
}

const STATE_LABELS: Record<StreamState, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  ended: 'Finished',
  error: 'Disconnected',
};

interface LogViewerProps {
  lines: readonly LogViewerLine[];
  state: StreamState;
  filename: string;
  emptyText?: string;
  className?: string;
}

/** Terminal-style log view that follows new lines until the user scrolls up. */
export function LogViewer({ lines, state, filename, emptyText, className }: LogViewerProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (follow && element && lines.length > 0) element.scrollTop = element.scrollHeight;
  }, [lines, follow]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onScroll = () => {
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      setFollow(atBottom);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  const download = () =>
    downloadText(
      filename,
      lines.map((line) => (line.prefix ? `${line.prefix} ${line.text}` : line.text)).join('\n'),
    );

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5" data-testid="log-state">
          <span
            className={cn(
              'size-1.5 rounded-full',
              state === 'live' && 'animate-pulse bg-emerald-500',
              state === 'connecting' && 'bg-amber-500',
              state === 'ended' && 'bg-muted-foreground',
              state === 'error' && 'bg-destructive',
            )}
            aria-hidden="true"
          />
          {STATE_LABELS[state]} · {lines.length} {lines.length === 1 ? 'line' : 'lines'}
        </span>
        <div className="flex gap-1">
          {!follow && (
            <Button variant="ghost" size="sm" onClick={() => setFollow(true)}>
              <ArrowDown /> Follow
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={download} disabled={lines.length === 0}>
            <Download /> Download
          </Button>
        </div>
      </div>
      <div
        ref={scroller}
        role="log"
        aria-live="off"
        aria-label="Log output"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable log must be reachable by keyboard
        tabIndex={0}
        className="min-h-48 flex-1 overflow-auto rounded-lg border bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {lines.length === 0 ? (
          <p className="text-zinc-400">
            {state === 'connecting' ? 'Waiting for output…' : (emptyText ?? 'No output.')}
          </p>
        ) : (
          lines.map((line) => (
            <div
              key={line.key}
              className={cn(
                'whitespace-pre-wrap [overflow-wrap:anywhere]',
                line.tone === 'error' && 'text-red-300',
                line.tone === 'system' && 'text-sky-300',
              )}
            >
              {line.prefix && <span className="mr-2 text-zinc-500 select-none">{line.prefix}</span>}
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
