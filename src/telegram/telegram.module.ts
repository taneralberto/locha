import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AccountService } from '../accounts/account.service';
import { AccountsModule } from '../accounts/account.module';
import { BudgetModule } from '../budgets/budget.module';
import { BudgetService } from '../budgets/budget.service';
import { DebtsModule } from '../debts/debt.module';
import { DebtService } from '../debts/debt.service';
import { SavingsModule } from '../savings/savings.module';
import { SavingsService } from '../savings/savings.service';
import { CaptureService } from '../capture/capture.service';
import { CaptureModule } from '../capture/capture.module';
import { InferenceBudgetService } from '../capture/inference-budget.service';
import { AiLimits, TelegramSettings } from '../config/configuration';
import { DataModule } from '../data/data.module';
import { TransactionRunner } from '../data/transaction.runner';
import { FinancialService } from '../financial/financial.service';
import { FinancialModule } from '../financial/financial.module';
import { TelegramApiClient, TelegramClient } from './telegram-client';
import { TelegramCommands } from './telegram-commands';
import { TelegramService } from './telegram.service';

/**
 * Bot de Telegram. El cliente real habla con la API oficial por HTTPS; la
 * configuracion decide si el bot queda activo (token, usuario y chat autorizados).
 */
@Module({
  imports: [DataModule, AccountsModule, CaptureModule, FinancialModule, BudgetModule, SavingsModule, DebtsModule],
  providers: [
    {
      provide: TelegramClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService): TelegramClient =>
        new TelegramApiClient(config.getOrThrow<TelegramSettings>('telegram')),
    },
    {
      provide: TelegramCommands,
      inject: [
        CaptureService,
        FinancialService,
        AccountService,
        InferenceBudgetService,
        ConfigService,
        BudgetService,
        SavingsService,
        DebtService,
      ],
      useFactory: (
        capture: CaptureService,
        financial: FinancialService,
        accounts: AccountService,
        budget: InferenceBudgetService,
        config: ConfigService,
        budgets: BudgetService,
        savings: SavingsService,
        debts: DebtService,
      ): TelegramCommands =>
        new TelegramCommands(
          capture,
          financial,
          accounts,
          budget,
          config.getOrThrow<AiLimits>('ai.limits'),
          budgets,
          savings,
          debts,
        ),
    },
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
