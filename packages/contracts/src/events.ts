import { JsonObject, Timestamp } from './common.js';
import { AppLogLine, DeploymentStatus, LogLine } from './deployments.js';
import { z } from './zod.js';

/** Topics of the platform-wide change feed (`GET /events`); the UI invalidates queries per topic. */
export const EVENT_TOPICS = [
  'apps',
  'deployments',
  'env',
  'nodes',
  'domains',
  'routes',
  'dns',
  'github',
  'settings',
  'users',
  'invitations',
  'tokens',
  /** The edge configuration was (or failed to be) loaded into Caddy. */
  'edge',
] as const;
export const EventTopic = z.enum(EVENT_TOPICS).openapi('EventTopic');
export type EventTopic = z.infer<typeof EventTopic>;

export const EVENT_ACTIONS = ['created', 'updated', 'deleted'] as const;
export const EventAction = z.enum(EVENT_ACTIONS).openapi('EventAction');
export type EventAction = z.infer<typeof EventAction>;

/** SSE `event:` names used by Launchway streams. */
export const SSE_EVENTS = {
  /** Change feed entry (`data`: PlatformEvent). */
  platform: 'platform',
  /** Log line (`data`: LogLine or AppLogLine). */
  log: 'log',
  /** Deployment status change (`data`: { status }). */
  status: 'status',
  /** Stream finished (`data`: { status } or { reason }). */
  end: 'end',
} as const;

/** Envelope of the change feed; carried in the `data:` field of `event: platform`. */
export const PlatformEvent = z
  .object({
    id: z.string().openapi({ description: 'Monotonic event id (also the SSE `id:`)' }),
    topic: EventTopic,
    action: EventAction,
    resourceId: z.string().nullable(),
    at: Timestamp,
    data: JsonObject.optional().openapi({
      description: 'Small hints such as a new status; never secrets',
    }),
  })
  .openapi('PlatformEvent');
export type PlatformEvent = z.infer<typeof PlatformEvent>;

/** Typed view of the deployment log stream (`GET /deployments/{id}/logs?follow=true`). */
export const DeploymentStreamEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('log'), data: LogLine }),
  z.object({ event: z.literal('status'), data: z.object({ status: DeploymentStatus }) }),
  z.object({ event: z.literal('end'), data: z.object({ status: DeploymentStatus }) }),
]);
export type DeploymentStreamEvent = z.infer<typeof DeploymentStreamEvent>;

/** Typed view of the app log stream (`GET /apps/{id}/logs?follow=true`). */
export const AppLogStreamEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('log'), data: AppLogLine }),
  z.object({
    event: z.literal('end'),
    data: z.object({ reason: z.enum(['completed', 'stopped', 'error']) }),
  }),
]);
export type AppLogStreamEvent = z.infer<typeof AppLogStreamEvent>;
