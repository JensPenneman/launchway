import type { AgentError, ServerToAgentMessage } from '@launchway/contracts';
import type { Logger } from 'pino';
import { type AppOps, ComposeCommandError } from './runtime/app-ops.js';
import type { DeploymentManager } from './runtime/deployments.js';
import type { LogStreamManager } from './runtime/log-streams.js';
import type { Send } from './runtime/outbox.js';

export type { Send } from './runtime/outbox.js';

type HandledMessage = Exclude<ServerToAgentMessage, { type: 'hello.ok' }>;

export interface RequestHandlerDeps {
  logger: Logger;
  send: Send;
  deployments: DeploymentManager;
  logStreams: LogStreamManager;
  apps: AppOps;
}

function toAgentError(error: unknown): AgentError {
  if (error instanceof ComposeCommandError) {
    return { code: 'internal-error', message: error.message.slice(0, 2000), retryable: true };
  }
  return { code: 'internal-error', message: 'Unexpected agent error', retryable: true };
}

/**
 * Dispatches server requests after the handshake (spec section 9). Every failure becomes an
 * `error` reply echoing the request id; nothing here may throw into the socket handler.
 */
export function createRequestHandler(deps: RequestHandlerDeps) {
  const { logger, send, deployments, logStreams, apps } = deps;

  const fail = (id: string, error: unknown, type: string) => {
    if (!(error instanceof ComposeCommandError))
      logger.error({ err: error, id, type }, 'request failed');
    send({ id, type: 'error', payload: toAgentError(error) });
  };

  /** Runs an async request; its rejection becomes an error reply. */
  const guard = (id: string, type: string, task: () => Promise<void>) => {
    task().catch((error: unknown) => fail(id, error, type));
  };

  return (message: HandledMessage): void => {
    try {
      switch (message.type) {
        case 'error':
          logger.warn({ code: message.payload.code, id: message.id }, message.payload.message);
          return;
        case 'deploy':
          deployments.deploy(message.id, message.payload);
          return;
        case 'deployment.cancel':
          if (!deployments.cancel(message.payload.deploymentId)) {
            send({
              id: message.id,
              type: 'error',
              payload: {
                code: 'not-found',
                message: 'No queued or running deployment with this id on this node',
                retryable: false,
              },
            });
          }
          return;
        case 'status':
          guard(message.id, message.type, async () => {
            const services = await apps.status(message.payload);
            send({
              id: message.id,
              type: 'app.status',
              payload: { appId: message.payload.appId, services },
            });
          });
          return;
        case 'stop':
          guard(message.id, message.type, async () => {
            await deployments.cancelApp(message.payload.appId);
            const services = await deployments.exclusive(message.payload.appId, () =>
              apps.stop(message.payload),
            );
            send({
              id: message.id,
              type: 'app.status',
              payload: { appId: message.payload.appId, services },
            });
          });
          return;
        case 'remove':
          guard(message.id, message.type, async () => {
            await deployments.cancelApp(message.payload.appId);
            logStreams.stopAll(message.payload.slug);
            await deployments.exclusive(message.payload.appId, () => apps.remove(message.payload));
            send({
              id: message.id,
              type: 'app.status',
              payload: { appId: message.payload.appId, services: [] },
            });
          });
          return;
        case 'logs.start':
          logStreams.start(message.id, message.payload);
          return;
        case 'logs.stop':
          if (!logStreams.stop(message.payload.streamId)) {
            send({
              id: message.id,
              type: 'error',
              payload: {
                code: 'not-found',
                message: 'No open log stream with this id',
                retryable: false,
              },
            });
          }
          return;
        default: {
          const unexpected: never = message;
          logger.warn({ type: (unexpected as { type: string }).type }, 'unhandled message');
        }
      }
    } catch (error) {
      fail(message.id, error, message.type);
    }
  };
}
