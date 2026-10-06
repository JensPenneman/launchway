import { Link } from '@tanstack/react-router';
import { Boxes, Globe, LayoutDashboard, Menu, ScrollText, Server, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const NAVIGATION = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/apps', label: 'Apps', icon: Boxes },
  { to: '/domains', label: 'Domains', icon: Globe },
  { to: '/nodes', label: 'Nodes', icon: Server },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/audit', label: 'Audit log', icon: ScrollText },
] as const;

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <img src="/favicon.svg" alt="" className="size-6" />
      Slipway
    </Link>
  );
}

/** Sidebar layout of every signed-in page (setup and sign-in render without it). */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r bg-sidebar p-4 text-sidebar-foreground md:flex">
        <Brand />
        <nav aria-label="Main" className="flex flex-col gap-1">
          {NAVIGATION.map(({ to, label, icon: Icon }) => (
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
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-2 border-b px-4">
          <div className="flex items-center gap-2 md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Open navigation">
                  <Menu />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {NAVIGATION.map(({ to, label, icon: Icon }) => (
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
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
