import type { DomainId, EdgeConfig, EdgeError, EventTopic } from '@slipway/contracts';
import type { Logger } from 'pino';
import type { Deps } from '../../deps.js';
import { ProblemError } from '../../lib/problem.js';
import { type CaddyAdmin, CaddyError, createCaddyAdmin } from './caddy.js';
import { type EdgeRenderInput, renderEdge } from './render.js';
import { loadEdgeInput } from './state.js';

/** Change-feed topics that can change the rendered configuration. */
const EDGE_TOPICS: ReadonlySet<EventTopic> = new Set([
  'routes',
  'domains',
  'settings',
  'deployments',
  'nodes',
  'apps',
]);

/** Domain states that become `active` once Caddy serves them. */
const ACTIVATABLE_DOMAIN_STATUSES: ReadonlySet<string> = new Set(['verified', 'dns_ok']);

const DEFAULT_DEBOUNCE_MS = 500;

/**
 * Callbacks into other modules after a successful load. The domains module provides
 * `markDomainActive`; the default does nothing.
 */
export interface EdgeHooks {
  /** A routed domain whose DNS preflight passed is now served by Caddy. Must be idempotent. */
  markDomainActive(domainId: DomainId): Promise<void>;
}

export const noopEdgeHooks: EdgeHooks = { markDomainActive: () => Promise.resolve() };

export interface EdgeReconciler {
  /** Subscribes to the change feed (debounced) and applies once now. Stops with the lifecycle. */
  start(hooks?: EdgeHooks): void;
  /**
   * Renders and loads the configuration now, serialized with other runs. Unchanged
   * configurations are not reloaded unless `force`. Throws a problem when Caddy fails.
   */
  apply(options?: { force?: boolean }): Promise<EdgeConfig>;
  /** The configuration as it would be rendered now, plus the last load state. */
  config(): Promise<EdgeConfig>;
}

export interface EdgeReconcilerOptions {
  caddy?: CaddyAdmin;
  debounceMs?: number;
  /** Replaces the database reader (tests). */
  loadInput?: () => Promise<EdgeRenderInput>;
}

type ReconcilerDeps = Pick<Deps, 'db' | 'config' | 'events' | 'logger' | 'lifecycle'>;

export function createEdgeReconciler(
  deps: ReconcilerDeps,
  options: EdgeReconcilerOptions = {},
): EdgeReconciler {
  const log: Logger = deps.logger.child({ component: 'edge' });
  const caddy = options.caddy ?? createCaddyAdmin(deps.config.caddyAdminUrl);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const loadInput = options.loadInput ?? (() => loadEdgeInput(deps));
  let hooks = noopEdgeHooks;
  let applied: { caddyfile: string; at: Date } | null = null;
  let lastError: EdgeError | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let started = false;

  function snapshot(caddyfile: string, renderedAt: Date): EdgeConfig {
    return {
      caddyfile,
      renderedAt: renderedAt.toISOString(),
      loadedAt: applied?.at.toISOString() ?? null,
      appliedCaddyfile: applied?.caddyfile ?? null,
      inSync: applied?.caddyfile === caddyfile,
      lastError,
    };
  }

  async function run(force: boolean): Promise<EdgeConfig> {
    const { caddyfile, rendered } = renderEdge(await loadInput());
    const renderedAt = new Date();
    if (!force && applied?.caddyfile === caddyfile) return snapshot(caddyfile, renderedAt);
    try {
      await caddy.load(caddyfile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = { message, at: new Date().toISOString() };
      log.error({ err: error }, 'loading the edge configuration failed');
      throw error instanceof CaddyError ? error.toProblem() : error;
    }
    applied = { caddyfile, at: new Date() };
    lastError = null;
    log.info({ sites: rendered.length }, 'edge configuration loaded');
    const activatable = new Set(
      rendered
        .filter((route) => ACTIVATABLE_DOMAIN_STATUSES.has(route.domain.status))
        .map((route) => route.domainId),
    );
    for (const domainId of activatable) {
      try {
        await hooks.markDomainActive(domainId);
      } catch (error) {
        log.warn({ err: error, domainId }, 'marking the domain active failed');
      }
    }
    return snapshot(caddyfile, renderedAt);
  }

  function apply(options: { force?: boolean } = {}): Promise<EdgeConfig> {
    const next = chain.then(() => run(options.force ?? false));
    chain = next.catch(() => undefined);
    return next;
  }

  function schedule(): void {
    if (deps.lifecycle.shuttingDown) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      apply().catch((error: unknown) => {
        // Load failures were logged in run(); anything else (e.g. the database) is logged here.
        if (!(error instanceof ProblemError)) {
          log.error({ err: error }, 'edge reconciliation failed');
        }
      });
    }, debounceMs);
    timer.unref();
  }

  return {
    start(startHooks = noopEdgeHooks) {
      hooks = startHooks;
      if (started) return;
      started = true;
      const unsubscribe = deps.events.subscribe((event) => {
        if (EDGE_TOPICS.has(event.topic)) schedule();
      });
      deps.lifecycle.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          unsubscribe();
        },
        { once: true },
      );
      schedule();
    },
    apply,
    async config() {
      const { caddyfile } = renderEdge(await loadInput());
      return snapshot(caddyfile, new Date());
    },
  };
}

const reconcilers = new WeakMap<object, EdgeReconciler>();

/**
 * The process-wide reconciler of a `Deps` instance, shared by the edge routes and the
 * composition root (which calls `start(hooks)`).
 */
export function edgeReconciler(deps: ReconcilerDeps): EdgeReconciler {
  let reconciler = reconcilers.get(deps);
  if (!reconciler) {
    reconciler = createEdgeReconciler(deps);
    reconcilers.set(deps, reconciler);
  }
  return reconciler;
}
