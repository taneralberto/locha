import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AiLimits } from '../config/configuration';
import { DataModule } from '../data/data.module';
import { TransactionRunner } from '../data/transaction.runner';
import { FinancialModule } from '../financial/financial.module';
import { InterpreterModule } from '../interpreter/interpreter.module';
import { CaptureService } from './capture.service';
import { InferenceBudgetService } from './inference-budget.service';

/**
 * Captura durable de operaciones. No depende del transporte: recibe un evento con
 * identidad, conversacion, texto y marca de tiempo, y devuelve la respuesta al usuario.
 */
@Module({
  imports: [DataModule, FinancialModule, InterpreterModule],
  providers: [
    {
      provide: InferenceBudgetService,
      inject: [DataSource, TransactionRunner, ConfigService],
      useFactory: (
        dataSource: DataSource,
        transactions: TransactionRunner,
        config: ConfigService,
      ): InferenceBudgetService =>
        new InferenceBudgetService(dataSource, transactions, config.getOrThrow<AiLimits>('ai.limits')),
    },
    CaptureService,
  ],
  exports: [CaptureService, InferenceBudgetService],
})
export class CaptureModule {}
