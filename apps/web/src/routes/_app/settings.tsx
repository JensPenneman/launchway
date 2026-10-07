import type { UserRole } from '@launchway/contracts';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { Page, PageHeader } from '@/components/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AccountSection } from '@/features/settings/account-section';
import { DnsSection } from '@/features/settings/dns-section';
import { EdgeSection } from '@/features/settings/edge-section';
import { GitHubSection } from '@/features/settings/github-section';
import { PlatformSection } from '@/features/settings/platform-section';
import { TokensSection } from '@/features/settings/tokens-section';
import { UsersSection } from '@/features/settings/users-section';
import { useMe } from '@/hooks/use-me';
import { can } from '@/lib/roles';

const SECTIONS = [
  { id: 'account', label: 'Account', role: 'viewer', component: AccountSection },
  { id: 'tokens', label: 'API tokens', role: 'member', component: TokensSection },
  { id: 'users', label: 'Users & invitations', role: 'admin', component: UsersSection },
  { id: 'github', label: 'GitHub', role: 'admin', component: GitHubSection },
  { id: 'dns', label: 'DNS providers', role: 'admin', component: DnsSection },
  { id: 'platform', label: 'Platform', role: 'admin', component: PlatformSection },
  { id: 'edge', label: 'Edge', role: 'admin', component: EdgeSection },
] as const satisfies readonly {
  id: string;
  label: string;
  role: UserRole;
  component: ComponentType;
}[];

type SettingsTab = (typeof SECTIONS)[number]['id'];
const TAB_IDS: readonly string[] = SECTIONS.map((section) => section.id);

export const Route = createFileRoute('/_app/settings')({
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } =>
    typeof search.tab === 'string' && TAB_IDS.includes(search.tab)
      ? { tab: search.tab as SettingsTab }
      : {},
  component: SettingsPage,
});

function SettingsPage() {
  const { tab = 'account' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const me = useMe();
  const sections = SECTIONS.filter((section) => can(me, section.role));
  const active = sections.some((section) => section.id === tab) ? tab : 'account';
  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Your account and, for administrators, the platform."
      />
      <Tabs
        value={active}
        onValueChange={(value) =>
          void navigate({ search: { tab: value as SettingsTab }, replace: true })
        }
        className="flex flex-col gap-4"
      >
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList>
            {sections.map((section) => (
              <TabsTrigger key={section.id} value={section.id}>
                {section.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {sections.map(({ id, component: Section }) => (
          <TabsContent key={id} value={id}>
            <Section />
          </TabsContent>
        ))}
      </Tabs>
    </Page>
  );
}
