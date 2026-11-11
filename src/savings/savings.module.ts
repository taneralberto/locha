import { Module } from '@nestjs/common';
import { DataModule } from '../data/data.module';
import { FinancialModule } from '../financial/financial.module';
import { GoalService } from './goal.service';
import { SavingsService } from './savings.service';

@Module({
  imports: [DataModule, FinancialModule],
  providers: [GoalService, SavingsService],
  exports: [GoalService, SavingsService],
})
export class SavingsModule {}
