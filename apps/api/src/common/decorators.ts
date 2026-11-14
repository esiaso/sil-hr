import { SetMetadata, applyDecorators, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse } from '@nestjs/swagger';
import type { PermissionCode } from '@sil/hr-shared';
import type { AccessProfile } from './access';

export const IS_PUBLIC_KEY = 'hr:public';
export const PERMISSIONS_KEY = 'hr:permissions';
export const ALLOW_PENDING_PASSWORD_KEY = 'hr:allowPendingPassword';
export const USERS_ONLY_KEY = 'hr:usersOnly';

/** No authentication required. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * The caller must hold every listed permission (users through roles, machine clients
 * through scopes). Data scope for the permission is then resolved by ScopeService.
 */
export const RequirePermissions = (...permissions: PermissionCode[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    ApiBearerAuth(),
    ApiForbiddenResponse({ description: `Requires: ${permissions.join(', ')}` }),
  );

/** Reachable before a forced password change (me, change password, logout). */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);

/** Only interactive users, never machine clients (account settings, MFA). */
export const UsersOnly = () => SetMetadata(USERS_ONLY_KEY, true);

/** The resolved access profile of the caller. */
export const Access = createParamDecorator((_data: unknown, ctx: ExecutionContext): AccessProfile => {
  return ctx.switchToHttp().getRequest().access;
});
