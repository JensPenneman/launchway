import type { DeploymentStatus, DomainStatus, NodeStatus } from '@launchway/contracts';
import { cn } from '@/lib/utils';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONES: Record<Tone, string> = {
  success: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  danger: 'bg-destructive/12 text-destructive',
  info: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
  neutral: 'bg-muted text-muted-foreground',
};

const DOTS: Record<Tone, string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-destructive',
  info: 'bg-sky-500 animate-pulse',
  neutral: 'bg-muted-foreground/60',
};

export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', DOTS[tone])} aria-hidden="true" />
      {children}
    </span>
  );
}

const DEPLOYMENT_TONES: Record<DeploymentStatus, Tone> = {
  queued: 'info',
  cloning: 'info',
  building: 'info',
  starting: 'info',
  running: 'success',
  superseded: 'neutral',
  stopped: 'neutral',
  failed: 'danger',
  cancelled: 'warning',
};

export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <StatusBadge tone={DEPLOYMENT_TONES[status]} className="capitalize">
      {status}
    </StatusBadge>
  );
}

// `active`: the edge serves the domain (Caddy loaded its site and manages the certificate).
const DOMAIN_TONES: Record<DomainStatus, Tone> = {
  pending: 'warning',
  verified: 'success',
  active: 'success',
  misconfigured: 'danger',
};

export function DomainStatusBadge({ status }: { status: DomainStatus }) {
  return (
    <StatusBadge tone={DOMAIN_TONES[status]} className="capitalize">
      {status}
    </StatusBadge>
  );
}

const NODE_TONES: Record<NodeStatus, Tone> = {
  pending: 'warning',
  online: 'success',
  offline: 'danger',
};

export function NodeStatusBadge({ status }: { status: NodeStatus }) {
  return (
    <StatusBadge tone={NODE_TONES[status]} className="capitalize">
      {status}
    </StatusBadge>
  );
}
