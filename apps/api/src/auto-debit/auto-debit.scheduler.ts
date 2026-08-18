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
    void _tx;
    void _bill;
    void _billingScheduleId;
    return [];
  }

  async enqueueFutureForBill(
    _tx: AutoDebitSchedulerDb,
    _bill: SchedulableBill,
    _now: Date,
    _billingScheduleId?: string
  ) {
    void _tx;
    void _bill;
    void _now;
    void _billingScheduleId;
    return [];
  }
}
