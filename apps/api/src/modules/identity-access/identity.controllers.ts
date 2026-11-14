import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiBasicAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  CLIENT_SCOPES, PERMISSIONS, PERMISSION_GROUPS, apiClient, changePasswordRequest, clientCredentialsRequest, createApiClient, createIpAllowRule, createRole,
  createUser, ipAllowRule, issuedSecret, loginHistoryEntry, loginHistoryQuery, loginRequest, loginResponse, logoutRequest, me, mfaConfirmRequest,
  mfaConfirmResponse, mfaDisableRequest, mfaEnrolResponse, mfaVerifyRequest, pageOf, refreshRequest, resetPassword, role, rotateSecretRequest,
  setUserRoles, tokenResponse, updateApiClient, updateRole, updateUser, user, userQuery,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, AllowPendingPassword, Public, RequirePermissions, UsersOnly } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { ProblemException, zodErrors } from '../../common/problem';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { ApiClientsService } from './api-clients.service';
import { AuthService, clientInfo } from './auth.service';
import type { AuthedRequest } from './auth.guard';
import { TokenService } from './token.service';
import { UsersService } from './users.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Uuid = (name = 'id') => Param(name, ParseUUIDPipe);

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @ZResponse(loginResponse)
  login(@ZBody(loginRequest) dto: Q<typeof loginRequest>) {
    return this.auth.login(dto.username, dto.password, clientInfo());
  }

  @Post('mfa/verify')
  @Public()
  @HttpCode(200)
  @ZResponse(loginResponse)
  verifyMfa(@ZBody(mfaVerifyRequest) dto: Q<typeof mfaVerifyRequest>) {
    return this.auth.verifyMfa(dto.mfa_token, dto.code, clientInfo());
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @ZResponse(tokenResponse)
  refresh(@ZBody(refreshRequest) dto: Q<typeof refreshRequest>) {
    return this.auth.refresh(dto.refresh_token, clientInfo());
  }

  @Post('logout')
  @UsersOnly()
  @AllowPendingPassword()
  @HttpCode(204)
  @ZResponse(null, 204)
  logout(@Access() access: AccessProfile, @Req() req: AuthedRequest, @ZBody(logoutRequest) dto: Q<typeof logoutRequest>) {
    return this.auth.logout(access.actorId, req.tokenSid, dto.refresh_token);
  }

  @Get('me')
  @UsersOnly()
  @AllowPendingPassword()
  @ZResponse(me)
  me(@Access() access: AccessProfile) {
    return this.auth.me(access.actorId, access.permissions);
  }

  @Post('password')
  @UsersOnly()
  @AllowPendingPassword()
  @HttpCode(204)
  @ZResponse(null, 204)
  changePassword(@Access() access: AccessProfile, @ZBody(changePasswordRequest) dto: Q<typeof changePasswordRequest>) {
    return this.auth.changePassword(access.actorId, dto.current_password, dto.new_password);
  }

  @Post('mfa/enrol')
  @UsersOnly()
  @ZResponse(mfaEnrolResponse, 201)
  enrol(@Access() access: AccessProfile) {
    return this.auth.enrolMfa(access.actorId);
  }

  @Post('mfa/confirm')
  @UsersOnly()
  @HttpCode(200)
  @ZResponse(mfaConfirmResponse)
  confirm(@Access() access: AccessProfile, @ZBody(mfaConfirmRequest) dto: Q<typeof mfaConfirmRequest>) {
    return this.auth.confirmMfa(access.actorId, dto.code);
  }

  @Post('mfa/disable')
  @UsersOnly()
  @HttpCode(204)
  @ZResponse(null, 204)
  disable(@Access() access: AccessProfile, @ZBody(mfaDisableRequest) dto: Q<typeof mfaDisableRequest>) {
    return this.auth.disableMfa(access.actorId, dto.password);
  }
}

/** OAuth 2.0 token endpoint for machine clients (RFC 6749 §4.4) and the JWKS. */
@ApiTags('OAuth')
@Controller()
export class OAuthController {
  constructor(
    private readonly clients: ApiClientsService,
    private readonly tokens: TokenService,
  ) {}

  @Post('oauth/token')
  @Public()
  @HttpCode(200)
  @ApiBasicAuth()
  @ApiConsumes('application/x-www-form-urlencoded', 'application/json')
  @ApiBody({ schema: { type: 'object', required: ['grant_type'], properties: { grant_type: { type: 'string', enum: ['client_credentials'] }, client_id: { type: 'string' }, client_secret: { type: 'string' }, scope: { type: 'string' } } } })
  @ZResponse(tokenResponse)
  token(@Req() req: Request) {
    const parsed = clientCredentialsRequest.safeParse(req.body ?? {});
    if (!parsed.success) throw new ProblemException(400, 'unsupported_grant_type', 'Only grant_type=client_credentials is supported', zodErrors(parsed.error), { error: 'unsupported_grant_type' });
    let { client_id: id, client_secret: secret } = parsed.data;
    const basic = /^Basic\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1];
    if (basic) {
      const decoded = Buffer.from(basic, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      id = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    }
    return this.clients.token(id, secret, parsed.data.scope);
  }

  @Get('.well-known/jwks.json')
  @Public()
  jwks() {
    return this.tokens.jwks();
  }
}

