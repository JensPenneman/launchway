import { generateId } from '@launchway/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createDeferredDeploymentSink, type DeploymentSink } from './agent-gateway.js';

describe('deferred deployment sink', () => {
  const nodeId = generateId('node');
  const progress = { deploymentId: generateId('dep'), status: 'cloning' as const };

  it('drops reports until a target is bound, then forwards every call', async () => {
    const deferred = createDeferredDeploymentSink();
    await expect(deferred.sink.onProgress(nodeId, progress)).resolves.toBeUndefined();

    const target: DeploymentSink = {
      onProgress: vi.fn(() => Promise.resolve()),
      onLog: vi.fn(() => Promise.resolve()),
      onResult: vi.fn(() => Promise.resolve()),
      onAppStatus: vi.fn(() => Promise.resolve()),
      onNodeOffline: vi.fn(() => Promise.resolve()),
      onNodeOnline: vi.fn(() => Promise.resolve()),
    };
    deferred.bind(target);
    await deferred.sink.onProgress(nodeId, progress);
    await deferred.sink.onNodeOffline(nodeId);
    await deferred.sink.onNodeOnline?.(nodeId);
    expect(target.onProgress).toHaveBeenCalledWith(nodeId, progress);
    expect(target.onNodeOffline).toHaveBeenCalledWith(nodeId);
    expect(target.onNodeOnline).toHaveBeenCalledWith(nodeId);
  });

  it('tolerates a target without the optional node-online hook', async () => {
    const deferred = createDeferredDeploymentSink();
    const resolved = () => Promise.resolve();
    deferred.bind({
      onProgress: resolved,
      onLog: resolved,
      onResult: resolved,
      onAppStatus: resolved,
      onNodeOffline: resolved,
    });
    await expect(deferred.sink.onNodeOnline?.(nodeId)).resolves.toBeUndefined();
  });
});
