import type { UserRole } from '@slipway/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Boxes,
  Globe,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  ScrollText,
  Server,
  Settings,
  UserRound,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { logout } from '@/api/auth';
import { type StreamState, useLiveEvents } from '@/api/events';
import { errorMessage } from '@/api/request';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMe } from '@/hooks/use-me';
import { livenessQuery } from '@/lib/api/queries';
import { can, effectiveRole } from '@/lib/roles';
import { cn } from '@/lib/utils';

const NAVIGATION = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, role: 'viewer' },
  { to: '/apps', label: 'Apps', icon: Boxes, role: 'viewer' },
  { to: '/domains', label: 'Domains', icon: Globe, role: 'viewer' },
  { to: '/nodes', label: 'Nodes', icon: Server, role: 'viewer' },
  { to: '/settings', label: 'Settings', icon: Settings, role: 'viewer' },
  { to: '/audit', label: 'Audit log', icon: ScrollText, role: 'admin' },
] as const satisfies readonly { to: string; label: string; icon: LucideIcon; role: UserRole }[];

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <img src="/favicon.svg" alt="" className="size-6" />
      Slipway
    </Link>
  );
}

const LIVE_LABELS: Record<StreamState, string> = {
  connecting: 'Connecting to live updates',
  live: 'Live updates on',
  ended: 'Live updates off',
  error: 'Live updates interrupted, retrying',
};

function LiveIndicator({ state }: { state: StreamState }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex size-8 items-center justify-center"
          role="status"
          aria-label={LIVE_LABELS[state]}
          data-state={state}
          data-testid="live-indicator"
        >
          <span
            className={cn(
              'size-2 rounded-full',
              state === 'live'
                ? 'bg-emerald-500'
                : state === 'error'
                  ? 'bg-amber-500'
                  : 'bg-muted-foreground/50',
            )}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{LIVE_LABELS[state]}</TooltipContent>
    </Tooltip>
  );
}

function UserMenu() {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  if (!me) return null;
  const signOut = async () => {
    try {
      await logout();
    } catch (error) {
      toast.error(errorMessage(error));
      return;
    }
    queryClient.clear();
    await navigate({ to: '/sign-in' });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Account menu">
          <UserRound />
          <span className="hidden max-w-40 truncate sm:inline">{me.user.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="flex flex-col">
          <span className="truncate">{me.user.name}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {me.user.email} · {effectiveRole(me)}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings" search={{ tab: 'account' }}>
            <UserRound /> Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Control-plane liveness and version, from the OpenAPI-generated client. */
function ApiStatus() {
  const liveness = useQuery(livenessQuery);
  return (
    <p className="mt-auto text-xs text-muted-foreground" data-testid="api-status">
      {liveness.isPending
        ? 'Checking the API…'
        : liveness.data
          ? `API online · ${liveness.data.version}`
          : 'API unreachable'}
    </p>
  );
}

/** Sidebar layout of every signed-in page (setup and sign-in render without it). */
export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const live = useLiveEvents(me !== undefined);
  const navigation = NAVIGATION.filter((item) => can(me, item.role));
  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col gap-6 border-r bg-sidebar p-4 text-sidebar-foreground md:flex">
        <Brand />
        <nav aria-label="Main" className="flex flex-col gap-1">
          {navigation.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: to === '/' }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground"
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </Link>
          ))}
        </nav>
        <ApiStatus />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b bg-background/90 px-4 backdrop-blur">
          <div className="flex items-center gap-2 md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Open navigation">
                  <Menu />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {navigation.map(({ to, label, icon: Icon }) => (
                  <DropdownMenuItem key={to} asChild>
                    <Link to={to}>
                      <Icon /> {label}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <LiveIndicator state={live} />
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main id="main" className="flex-1 p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