@ApiTags('Users & roles')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @RequirePermissions('user:read')
  @ZResponse(pageOf(user))
  list(@ZQuery(userQuery) q: Q<typeof userQuery>) {
    return this.users.list(q);
  }

  @Get('users/:id')
  @RequirePermissions('user:read')
  @ZResponse(user)
  get(@Uuid() id: string) {
    return this.users.get(id);
  }

  @Post('users')
  @RequirePermissions('user:manage')
  @ZResponse(user, 201)
  create(@ZBody(createUser) dto: Q<typeof createUser>) {
    return this.users.create(dto);
  }

  @Patch('users/:id')
  @RequirePermissions('user:manage')
  @ApiIfMatch()
  @ZResponse(user)
  update(@Uuid() id: string, @ZBody(updateUser) dto: Q<typeof updateUser>, @IfMatch() v: number) {
    return this.users.update(id, dto, v);
  }

  @Put('users/:id/roles')
  @RequirePermissions('user:manage')
  @ZResponse(user)
  setRoles(@Uuid() id: string, @ZBody(setUserRoles) dto: Q<typeof setUserRoles>) {
    return this.users.setRoles(id, dto.roles);
  }

  @Post('users/:id/password')
  @RequirePermissions('user:manage')
  @HttpCode(204)
  @ZResponse(null, 204)
  resetPassword(@Uuid() id: string, @ZBody(resetPassword) dto: Q<typeof resetPassword>) {
    return this.users.resetPassword(id, dto.password);
  }

  @Post('users/:id/unlock')
  @RequirePermissions('user:manage')
  @HttpCode(204)
  @ZResponse(null, 204)
  unlock(@Uuid() id: string) {
    return this.users.unlock(id);
  }

  @Get('login-history')
  @RequirePermissions('login_history:read')
  @ZResponse(pageOf(loginHistoryEntry))
  loginHistory(@ZQuery(loginHistoryQuery) q: Q<typeof loginHistoryQuery>) {
    return this.users.loginHistory(q);
  }

  @Get('roles')
  @RequirePermissions('role:read')
  @ZResponse(z.array(role))
  roles() {
    return this.users.listRoles();
  }

  @Post('roles')
  @RequirePermissions('role:manage')
  @ZResponse(role, 201)
  createRole(@ZBody(createRole) dto: Q<typeof createRole>) {
    return this.users.createRole(dto);
  }

  @Patch('roles/:id')
  @RequirePermissions('role:manage')
  @ApiIfMatch()
  @ZResponse(role)
  updateRole(@Uuid() id: string, @ZBody(updateRole) dto: Q<typeof updateRole>, @IfMatch() v: number) {
    return this.users.updateRole(id, dto, v);
  }

  @Delete('roles/:id')
  @RequirePermissions('role:manage')
  @HttpCode(204)
  @ZResponse(null, 204)
  deleteRole(@Uuid() id: string) {
    return this.users.deleteRole(id);
  }

  @Get('permissions')
  @RequirePermissions('role:read')
  @ZResponse(z.object({ permissions: z.array(z.object({ code: z.string(), description: z.string() })), groups: z.array(z.object({ label: z.string(), prefixes: z.array(z.string()) })), client_scopes: z.array(z.object({ scope: z.string(), description: z.string() })) }))
  permissions() {
    return {
      permissions: Object.entries(PERMISSIONS).map(([code, description]) => ({ code, description })),
      groups: PERMISSION_GROUPS,
      client_scopes: Object.entries(CLIENT_SCOPES).map(([scope, v]) => ({ scope, description: v.description })),
    };
  }

  @Get('ip-allow-rules')
  @RequirePermissions('ip_allow:manage')
  @ZResponse(z.array(ipAllowRule))
  ipRules() {
    return this.users.listIpRules();
  }

  @Post('ip-allow-rules')
  @RequirePermissions('ip_allow:manage')
  @ZResponse(ipAllowRule, 201)
  createIpRule(@ZBody(createIpAllowRule) dto: Q<typeof createIpAllowRule>) {
    return this.users.createIpRule(dto);
  }

  @Delete('ip-allow-rules/:id')
  @RequirePermissions('ip_allow:manage')
  @HttpCode(204)
  @ZResponse(null, 204)
  deleteIpRule(@Uuid() id: string) {
    return this.users.deleteIpRule(id);
  }
}

@ApiTags('Integration: API clients')
@Controller('api-clients')
export class ApiClientsController {
  constructor(private readonly clients: ApiClientsService) {}

  @Get()
  @RequirePermissions('api_client:manage')
  @ZResponse(z.array(apiClient))
  list() {
    return this.clients.list();
  }

  @Get(':id')
  @RequirePermissions('api_client:manage')
  @ZResponse(apiClient)
  get(@Uuid() id: string) {
    return this.clients.get(id);
  }

  @Post()
  @RequirePermissions('api_client:manage')
  @ZResponse(z.object({ client: apiClient, client_secret: z.string() }), 201, 'Created. The secret is shown only in this response.')
  create(@ZBody(createApiClient) dto: Q<typeof createApiClient>) {
    return this.clients.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('api_client:manage')
  @ApiIfMatch()
  @ZResponse(apiClient)
  update(@Uuid() id: string, @ZBody(updateApiClient) dto: Q<typeof updateApiClient>, @IfMatch() v: number) {
    return this.clients.update(id, dto, v);
  }

  @Post(':id/secrets')
  @RequirePermissions('api_client:manage')
  @ZResponse(issuedSecret, 201, 'New secret, shown only in this response')
  rotate(@Uuid() id: string, @ZBody(rotateSecretRequest) dto: Q<typeof rotateSecretRequest>) {
    return this.clients.rotate(id, dto.previous_secret_grace_hours);
  }

  @Delete(':id/secrets/:secretId')
  @RequirePermissions('api_client:manage')
  @HttpCode(204)
  @ZResponse(null, 204)
  revoke(@Uuid() id: string, @Uuid('secretId') secretId: string) {
    return this.clients.revokeSecret(id, secretId);
  }
}
