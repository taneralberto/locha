import { Module } from '@nestjs/common';
import { DataModule } from '../data/data.module';
import { FinancialModule } from '../financial/financial.module';
import { BudgetService } from './budget.service';

@Module({
  imports: [DataModule, FinancialModule],
  providers: [BudgetService],
  exports: [BudgetService],
})
export class BudgetModule {}
