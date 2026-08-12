import { Injectable, NotFoundException } from "@nestjs/common";
import { AuditAction } from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import {
  buildCustomerApplicationProfileReadiness,
  normalizeCustomerApplicationProfile
} from "../customer/customer-application-profile-readiness";
import {
  maskIdCardNo,
  normalizeIdCardNo,
  normalizeProfileText
} from "../customer/customer-identity-readiness";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentCustomer, PortalRequestContext } from "./portal-auth.types";
import { UpdatePortalProfileDto } from "./portal-profile.dto";

@Injectable()
export class PortalProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService
  ) {}

  async getProfile(currentCustomer: CurrentCustomer) {
    const customer = await this.findCustomer(currentCustomer.customerId);
    return toPortalProfileView(customer);
  }

  async updateProfile(
    dto: UpdatePortalProfileDto,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    const before = await this.findCustomer(currentCustomer.customerId);
    const validProfile = normalizeCustomerApplicationProfile({
      id: before.id,
      identity: {
        idCardNo: normalizeIdCardNo(dto.idCardNo) ?? before.identity?.idCardNo
      },
      mobile: currentCustomer.phone,
      name: normalizeProfileText(dto.name) ?? before.name,
      profile: {
        emergencyContactMobile:
          normalizeProfileText(dto.emergencyContactMobile) ??
          before.profile?.emergencyContactMobile,
        emergencyContactName:
          normalizeProfileText(dto.emergencyContactName) ?? before.profile?.emergencyContactName,
        residenceCity: normalizeProfileText(dto.residenceCity) ?? before.profile?.residenceCity,
        residenceDetail:
          normalizeProfileText(dto.residenceDetail) ?? before.profile?.residenceDetail,
        residenceDistrict:
          normalizeProfileText(dto.residenceDistrict) ?? before.profile?.residenceDistrict,
        residenceProvince:
          normalizeProfileText(dto.residenceProvince) ?? before.profile?.residenceProvince
      },
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
      await tx.customerProfile.upsert({
        create: {
          createdBy: currentCustomer.customerAccountId,
          customerId: currentCustomer.customerId,
          emergencyContactMobile: validProfile.emergencyContactMobile,
          emergencyContactName: validProfile.emergencyContactName,
          residenceAddress: validProfile.residenceAddress,
          residenceCity: validProfile.residenceCity,
          residenceDetail: validProfile.residenceDetail,
          residenceDistrict: validProfile.residenceDistrict,
          residenceProvince: validProfile.residenceProvince,
          updatedBy: currentCustomer.customerAccountId
        },
        update: {
          emergencyContactMobile: validProfile.emergencyContactMobile,
          emergencyContactName: validProfile.emergencyContactName,
          residenceAddress: validProfile.residenceAddress,
          residenceCity: validProfile.residenceCity,
          residenceDetail: validProfile.residenceDetail,
          residenceDistrict: validProfile.residenceDistrict,
          residenceProvince: validProfile.residenceProvince,
          updatedBy: currentCustomer.customerAccountId
        },
        where: { customerId: currentCustomer.customerId }
      });
      return tx.customer.findUniqueOrThrow({
        include: { identity: true, profile: true },
        where: { id: currentCustomer.customerId }
      });
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toPortalProfileView(customer),
      before: toPortalProfileView(before),
      entityId: currentCustomer.customerId,
      entityType: "customer_profile",
      ipAddress: context.ipAddress,
      module: "portal",
      operatorId: currentCustomer.customerAccountId,
      userAgent: context.userAgent
    });

    return toPortalProfileView(customer);
  }

  private async findCustomer(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      include: { identity: true, profile: true },
      where: { id: customerId }
    });
    if (!customer || customer.deletedAt) {
      throw new NotFoundException("Customer not found.");
    }
    return customer;
  }
}

function toPortalProfileView(customer: {
  id: string;
  identity: { idCardNo: null | string } | null;
  mobile: null | string;
  name: string;
  profile: {
    emergencyContactMobile: null | string;
    emergencyContactName: null | string;
    residenceAddress: null | string;
    residenceCity: null | string;
    residenceDetail: null | string;
    residenceDistrict: null | string;
    residenceProvince: null | string;
    updatedAt: Date;
  } | null;
  sourceChannel: null | string;
}) {
  const readiness = buildCustomerApplicationProfileReadiness(customer);
  const idCardNo = customer.identity?.idCardNo ?? null;
  return {
    emergencyContactMobile: customer.profile?.emergencyContactMobile ?? null,
    emergencyContactName: customer.profile?.emergencyContactName ?? null,
    idCardNoMasked: maskIdCardNo(idCardNo),
    idCardNoPresent: Boolean(idCardNo),
    missingProfileFields: readiness.missingFields,
    mobile: customer.mobile,
    name: customer.name,
    profileComplete: readiness.complete,
    profileUpdatedAt: customer.profile?.updatedAt.toISOString() ?? null,
    residenceAddress: customer.profile?.residenceAddress ?? null,
    residenceCity: customer.profile?.residenceCity ?? null,
    residenceDetail: customer.profile?.residenceDetail ?? null,
    residenceDistrict: customer.profile?.residenceDistrict ?? null,
    residenceProvince: customer.profile?.residenceProvince ?? null
  };
}
