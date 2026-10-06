export interface ParsedSseEvent {
  event: string;
  id?: string;
  data: unknown;
}

/** Parses a complete `text/event-stream` body (keep-alive comments are skipped). */
export function parseSse(text: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  for (const block of text.split(/\n\n+/)) {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    events.push({ event, ...(id === undefined ? {} : { id }), data: JSON.parse(data.join('\n')) });
  }
  return events;
}
