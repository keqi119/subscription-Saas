import { Inject, Injectable } from "@nestjs/common";
import { Prisma, SubscriptionAutomationJobType } from "@prisma/client";

import { AutoDebitConfig } from "./auto-debit.config";
import { buildDebitRunSchedule, debitJobKey } from "./auto-debit.calendar";
import { AUTO_DEBIT_CONFIG } from "./auto-debit-provider";

type AutoDebitSchedulerDb = Pick<
  Prisma.TransactionClient,
  "subscriptionAutomationJob"
>;

interface SchedulableBill {
  dueDate: Date;
  id: string;
  orderId: string;
}

@Injectable()
export class AutoDebitScheduler {
  constructor(
    @Inject(AUTO_DEBIT_CONFIG)
    private readonly config: AutoDebitConfig
  ) {}

  enqueueForBill(
    tx: AutoDebitSchedulerDb,
    bill: SchedulableBill,
    billingScheduleId?: string
  ) {
    return this.enqueueSlots(tx, bill, billingScheduleId);
  }

  enqueueFutureForBill(
    tx: AutoDebitSchedulerDb,
    bill: SchedulableBill,
    now: Date,
    billingScheduleId?: string
  ) {
    return this.enqueueSlots(tx, bill, billingScheduleId, now);
  }

  private async enqueueSlots(
    tx: AutoDebitSchedulerDb,
    bill: SchedulableBill,
    billingScheduleId?: string,
    notBefore?: Date
  ) {
    if (!this.config.enabled) {
      return [];
    }
    const slots = buildDebitRunSchedule(bill.dueDate, this.config.runTime).filter(
      ({ availableAt }) => !notBefore || availableAt.getTime() >= notBefore.getTime()
    );
    const jobs = [];
    for (const slot of slots) {
      jobs.push(
        await tx.subscriptionAutomationJob.upsert({
          create: {
            availableAt: slot.availableAt,
            billId: bill.id,
            billingScheduleId,
            idempotencyKey: debitJobKey(bill.id, slot.retrySlot),
            jobType: SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
            orderId: bill.orderId,
            payload: {
              billId: bill.id,
              retrySlot: slot.retrySlot
            }
          },
          update: {},
          where: { idempotencyKey: debitJobKey(bill.id, slot.retrySlot) }
        })
      );
    }
    return jobs;
  }
}
