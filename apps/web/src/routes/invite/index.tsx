import { createFileRoute } from '@tanstack/react-router';
import { AcceptInvitation } from '@/features/auth/accept-invitation';

/**
 * `/invite#<token>`: the link the API hands out. The token lives in the URL fragment, so it never
 * reaches server logs or Referer headers.
 */
export const Route = createFileRoute('/invite/')({
  component: function InviteByFragment() {
    const token = decodeURIComponent(window.location.hash.replace(/^#/, ''));
    return <AcceptInvitation token={token} />;
  },
});
