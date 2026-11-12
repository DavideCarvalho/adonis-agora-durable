import { DbAccessTokensProvider } from '@adonisjs/auth/access_tokens';
import { BaseModel, column } from '@adonisjs/lucid/orm';

export default class ServiceTenant extends BaseModel {
  @column({ isPrimary: true })
  declare id: number;

  /** The partition this tenant process acts as. */
  @column()
  declare partition: string;

  static accessTokens = DbAccessTokensProvider.forModel(ServiceTenant, {
    prefix: 'dtt_',
    type: 'durable_tenant',
  });
}
