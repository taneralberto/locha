import { Module } from '@nestjs/common';
import { DataModule } from '../data/data.module';
import { FinancialService } from './financial.service';

@Module({
  imports: [DataModule],
  providers: [FinancialService],
  exports: [FinancialService],
})
export class FinancialModule {}
