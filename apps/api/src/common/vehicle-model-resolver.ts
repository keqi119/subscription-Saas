import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import {
  trackVehicleModelExternalContractWarning,
  trackVehicleModelUsage,
  type VehicleModelEvidenceModule,
  type VehicleModelRiskLevel,
  type VehicleModelUsageKind
} from "./vehicle-model-usage-tracker";

export const vehicleModelResolverDefinitionSelect = {
  deletedAt: true,
  displayName: true,
  enabled: true,
  id: true,
  legacyVehicleModel: true,
  modelCode: true
} satisfies Prisma.VehicleModelDefinitionSelect;

export type VehicleModelResolverDefinition = Prisma.VehicleModelDefinitionGetPayload<{
  select: typeof vehicleModelResolverDefinitionSelect;
}>;

export type VehicleModelCode = string;

export type ResolvedVehicleModel = {
  legacyVehicleModel: VehicleModelCode | null;
  legacyVehicleModelCode: VehicleModelCode | null;
  modelDefinitionId: string | null;
  modelDisplayName: string | null;
  source: "MODEL_DEFINITION" | "LEGACY_ENUM" | "UNKNOWN";
};

type VehicleModelResolverSource = {
  legacyVehicleModel?: VehicleModelCode | null;
  modelDefinition?: (Pick<VehicleModelResolverDefinition, "displayName" | "id" | "modelCode"> & {
    legacyVehicleModel?: VehicleModelCode | null;
  }) | null;
  modelDefinitionId?: string | null;
  vehicleModel?: VehicleModelCode | null;
};

export type VehicleModelComparable = Pick<
  VehicleModelResolverSource,
  "legacyVehicleModel" | "modelDefinition" | "modelDefinitionId" | "vehicleModel"
>;

type VehicleModelDefinitionReader = {
  vehicleModelDefinition: {
    findFirst(args: {
      select: typeof vehicleModelResolverDefinitionSelect;
      where: Prisma.VehicleModelDefinitionWhereInput;
    }): Promise<VehicleModelResolverDefinition | null>;
  };
};

type ResolveModelDefinitionInput = {
  modelDefinitionId?: string | null;
  vehicleModel?: VehicleModelCode | null;
};

type ResolveModelDefinitionOptions = {
  allowDisabled?: boolean;
  evidenceContext?: VehicleModelEvidenceContext;
  missingMessage?: string;
  mismatchMessage?: string;
};

type VehicleModelEvidenceContext = {
  businessDecision?: boolean;
  module: VehicleModelEvidenceModule;
  operation: string;
  riskLevel?: VehicleModelRiskLevel;
  usageKind?: VehicleModelUsageKind;
};

export type ResolvedVehicleModelDefinitionInput = {
  legacyVehicleModel: VehicleModelCode;
  legacyVehicleModelCode: VehicleModelCode;
  modelDefinition: VehicleModelResolverDefinition;
  modelDefinitionId: string;
  modelDisplayName: string;
};

export function resolveVehicleModel(source: VehicleModelResolverSource): ResolvedVehicleModel {
  const modelDefinitionId = source.modelDefinitionId ?? source.modelDefinition?.id ?? null;
  const legacyVehicleModel =
    source.legacyVehicleModel ??
    source.vehicleModel ??
    source.modelDefinition?.modelCode ??
    source.modelDefinition?.legacyVehicleModel ??
    null;
  const legacyVehicleModelCode = legacyVehicleModel;

  if (modelDefinitionId) {
    return {
      legacyVehicleModel,
      legacyVehicleModelCode,
      modelDefinitionId,
      modelDisplayName: source.modelDefinition?.displayName ?? legacyVehicleModelCode,
      source: "MODEL_DEFINITION"
    };
  }

  if (legacyVehicleModel) {
    return {
      legacyVehicleModel,
      legacyVehicleModelCode,
      modelDefinitionId: null,
      modelDisplayName: legacyVehicleModelCode,
      source: "LEGACY_ENUM"
    };
  }

  return {
    legacyVehicleModel: null,
    legacyVehicleModelCode: null,
    modelDefinitionId: null,
    modelDisplayName: null,
    source: "UNKNOWN"
  };
}

export function resolveVehicleModelDefinitionId(source: VehicleModelComparable): string | null {
  return source.modelDefinitionId ?? source.modelDefinition?.id ?? null;
}

export function resolveVehicleModelLegacyCode(source: VehicleModelComparable): string | null {
  return (
    source.legacyVehicleModel ??
    source.vehicleModel ??
    source.modelDefinition?.modelCode ??
    source.modelDefinition?.legacyVehicleModel ??
    null
  );
}

export function vehicleModelReadPathMatches(
  left: VehicleModelComparable,
  right: VehicleModelComparable,
  evidenceContext?: VehicleModelEvidenceContext
): boolean {
  const leftModelDefinitionId = resolveVehicleModelDefinitionId(left);
  const rightModelDefinitionId = resolveVehicleModelDefinitionId(right);

  if (leftModelDefinitionId && rightModelDefinitionId) {
    trackReadPathDecision(evidenceContext, {
      decisionPath: "MODEL_DEFINITION_ID",
      modelDefinitionId: leftModelDefinitionId
    });
    return leftModelDefinitionId === rightModelDefinitionId;
  }

  const leftLegacyCode = resolveVehicleModelLegacyCode(left);
  const rightLegacyCode = resolveVehicleModelLegacyCode(right);
  if (leftLegacyCode && rightLegacyCode) {
    trackReadPathDecision(evidenceContext, {
      decisionPath: "LEGACY_ENUM",
      legacyVehicleModelCode: leftLegacyCode
    });
  }
  return Boolean(leftLegacyCode && rightLegacyCode && leftLegacyCode === rightLegacyCode);
}

