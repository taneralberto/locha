import { Module } from '@nestjs/common';
import { DataModule } from '../data/data.module';
import { AccountService } from './account.service';

@Module({
  imports: [DataModule],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountsModule {}
