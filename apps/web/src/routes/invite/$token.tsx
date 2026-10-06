import { createFileRoute } from '@tanstack/react-router';
import { AcceptInvitation } from '@/features/auth/accept-invitation';

/** `/invite/<token>`: same page as `/invite#<token>`, for links pasted without the fragment. */
export const Route = createFileRoute('/invite/$token')({
  component: function InviteByPath() {
    const { token } = Route.useParams();
    return <AcceptInvitation token={token} />;
  },
});