export class VehicleModelLegacyAdapter {
  static async resolveModelDefinitionInput(
    prisma: VehicleModelDefinitionReader,
    input: ResolveModelDefinitionInput,
    options: ResolveModelDefinitionOptions = {}
  ): Promise<ResolvedVehicleModelDefinitionInput> {
    trackAdapterInput(input, options.evidenceContext);

    const modelDefinition = input.modelDefinitionId
      ? await prisma.vehicleModelDefinition.findFirst({
          select: vehicleModelResolverDefinitionSelect,
          where: { deletedAt: null, id: input.modelDefinitionId }
        })
      : input.vehicleModel
        ? await prisma.vehicleModelDefinition.findFirst({
            select: vehicleModelResolverDefinitionSelect,
            where: {
              deletedAt: null,
              OR: [
                { modelCode: input.vehicleModel },
                { legacyVehicleModel: input.vehicleModel }
              ]
            }
          })
        : null;

    if (!modelDefinition) {
      throw new BadRequestException(options.missingMessage ?? "车型主数据不存在，请使用 modelDefinitionId。");
    }
    if (!options.allowDisabled && !modelDefinition.enabled) {
      throw new BadRequestException("车型主数据已停用。");
    }
    if (
      input.vehicleModel &&
      input.vehicleModel !== modelDefinition.modelCode &&
      input.vehicleModel !== modelDefinition.legacyVehicleModel
    ) {
      throw new BadRequestException(options.mismatchMessage ?? "modelDefinitionId 与 vehicleModel 不一致。");
    }

    return {
      legacyVehicleModel: modelDefinition.modelCode,
      legacyVehicleModelCode: modelDefinition.modelCode,
      modelDefinition,
      modelDefinitionId: modelDefinition.id,
      modelDisplayName: modelDefinition.displayName
    };
  }
}

function trackAdapterInput(input: ResolveModelDefinitionInput, evidenceContext: VehicleModelEvidenceContext | undefined) {
  if (!evidenceContext) {
    return;
  }

  if (input.vehicleModel) {
    if (evidenceContext.usageKind === "API_ENUM_FILTER") {
      trackVehicleModelExternalContractWarning({
        legacyVehicleModelCode: String(input.vehicleModel),
        metadata: {
          resolverOperation: evidenceContext.operation
        },
        module: evidenceContext.module,
        operation: `${evidenceContext.operation}.externalContractWarning`,
        riskLevel: evidenceContext.riskLevel ?? "MEDIUM",
        surface: "REPORT_FILTER"
      });
    }

    trackVehicleModelUsage({
      decisionPath: input.modelDefinitionId ? "MODEL_DEFINITION_ID" : "LEGACY_ENUM",
      legacyVehicleModelCode: String(input.vehicleModel),
      modelDefinitionId: input.modelDefinitionId ?? null,
      module: evidenceContext.module,
      operation: evidenceContext.operation,
      riskLevel: evidenceContext.riskLevel ?? (evidenceContext.businessDecision ? "HIGH" : "MEDIUM"),
      usageKind: evidenceContext.usageKind ?? "ENUM_RESOLVE"
    });
  }

  if (!input.modelDefinitionId && input.vehicleModel) {
    trackVehicleModelUsage({
      decisionPath: "LEGACY_ENUM",
      legacyVehicleModelCode: String(input.vehicleModel),
      module: evidenceContext.module,
      operation: `${evidenceContext.operation}.fallback`,
      riskLevel: "MEDIUM",
      usageKind: "FALLBACK"
    });

    if (evidenceContext.businessDecision) {
      trackVehicleModelUsage({
        decisionPath: "LEGACY_ENUM",
        legacyVehicleModelCode: String(input.vehicleModel),
        module: evidenceContext.module,
        operation: `${evidenceContext.operation}.businessDecision`,
        riskLevel: "HIGH",
        usageKind: "BUSINESS_DECISION"
      });
    }
  }
}

function trackReadPathDecision(
  evidenceContext: VehicleModelEvidenceContext | undefined,
  input: { decisionPath: "LEGACY_ENUM" | "MODEL_DEFINITION_ID"; legacyVehicleModelCode?: string; modelDefinitionId?: string }
) {
  if (!evidenceContext) {
    return;
  }

  trackVehicleModelUsage({
    decisionPath: input.decisionPath,
    legacyVehicleModelCode: input.legacyVehicleModelCode ?? null,
    modelDefinitionId: input.modelDefinitionId ?? null,
    module: evidenceContext.module,
    operation: `${evidenceContext.operation}.readPath`,
    riskLevel: input.decisionPath === "LEGACY_ENUM" ? "MEDIUM" : "LOW",
    usageKind: input.decisionPath === "LEGACY_ENUM" ? "FALLBACK" : "BUSINESS_DECISION"
  });

  if (input.decisionPath === "LEGACY_ENUM" && evidenceContext.businessDecision) {
    trackVehicleModelUsage({
      decisionPath: "LEGACY_ENUM",
      legacyVehicleModelCode: input.legacyVehicleModelCode ?? null,
      module: evidenceContext.module,
      operation: `${evidenceContext.operation}.businessDecision`,
      riskLevel: "HIGH",
      usageKind: "BUSINESS_DECISION"
    });
  }
}
