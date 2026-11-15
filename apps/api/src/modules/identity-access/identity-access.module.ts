import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganisationModule } from '../organisation/organisation.module';
import { AccessService } from './access.service';
import { ApiClient, ApiClientSecret } from './api-client.entities';
import { ApiClientsService } from './api-clients.service';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { ApiClientsController, AuthController, OAuthController, UsersController } from './identity.controllers';
import { IDENTITY_ENTITIES } from './identity.entities';
import { OidcController, OidcService } from './oidc';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([...IDENTITY_ENTITIES, ApiClient, ApiClientSecret]), OrganisationModule],
  providers: [OidcService, TokenService, AccessService, PasswordService, AuthService, UsersService, ApiClientsService, { provide: APP_GUARD, useClass: AuthGuard }],
  controllers: [OidcController, AuthController, OAuthController, UsersController, ApiClientsController],
  exports: [TokenService, AccessService, PasswordService, AuthService, UsersService, ApiClientsService],
})
export class IdentityAccessModule {}
