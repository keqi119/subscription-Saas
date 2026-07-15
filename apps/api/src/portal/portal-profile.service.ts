import { Injectable, NotFoundException } from "@nestjs/common";

import {
  assertCustomerIdentityProfileReady,
  assertPortalProfileMobileMatchesLogin,
  assertValidCustomerApplicationIdentityInput,
  buildCustomerIdentityProfileReadiness,
  maskIdCardNo,
  normalizeIdCardNo,
  normalizeMobile,
  normalizeCustomerApplicationIdentityInput
} from "../customer/customer-identity-readiness";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentCustomer, PortalRequestContext } from "./portal-auth.types";
import { UpdatePortalProfileDto } from "./portal-profile.dto";

@Injectable()
export class PortalProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(currentCustomer: CurrentCustomer) {
    const customer = await this.findCustomer(currentCustomer.customerId);
    return toPortalProfileView(customer);
  }

  async updateProfile(
    dto: UpdatePortalProfileDto,
    currentCustomer: CurrentCustomer,
    _context: PortalRequestContext
  ) {
    const before = await this.findCustomer(currentCustomer.customerId);
    const mobile = normalizeMobile(dto.mobile) ?? normalizeMobile(currentCustomer.phone);
    assertPortalProfileMobileMatchesLogin(mobile, currentCustomer.phone);
    const merged = {
      idCardNo: normalizeIdCardNo(dto.idCardNo) ?? normalizeIdCardNo(before.identity?.idCardNo),
      mobile,
      name: normalizeCustomerApplicationIdentityInput({ name: dto.name ?? before.name }).name
    };
    const validProfile = assertValidCustomerApplicationIdentityInput(merged);
    assertCustomerIdentityProfileReady({
      identity: { idCardNo: validProfile.idCardNo },
      mobile: validProfile.mobile,
      name: validProfile.name,
      sourceChannel: before.sourceChannel
    });

    const customer = await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({
        data: {
          mobile: validProfile.mobile,
          name: validProfile.name,
          updatedBy: currentCustomer.customerAccountId
        },
        where: { id: currentCustomer.customerId }
      });
      await tx.customerIdentity.upsert({
        create: {
          createdBy: currentCustomer.customerAccountId,
          customerId: currentCustomer.customerId,
          idCardNo: validProfile.idCardNo,
          updatedBy: currentCustomer.customerAccountId
        },
        update: {
          idCardNo: validProfile.idCardNo,
          updatedBy: currentCustomer.customerAccountId
        },
        where: { customerId: currentCustomer.customerId }
      });
      return tx.customer.findUniqueOrThrow({
        include: { identity: true },
        where: { id: currentCustomer.customerId }
      });
    });

    return toPortalProfileView(customer);
  }

  private async findCustomer(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      include: { identity: true },
      where: { id: customerId }
    });
    if (!customer || customer.deletedAt) {
      throw new NotFoundException("Customer not found.");
    }
    return customer;
  }
}

function toPortalProfileView(customer: {
  identity: { idCardNo: null | string } | null;
  mobile: null | string;
  name: string;
  sourceChannel: null | string;
}) {
  const readiness = buildCustomerIdentityProfileReadiness(customer);
  const idCardNo = customer.identity?.idCardNo ?? null;
  return {
    idCardNoMasked: maskIdCardNo(idCardNo),
    idCardNoPresent: Boolean(idCardNo),
    missingProfileFields: readiness.missingFields,
    mobile: customer.mobile,
    name: customer.name,
    profileComplete: readiness.complete
  };
}
