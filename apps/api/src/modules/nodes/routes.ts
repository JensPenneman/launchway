import { upgradeWebSocket } from '@hono/node-server';
import { createRoute, z } from '@hono/zod-openapi';
import {
  AGENT_WS_PATH,
  CreatedNode,
  CreateNodeInput,
  Node,
  NodeId,
  NodeJoinToken,
  NodeList,
  UpdateNodeInput,
} from '@slipway/contracts';
import type { Context } from 'hono';
import type { Api, AppEnv, Deps } from '../../deps.js';
import { requestActor, requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { badRequest, ProblemError, unauthorized } from '../../lib/problem.js';
import { NodeAgentGateway } from './gateway.js';
import { createNodesService } from './service.js';

const NodeParams = z.object({ id: NodeId });
const TAGS = ['Nodes'];

const listNodes = createRoute({
  method: 'get',
  path: '/nodes',
  operationId: 'listNodes',
  tags: TAGS,
  summary: 'List nodes',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: { 200: jsonResponse(NodeList, 'All nodes'), ...problemResponses(401, 403) },
});

const createNode = createRoute({
  method: 'post',
  path: '/nodes',
  operationId: 'createNode',
  tags: TAGS,
  summary: 'Add a node',
  description:
    'Creates the node and a one-time join token (valid 15 minutes, shown once) with ready-made `docker run` and Compose instructions for its agent. Requires the admin role. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { body: jsonBody(CreateNodeInput) },
  responses: {
    201: jsonResponse(CreatedNode, 'The new node and its join token'),
    ...problemResponses(400, 401, 403, 409),
  },
});

const getNode = createRoute({
  method: 'get',
  path: '/nodes/{id}',
  operationId: 'getNode',
  tags: TAGS,
  summary: 'Get a node',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: NodeParams },
  responses: { 200: jsonResponse(Node, 'The node'), ...problemResponses(400, 401, 403, 404) },
});

const updateNode = createRoute({
  method: 'patch',
  path: '/nodes/{id}',
  operationId: 'updateNode',
  tags: TAGS,
  summary: 'Rename a node',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: NodeParams, body: jsonBody(UpdateNodeInput) },
  responses: {
    200: jsonResponse(Node, 'The updated node'),
    ...problemResponses(400, 401, 403, 404, 409),
  },
});

const deleteNode = createRoute({
  method: 'delete',
  path: '/nodes/{id}',
  operationId: 'deleteNode',
  tags: TAGS,
  summary: 'Delete a node',
  description: 'Refused (409) while apps target the node. Disconnects its agent. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: NodeParams },
  responses: { 204: { description: 'Deleted' }, ...problemResponses(400, 401, 403, 404, 409) },
});

const createJoinToken = createRoute({
  method: 'post',
  path: '/nodes/{id}/join-token',
  operationId: 'createNodeJoinToken',
  tags: TAGS,
  summary: 'Issue a new join token',
  description:
    'Replaces any unused join token of the node. The token is single-use, valid for 15 minutes and shown once. Joining issues a new node credential and invalidates the previous one.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: NodeParams },
  responses: {
    201: jsonResponse(NodeJoinToken, 'The join token and agent instructions'),
    ...problemResponses(400, 401, 403, 404),
  },
});

const rotateCredential = createRoute({
  method: 'post',
  path: '/nodes/{id}/credential/rotate',
  operationId: 'rotateNodeCredential',
  tags: TAGS,
  summary: "Rotate the node's agent credential",
  description:
    'Issues a new credential and delivers it to the connected agent, which stores it. The agent must be online (409 otherwise).',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: NodeParams },
  responses: { 200: jsonResponse(Node, 'The node'), ...problemResponses(400, 401, 403, 404, 409) },
});

const revokeCredential = createRoute({
  method: 'post',
  path: '/nodes/{id}/credential/revoke',
  operationId: 'revokeNodeCredential',
  tags: TAGS,
  summary: "Revoke the node's agent credential",
  description:
    'Invalidates the credential and any join token and disconnects the agent. Rejoin with a new join token.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: NodeParams },
  responses: { 200: jsonResponse(Node, 'The node'), ...problemResponses(400, 401, 403, 404) },
});

/** Origin of the request, the fallback for the agent's server URL while no public URL is set. */
function requestOrigin(c: Context<AppEnv>): string {
  return new URL(c.req.url).origin;
}

export function registerNodesRoutes(api: Api, deps: Deps): void {
  const service = createNodesService(deps);

  api.openapi(listNodes, async (c) => c.json(await service.list(), 200));

  api.openapi(createNode, async (c) =>
    c.json(await service.create(c.req.valid('json'), requestActor(c), requestOrigin(c)), 201),
  );

  api.openapi(getNode, async (c) => c.json(await service.get(c.req.valid('param').id), 200));

  api.openapi(updateNode, async (c) =>
    c.json(
      await service.update(c.req.valid('param').id, c.req.valid('json'), requestActor(c)),
      200,
    ),
  );

  api.openapi(deleteNode, async (c) => {
    await service.remove(c.req.valid('param').id, requestActor(c));
    return c.body(null, 204);
  });

  api.openapi(createJoinToken, async (c) =>
    c.json(
      await service.issueJoinToken(c.req.valid('param').id, requestActor(c), requestOrigin(c)),
      201,
    ),
  );

  api.openapi(rotateCredential, async (c) =>
    c.json(await service.rotateCredential(c.req.valid('param').id, requestActor(c)), 200),
  );

  api.openapi(revokeCredential, async (c) =>
    c.json(await service.revokeCredential(c.req.valid('param').id, requestActor(c)), 200),
  );
}

const BEARER = /^Bearer\s+(\S+)$/i;
const WS_OPEN = 1;

/**
 * The agent WebSocket (`GET /api/agent/ws`, spec section 9) on the `api` mount. The upgrade is
 * authenticated before it happens: `Authorization: Bearer <join token | node credential>`.
 * Not part of the OpenAPI document.
 */
export function registerAgentSocketRoutes(api: Api, deps: Deps): void {
  api.get(AGENT_WS_PATH.replace(/^\/api/, ''), async (c) => {
    const gateway = deps.agents;
    if (!(gateway instanceof NodeAgentGateway)) {
      throw new ProblemError('service-unavailable', { detail: 'The agent gateway is not running' });
    }
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      throw badRequest('This endpoint only accepts WebSocket upgrades from node agents');
    }
    const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
    const auth = token ? await gateway.authenticate(token) : null;
    if (!auth) {
      c.var.logger.warn({ clientIp: c.var.clientIp }, 'agent socket refused: invalid token');
      throw unauthorized('Invalid or expired join token or node credential');
    }
    let handlers: ReturnType<NodeAgentGateway['accept']> | undefined;
    return upgradeWebSocket(c, {
      onOpen: (_event, ws) => {
        handlers = gateway.accept(auth, {
          send: (data) => {
            // `ws` silently drops frames on closing sockets; make that visible to the gateway.
            if (ws.readyState !== WS_OPEN) throw new Error('agent socket is not open');
            ws.send(data);
          },
          close: (code, reason) => ws.close(code, reason),
        });
      },
      onMessage: (event) => handlers?.onMessage(event.data),
      onClose: () => handlers?.onClose(),
      onError: () => handlers?.onClose(),
    });
  });
}
