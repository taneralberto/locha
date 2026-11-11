import { Module } from '@nestjs/common';
import { DataModule } from '../data/data.module';
import { FinancialModule } from '../financial/financial.module';
import { DebtService } from './debt.service';

@Module({
  imports: [DataModule, FinancialModule],
  providers: [DebtService],
  exports: [DebtService],
})
export class DebtsModule {}
