import {
  AppLogLine,
  DeploymentStatus,
  type EventTopic,
  LogLine,
  PlatformEvent,
  SSE_EVENTS,
  z,
} from '@slipway/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { keysForTopic } from './keys';
import { buildUrl } from './request';

export type StreamState = 'connecting' | 'live' | 'ended' | 'error';

/** Parses the JSON `data:` of an SSE message with a contract schema; null when malformed. */
export function parseEventData<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const INVALIDATION_DELAY_MS = 250;
const RECONNECT_DELAY_MS = 5_000;

/**
 * Subscribes to the platform change feed (`GET /events`) and invalidates the query families of
 * each changed topic. Bursts are coalesced; the browser reconnects on its own after errors.
 */
export function useLiveEvents(enabled = true): StreamState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>('connecting');

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<EventTopic>();

    const flush = () => {
      flushTimer = undefined;
      const queryKeys = [...pending].flatMap(keysForTopic);
      pending.clear();
      for (const queryKey of queryKeys) void queryClient.invalidateQueries({ queryKey });
    };

    const connect = () => {
      source = new EventSource(buildUrl('/events'), { withCredentials: true });
      source.addEventListener('open', () => setState('live'));
      source.addEventListener(SSE_EVENTS.platform, (event) => {
        const parsed = parseEventData(PlatformEvent, (event as MessageEvent).data);
        if (!parsed) return;
        pending.add(parsed.topic);
        flushTimer ??= setTimeout(flush, INVALIDATION_DELAY_MS);
      });
      source.addEventListener('error', () => {
        setState('error');
        if (source?.readyState === EventSource.CLOSED) {
          source = null;
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      });
    };
    connect();

    return () => {
      source?.close();
      clearTimeout(reconnectTimer);
      clearTimeout(flushTimer);
    };
  }, [enabled, queryClient]);

  return state;
}

const MAX_LINES = 10_000;
const FLUSH_INTERVAL_MS = 100;

interface LogStreamResult<Line> {
  lines: Line[];
  state: StreamState;
}

/**
 * Generic follower of a log stream: buffers `log` events and renders them in batches, stops on
 * `end`. `onEvent` receives the other named events (`status`, ...).
 */
function useLogStream<Line>(
  url: string | null,
  lineSchema: z.ZodType<Line>,
  options: {
    isDuplicate?: (line: Line, last: Line | undefined) => boolean;
    onEvent?: (name: string, data: unknown) => void;
    events?: readonly string[];
  } = {},
): LogStreamResult<Line> {
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    setLines([]);
    if (!url) return;
    setState('connecting');
    const buffer: Line[] = [];
    let last: Line | undefined;
    let ended = false;
    const source = new EventSource(url, { withCredentials: true });

    const flush = () => {
      if (buffer.length === 0) return;
      const batch = buffer.splice(0);
      setLines((current) => {
        const next = current.concat(batch);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    const timer = setInterval(flush, FLUSH_INTERVAL_MS);

    source.addEventListener('open', () => setState('live'));
    source.addEventListener(SSE_EVENTS.log, (event) => {
      const line = parseEventData(lineSchema, (event as MessageEvent).data);
      if (!line || optionsRef.current.isDuplicate?.(line, last)) return;
      last = line;
      buffer.push(line);
    });
    for (const name of optionsRef.current.events ?? []) {
      source.addEventListener(name, (event) => {
        let data: unknown = null;
        try {
          data = JSON.parse(String((event as MessageEvent).data));
        } catch {
          // Ignore malformed payloads.
        }
        optionsRef.current.onEvent?.(name, data);
      });
    }
    source.addEventListener(SSE_EVENTS.end, (event) => {
      ended = true;
      optionsRef.current.onEvent?.(SSE_EVENTS.end, safeJson((event as MessageEvent).data));
      source.close();
      flush();
      setState('ended');
    });
    source.addEventListener('error', () => {
      if (ended) return;
      // The browser retries while the connection is merely interrupted.
      setState(source.readyState === EventSource.CLOSED ? 'error' : 'connecting');
    });

    return () => {
      source.close();
      clearInterval(timer);
    };
  }, [url, lineSchema]);

  return { lines, state };
}

function safeJson(raw: unknown): unknown {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const StatusPayload = z.object({ status: DeploymentStatus });

/** Live log of one deployment (`GET /deployments/{id}/logs?follow=true`), deduplicated by `seq`. */
export function useDeploymentLogStream(url: string | null) {
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const stream = useLogStream(url, LogLine, {
    isDuplicate: (line, last) => last !== undefined && line.seq <= last.seq,
    events: [SSE_EVENTS.status],
    onEvent: (_name, data) => {
      const parsed = StatusPayload.safeParse(data);
      if (parsed.success) setStatus(parsed.data.status);
    },
  });
  return { ...stream, status };
}

/** Live container logs of an app (`GET /apps/{id}/logs?follow=true`). */
export function useAppLogStream(url: string | null) {
  return useLogStream(url, AppLogLine);
}
