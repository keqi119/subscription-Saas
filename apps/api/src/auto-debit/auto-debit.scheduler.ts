import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

type AutoDebitSchedulerDb = Pick<Prisma.TransactionClient, "subscriptionAutomationJob">;

interface SchedulableBill {
  dueDate: Date;
  id: string;
  orderId: string;
}

@Injectable()
export class AutoDebitScheduler {
  async enqueueForBill(
    _tx: AutoDebitSchedulerDb,
    _bill: SchedulableBill,
    _billingScheduleId?: string
  ) {
    return [];
  }

  async enqueueFutureForBill(
    _tx: AutoDebitSchedulerDb,
    _bill: SchedulableBill,
    _now: Date,
    _billingScheduleId?: string
  ) {
    return [];
  }
}
