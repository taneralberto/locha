import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AccountsModule } from '../accounts/account.module';
import { CaptureModule } from '../capture/capture.module';
import { TelegramSettings } from '../config/configuration';
import { DataModule } from '../data/data.module';
import { TransactionRunner } from '../data/transaction.runner';
import { FinancialModule } from '../financial/financial.module';
import { TelegramApiClient, TelegramClient } from './telegram-client';
import { TelegramCommands } from './telegram-commands';
import { TelegramService } from './telegram.service';

/**
 * Bot de Telegram. El cliente real habla con la API oficial por HTTPS; la
 * configuracion decide si el bot queda activo (token, usuario y chat autorizados).
 */
@Module({
  imports: [DataModule, AccountsModule, CaptureModule, FinancialModule],
  providers: [
    {
      provide: TelegramClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService): TelegramClient =>
        new TelegramApiClient(config.getOrThrow<TelegramSettings>('telegram')),
    },
    TelegramCommands,
    {
      provide: TelegramService,
      inject: [DataSource, TransactionRunner, TelegramCommands, TelegramClient, ConfigService],
      useFactory: (
        dataSource: DataSource,
        transactions: TransactionRunner,
        commands: TelegramCommands,
        client: TelegramClient,
        config: ConfigService,
      ): TelegramService =>
        new TelegramService(
          dataSource,
          transactions,
          commands,
          client,
          config.getOrThrow<TelegramSettings>('telegram'),
        ),
    },
  ],
  exports: [TelegramService, TelegramCommands],
})
export class TelegramModule {}
