import type { AgentToServerMessage, ServerToAgentMessage } from '@slipway/contracts';
import type { Logger } from 'pino';

export type Send = (message: AgentToServerMessage) => void;

type RequestMessage = Exclude<ServerToAgentMessage, { type: 'hello.ok' | 'error' }>;

function notImplemented(message: RequestMessage): AgentToServerMessage {
  return {
    id: message.id,
    type: 'error',
    payload: {
      code: 'not-implemented',
      message: `"${message.type}" is not implemented by this agent yet`,
      retryable: false,
    },
  };
}

/**
 * Handles server requests after the handshake. TODO(agent): implement deploy (clone, policy check,
 * compose build/pull/up with streamed logs), deployment.cancel, stop, remove, status and logs.
 * Until then every request is answered with a `not-implemented` error echoing its id.
 */
export function createRequestHandler(logger: Logger, send: Send) {
  return (message: RequestMessage | Extract<ServerToAgentMessage, { type: 'error' }>): void => {
    switch (message.type) {
      case 'error':
        logger.warn({ code: message.payload.code, id: message.id }, message.payload.message);
        return;
      case 'deploy':
      case 'deployment.cancel':
      case 'stop':
      case 'remove':
      case 'status':
      case 'logs.start':
      case 'logs.stop':
        logger.warn({ id: message.id, type: message.type }, 'request not implemented yet');
        send(notImplemented(message));
        return;
      default: {
        const unexpected: never = message;
        logger.warn({ message: unexpected }, 'unhandled message');
      }
    }
  };
}
