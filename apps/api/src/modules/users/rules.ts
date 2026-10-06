import { type AssignableRole, roleAtLeast, type UserId, type UserRole } from '@slipway/contracts';
import { forbidden } from '../../lib/problem.js';

export interface ManagingActor {
  readonly id: UserId;
  /** Effective role (tokens capped by scope). */
  readonly role: UserRole;
}

export interface ManagedUser {
  readonly id: UserId;
  readonly role: UserRole;
}

export type UserChange =
  | { readonly kind: 'update'; readonly name?: string; readonly role?: AssignableRole }
  | { readonly kind: 'delete' };

/**
 * Role rules for managing another account (spec section 7):
 * - admins manage members and viewers;
 * - only the owner manages admins (including granting or revoking the admin role);
 * - the owner cannot be demoted or deleted, and only the owner renames the owner.
 * Throws `forbidden` when the change is not allowed.
 */
export function assertCanManageUser(
  actor: ManagingActor,
  target: ManagedUser,
  change: UserChange,
): void {
  if (!roleAtLeast(actor.role, 'admin')) throw forbidden('Managing users requires the admin role');
  if (target.role === 'owner') {
    if (change.kind === 'delete') throw forbidden('The owner cannot be deleted');
    if (change.role !== undefined) throw forbidden('The owner cannot be demoted');
    if (actor.id !== target.id) throw forbidden('Only the owner can change the owner account');
    return;
  }
  const touchesAdmin =
    target.role === 'admin' || (change.kind === 'update' && change.role === 'admin');
  if (touchesAdmin && actor.role !== 'owner') {
    throw forbidden('Only the owner can manage admins');
  }
}

/** Roles an inviter may hand out: admins invite members and viewers, the owner also admins. */
export function assertCanInvite(actorRole: UserRole, role: AssignableRole): void {
  if (!roleAtLeast(actorRole, 'admin')) throw forbidden('Inviting users requires the admin role');
  if (role === 'admin' && actorRole !== 'owner') {
    throw forbidden('Only the owner can invite admins');
  }
}
