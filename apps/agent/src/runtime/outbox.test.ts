import { generateId } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { Outbox } from './outbox.js';

const deploymentId = generateId('dep');

describe('Outbox', () => {
  it('keeps results while disconnected, drops log chunks, and flushes in order', () => {
    let connected = false;
    const sent: string[] = [];
    const outbox = new Outbox((message) => {
      if (!connected) return false;
      sent.push(message.type);
      return true;
    });
    outbox.send({
      id: '1',
      type: 'deployment.log',
      payload: {
        deploymentId,
        lines: [{ seq: 0, timestamp: new Date().toISOString(), stream: 'system', line: 'x' }],
      },
    });
    outbox.send({
      id: '1',
      type: 'deployment.result',
      payload: { deploymentId, outcome: 'cancelled' },
    });
    expect(outbox.pending).toBe(1);
    connected = true;
    outbox.flush();
    expect(sent).toEqual(['deployment.result']);
    outbox.send({ id: '2', type: 'logs.end', payload: { reason: 'completed' } });
    expect(sent).toEqual(['deployment.result', 'logs.end']);
  });
});
