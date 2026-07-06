"use client";

import { CheckOutlined, DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined, PoweroffOutlined } from "@ant-design/icons";
import {
  App,
  Alert,
  Button,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { ActionButton } from "../../components/action-button";
import { ProtectedShell } from "../../components/protected-shell";
import {
  BENEFIT_TYPE_LABELS,
  PRODUCT_TYPE_LABELS,
  PRODUCT_VERSION_STATUS_LABELS,
  STATUS_LABELS,
  VEHICLE_BASE_FEE_MODE_LABELS,
  VEHICLE_MODEL_LABELS,
  labelOf
} from "../../constants/labels";
import {
  actionAvailability,
  canActivateProductVersion,
  canActivateSubscriptionPlan
} from "../../lib/action-guards";
import { apiFetch, ApiError } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";

interface ProductVersion {
  approvedAt?: string | null;
  benefitPackages?: PackageRow[];
  effectiveFrom: string;
  effectiveTo?: string | null;
  energyPackages?: PackageRow[];
  id: string;
  mileagePackages?: PackageRow[];
  product?: { id: string; name: string; productNo: string; status: string } | null;
  productId: string;
  status: string;
  vehiclePackages?: PackageRow[];
  versionNo: string;
}

interface Product {
  activeVersion?: ProductVersion | null;
  createdAt: string;
  description?: string | null;
  id: string;
  name: string;
  productNo: string;
  productType: string;
  status: string;
  versions: ProductVersion[];
}

interface ProductValues {
  description?: string;
  name: string;
}

interface VersionValues {
  effectiveFrom: Dayjs;
  effectiveTo?: Dayjs | null;
  productId?: string;
  versionNo: string;
}

interface PackageRow {
  benefitCount?: number | null;
  benefitType?: string;
  brand?: string | null;
  configName?: string | null;
  description?: string | null;
  id: string;
  maxPeriodMonths?: number;
  maxPurchasePriceAmount?: number | null;
  minPeriodMonths?: number;
  minPurchasePriceAmount?: number | null;
  modelDefinition?: VehicleModelDefinitionSummary | null;
  modelDefinitionId?: string | null;
  modelDisplayName?: string | null;
  monthlyEnergyCount?: number | null;
  monthlyEnergyKwh?: number | null;
  monthlyFeeRate?: number;
  monthlyMileageKm?: number;
  overMileageFeeAmount?: number;
  packageName: string;
  packageNo: string;
  priceAmount?: number;
  product: { id: string; name: string; productNo: string; status: string };
  productId: string;
  productVersion: { id: string; productId: string; status: string; versionNo: string };
  productVersionId: string;
  remark?: string | null;
  serviceDescription?: string | null;
  stationScope?: string | null;
  status: string;
  vehicleModel?: string | null;
  vehicleModelName?: string | null;
}

type PackageKind = "benefit" | "energy" | "mileage" | "vehicle";

interface PackageValues {
  benefitCount?: number | null;
  benefitType?: string;
  brand?: string | null;
  configName?: string | null;
  description?: string | null;
  maxPeriodMonths?: number;
  maxPurchasePriceAmountYuan?: number | null;
  minPeriodMonths?: number;
  minPurchasePriceAmountYuan?: number | null;
  modelDefinitionId?: string | null;
  monthlyEnergyCount?: number | null;
  monthlyEnergyKwh?: number | null;
  monthlyFeeRate?: number;
  monthlyMileageKm?: number;
  overMileageFeeAmountYuan?: number;
  packageName: string;
  priceAmountYuan?: number;
  productId: string;
  productVersionId: string;
  remark?: string | null;
  serviceDescription?: string | null;
  stationScope?: string | null;
  vehicleModel?: string | null;
  vehicleModelName?: string | null;
}

interface SubscriptionPlan {
  baseMonthlyFeeAmount?: number | null;
  benefitPackage?: PackageRow | null;
  benefitPackageId?: string | null;
  createdAt: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  energyPackage: PackageRow;
  energyPackageId: string;
  id: string;
  maxPeriodMonths: number;
  mileagePackage: PackageRow;
  mileagePackageId: string;
  minPeriodMonths: number;
  monthlyFeeCapRate?: number | null;
  monthlyFeeMode: string;
  monthlyFeeRate: number;
  planName: string;
  planNo: string;
  product: { id: string; name: string; productNo: string; productType?: string; status: string };
  productId: string;
  productVersion: { id: string; productId: string; status: string; versionNo: string };
  productVersionId: string;
  remark?: string | null;
  status: string;
  updatedAt: string;
  vehiclePackage: PackageRow;
  vehiclePackageId: string;
}

interface PlanValues {
  baseMonthlyFeeAmountYuan?: number | null;
  benefitPackageId?: string | null;
  effectiveFrom: Dayjs;
  effectiveTo?: Dayjs | null;
  energyPackageId: string;
  maxPeriodMonths: number;
  mileagePackageId: string;
  minPeriodMonths: number;
  monthlyFeeCapRate?: number | null;
  monthlyFeeMode: string;
  monthlyFeeRate: number;
  planName: string;
  productId: string;
  productVersionId: string;
  remark?: string | null;
  vehiclePackageId: string;
}

interface VehicleModelDefinitionSummary {
  customerDisplayName?: string | null;
  displayName: string;
  id: string;
  legacyVehicleModel?: string | null;
  modelCode: string;
}

interface ListResponse<T> {
  items: T[];
}

const statusColors: Record<string, string> = {
  ACTIVE: "green",
  APPROVED: "blue",
  DRAFT: "default",
  INACTIVE: "default"
};

const vehicleOptions = ["ET5", "ET5T", "ET7", "ES6", "EC6", "ES8", "ET9", "ES9"].map(
  (value) => ({ label: labelOf(VEHICLE_MODEL_LABELS, value), value })
);
const benefitOptions = [
  { label: "洗车权益", value: "WASH_CAR" },
  { label: "换车权益", value: "CAR_SWAP" },
  { label: "积分权益", value: "POINTS" },
  { label: "代驾权益", value: "DRIVER_SERVICE" },
  { label: "其他权益", value: "OTHER" }
];

const packageMeta: Record<PackageKind, { createText: string; endpoint: string; tab: string; title: string }> = {
  benefit: { createText: "新增权益包", endpoint: "benefit-packages", tab: "benefit-packages", title: "权益包" },
  energy: { createText: "新增补能包", endpoint: "energy-packages", tab: "energy-packages", title: "补能包" },
  mileage: { createText: "新增里程包", endpoint: "mileage-packages", tab: "mileage-packages", title: "里程包" },
  vehicle: { createText: "新增车辆使用费", endpoint: "vehicle-packages", tab: "vehicle-packages", title: "车辆使用费" }
};

const monthlyFeeModeLabels = VEHICLE_BASE_FEE_MODE_LABELS;

type ProductCenterTabKey =
  | "benefit-packages"
  | "energy-packages"
  | "mileage-packages"
  | "products"
  | "subscription-plans"
  | "vehicle-packages"
  | "versions";

const productCenterTabPermissions: Record<ProductCenterTabKey, string> = {
  "benefit-packages": "benefit_package:view",
  "energy-packages": "energy_package:view",
  "mileage-packages": "mileage_package:view",
  products: "product:view",
  "subscription-plans": "subscription_plan:view",
  "vehicle-packages": "vehicle_package:view",
  versions: "product_version:view"
};

const productCenterTabKeys = Object.keys(productCenterTabPermissions) as ProductCenterTabKey[];

function normalizeProductCenterTab(tab: string | null): ProductCenterTabKey {
  return productCenterTabKeys.includes(tab as ProductCenterTabKey) ? (tab as ProductCenterTabKey) : "products";
}

function formatRate(value?: number | null) {
  return value === undefined || value === null ? "-" : `${(value * 100).toFixed(2)}%`;
}

function formatYuan(value?: number | null) {
  return value === undefined || value === null ? "-" : `¥${(value / 100).toFixed(2)}`;
}

function toCents(value?: number | null) {
  return value === undefined || value === null ? undefined : Math.round(value * 100);
}

function modelDefinitionOptionLabel(definition: VehicleModelDefinitionSummary) {
  return `${definition.modelCode} - ${definition.displayName} (legacy: ${labelOf(
    VEHICLE_MODEL_LABELS,
    definition.legacyVehicleModel
  )})`;
}

function packageModelDisplayName(row?: PackageRow | null) {
  if (!row) {
    return "-";
  }
  return row.modelDisplayName ?? row.modelDefinition?.displayName ?? labelOf(VEHICLE_MODEL_LABELS, row.vehicleModel);
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

export default function ProductsPage() {
  return (
    <Suspense fallback={null}>
      <ProductsPageContent />
    </Suspense>
  );
}

function ProductsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const [packageForm] = Form.useForm<PackageValues>();
  const [planForm] = Form.useForm<PlanValues>();
  const [productForm] = Form.useForm<ProductValues>();
  const [versionForm] = Form.useForm<VersionValues>();
  const [benefitPackages, setBenefitPackages] = useState<PackageRow[]>([]);
  const [editingPackage, setEditingPackage] = useState<PackageRow | null>(null);
  const [editingPlan, setEditingPlan] = useState<SubscriptionPlan | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingVersion, setEditingVersion] = useState<ProductVersion | null>(null);
  const [energyPackages, setEnergyPackages] = useState<PackageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [mileagePackages, setMileagePackages] = useState<PackageRow[]>([]);
  const [packageKind, setPackageKind] = useState<PackageKind>("vehicle");
  const [packageOpen, setPackageOpen] = useState(false);
  const [planDetail, setPlanDetail] = useState<SubscriptionPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [subscriptionPlans, setSubscriptionPlans] = useState<SubscriptionPlan[]>([]);
  const [vehicleModelDefinitions, setVehicleModelDefinitions] = useState<VehicleModelDefinitionSummary[]>([]);
  const [vehiclePackages, setVehiclePackages] = useState<PackageRow[]>([]);
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionProductLocked, setVersionProductLocked] = useState(false);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [tabError, setTabError] = useState<string | null>(null);
  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);

  const activeTab = normalizeProductCenterTab(searchParams.get("tab"));
  const selectedPackageProductId = Form.useWatch("productId", packageForm);
  const selectedPackageProduct = products.find((product) => product.id === selectedPackageProductId);
  const selectedPlanProductId = Form.useWatch("productId", planForm);
  const selectedPlanVersionId = Form.useWatch("productVersionId", planForm);
  const selectedPlanVehiclePackageId = Form.useWatch("vehiclePackageId", planForm);
  const selectedPlanMileagePackageId = Form.useWatch("mileagePackageId", planForm);
  const selectedPlanEnergyPackageId = Form.useWatch("energyPackageId", planForm);
  const selectedPlanBenefitPackageId = Form.useWatch("benefitPackageId", planForm);
  const selectedPlanProduct = products.find((product) => product.id === selectedPlanProductId);
  const selectedPlanVehiclePackage = vehiclePackages.find((row) => row.id === selectedPlanVehiclePackageId);
  const selectedPlanMileagePackage = mileagePackages.find((row) => row.id === selectedPlanMileagePackageId);
  const selectedPlanEnergyPackage = energyPackages.find((row) => row.id === selectedPlanEnergyPackageId);
  const selectedPlanBenefitPackage = benefitPackages.find((row) => row.id === selectedPlanBenefitPackageId);
  const planVehicleOptions = vehiclePackages.filter((row) => row.productVersionId === selectedPlanVersionId);
  const planMileageOptions = mileagePackages.filter((row) => row.productVersionId === selectedPlanVersionId);
  const planEnergyOptions = energyPackages.filter((row) => row.productVersionId === selectedPlanVersionId);
  const planBenefitOptions = benefitPackages.filter((row) => row.productVersionId === selectedPlanVersionId);

  const loadCurrentUser = useCallback(async () => {
    try {
      setMe(await apiFetch<AuthMeResponse>("/auth/me"));
    } catch (error) {
      const messageText = getErrorMessage(error);
      setTabError(error instanceof ApiError && error.status === 403 ? `403: ${messageText}` : messageText);
      void message.error(messageText);
    } finally {
      setAuthLoaded(true);
    }
  }, [message]);

  const setPackageRows = useCallback((kind: PackageKind, rows: PackageRow[]) => {
    if (kind === "benefit") {
      setBenefitPackages(rows);
      return;
    }
    if (kind === "energy") {
      setEnergyPackages(rows);
      return;
    }
    if (kind === "mileage") {
      setMileagePackages(rows);
      return;
    }
    setVehiclePackages(rows);
  }, []);

  const loadProducts = useCallback(async () => {
    const productRows = await apiFetch<Product[]>("/products");
    setProducts(productRows);
    return productRows;
  }, []);

  const loadPackageRows = useCallback(
    async (kind: PackageKind) => {
      const rows = await apiFetch<PackageRow[]>(`/${packageMeta[kind].endpoint}`);
      setPackageRows(kind, rows);
      return rows;
    },
    [setPackageRows]
  );

  const loadVehicleModelDefinitions = useCallback(async () => {
    const modelDefinitionResult = await apiFetch<ListResponse<VehicleModelDefinitionSummary>>(
      "/vehicle-model-definitions?enabled=true&pageSize=100"
    );
    setVehicleModelDefinitions(modelDefinitionResult.items);
    return modelDefinitionResult.items;
  }, []);

  const loadPlanDependencies = useCallback(async () => {
    const [productRows, vehicleRows, mileageRows, energyRows, benefitRows] = await Promise.all([
      apiFetch<Product[]>("/products"),
      apiFetch<PackageRow[]>("/vehicle-packages"),
      apiFetch<PackageRow[]>("/mileage-packages"),
      apiFetch<PackageRow[]>("/energy-packages"),
      apiFetch<PackageRow[]>("/benefit-packages")
    ]);
    setProducts(productRows);
    setVehiclePackages(vehicleRows);
    setMileagePackages(mileageRows);
    setEnergyPackages(energyRows);
    setBenefitPackages(benefitRows);
  }, []);

  const loadData = useCallback(async () => {
    if (!me) {
      return;
    }

    const requiredPermission = productCenterTabPermissions[activeTab];
    if (!permissions.has(requiredPermission)) {
      setLoading(false);
      setTabError("403: 无权限访问当前产品中心页签");
      return;
    }

    setLoading(true);
    setTabError(null);
    try {
      if (activeTab === "products" || activeTab === "versions") {
        await loadProducts();
        return;
      }

      const activePackageKind = packageKindFromTab(activeTab);
      if (activePackageKind) {
        await loadPackageRows(activePackageKind);
        return;
      }

      if (activeTab === "subscription-plans") {
        setSubscriptionPlans(await apiFetch<SubscriptionPlan[]>("/subscription-plans"));
      }
    } catch (error) {
      const messageText = getErrorMessage(error);
      setTabError(error instanceof ApiError && error.status === 403 ? `403: ${messageText}` : messageText);
      void message.error(messageText);
    } finally {
      setLoading(false);
    }
  }, [activeTab, loadPackageRows, loadProducts, me, message, permissions]);

  useEffect(() => {
    void loadCurrentUser();
  }, [loadCurrentUser]);

  useEffect(() => {
    if (authLoaded) {
      void loadData();
    }
  }, [authLoaded, loadData]);

  useEffect(() => {
    if (!selectedPlanVehiclePackage) {
      return;
    }
    planForm.setFieldsValue({
      maxPeriodMonths: selectedPlanVehiclePackage.maxPeriodMonths,
      minPeriodMonths: selectedPlanVehiclePackage.minPeriodMonths,
      monthlyFeeRate: selectedPlanVehiclePackage.monthlyFeeRate
    });
  }, [planForm, selectedPlanVehiclePackage]);

  const productOptions = useMemo(
    () => products.map((product) => ({ label: `${product.productNo} / ${product.name}`, value: product.id })),
    [products]
  );
  const vehicleModelDefinitionOptions = useMemo(
    () =>
      vehicleModelDefinitions
        .filter((definition) => definition.legacyVehicleModel)
        .map((definition) => ({
          label: modelDefinitionOptionLabel(definition),
          value: definition.id
        })),
    [vehicleModelDefinitions]
  );
  const vehicleModelDefinitionById = useMemo(
    () => new Map(vehicleModelDefinitions.map((definition) => [definition.id, definition])),
    [vehicleModelDefinitions]
  );

  function syncPackageLegacyVehicleModel(modelDefinitionId?: string) {
    const definition = modelDefinitionId ? vehicleModelDefinitionById.get(modelDefinitionId) : null;
    if (definition?.legacyVehicleModel) {
      packageForm.setFieldValue("vehicleModel", definition.legacyVehicleModel);
    }
  }

  function openProductModal(product?: Product) {
    setEditingProduct(product ?? null);
    productForm.setFieldsValue(
      product ? { description: product.description ?? undefined, name: product.name } : { name: "上海二手纯电标准订阅产品" }
    );
    setProductOpen(true);
  }

  async function saveProduct(values: ProductValues) {
    try {
      if (editingProduct) {
        await apiFetch<Product>(`/products/${editingProduct.id}`, { body: JSON.stringify(values), method: "PATCH" });
        void message.success("产品已更新");
      } else {
        await apiFetch<Product>("/products", { body: JSON.stringify(values), method: "POST" });
        void message.success("产品已创建");
      }
      setProductOpen(false);
      productForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function setProductStatus(product: Product, active: boolean) {
    try {
      await apiFetch<Product>(`/products/${product.id}/${active ? "activate" : "deactivate"}`, { method: "POST" });
      void message.success(active ? "产品已启用" : "产品已停用");
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function openVersionModal(version?: ProductVersion, product?: Product) {
    setEditingVersion(version ?? null);
    setVersionProductLocked(Boolean(product));
    versionForm.setFieldsValue(
      version
        ? {
            effectiveFrom: dayjs(version.effectiveFrom),
            effectiveTo: version.effectiveTo ? dayjs(version.effectiveTo) : null,
            productId: version.productId,
            versionNo: version.versionNo
          }
        : {
            effectiveFrom: dayjs(),
            productId: product?.id,
            versionNo: "V1.0"
          }
    );
    setVersionOpen(true);
  }

  async function saveVersion(values: VersionValues) {
    try {
      const body = {
        effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
        effectiveTo: values.effectiveTo ? values.effectiveTo.format("YYYY-MM-DD") : null,
        productId: values.productId,
        versionNo: values.versionNo
      };
      if (editingVersion) {
        await apiFetch<ProductVersion>(`/product-versions/${editingVersion.id}`, {
          body: JSON.stringify(body),
          method: "PATCH"
        });
        void message.success("产品版本已更新");
      } else {
        await apiFetch<ProductVersion>("/product-versions", {
          body: JSON.stringify(body),
          method: "POST"
        });
        void message.success("产品版本已创建");
      }
      setVersionOpen(false);
      versionForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function transitionVersion(version: ProductVersion, action: "approve" | "activate" | "deactivate") {
    try {
      let plansForValidation = subscriptionPlans;
      if (action === "activate" && plansForValidation.length === 0) {
        plansForValidation = await apiFetch<SubscriptionPlan[]>("/subscription-plans");
        setSubscriptionPlans(plansForValidation);
      }
      if (
        action === "activate" &&
        !plansForValidation.some((plan) => plan.productVersionId === version.id && plan.status === "ACTIVE")
      ) {
        void message.error("当前产品版本尚未启用订阅套餐，请先配置并启用至少一个订阅套餐");
        return;
      }
      await apiFetch<ProductVersion>(`/product-versions/${version.id}/${action}`, { method: "POST" });
      void message.success("产品版本状态已更新");
      await loadData();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      void message.error(
        errorMessage.includes("订阅套餐") || errorMessage.includes("price rule")
          ? "当前产品版本尚未启用订阅套餐，请先配置并启用至少一个订阅套餐"
          : errorMessage
      );
    }
  }

  async function openPackageModal(kind: PackageKind, row?: PackageRow) {
    try {
      await loadProducts();
      if (kind === "vehicle") {
        await loadVehicleModelDefinitions();
      }
      setPackageKind(kind);
      setEditingPackage(row ?? null);
      packageForm.setFieldsValue(
        row
          ? {
              ...row,
              maxPurchasePriceAmountYuan: row.maxPurchasePriceAmount ? row.maxPurchasePriceAmount / 100 : null,
              minPurchasePriceAmountYuan: row.minPurchasePriceAmount ? row.minPurchasePriceAmount / 100 : null,
              overMileageFeeAmountYuan: row.overMileageFeeAmount ? row.overMileageFeeAmount / 100 : undefined,
              priceAmountYuan: row.priceAmount ? row.priceAmount / 100 : 0
            }
          : defaultPackageValues(kind)
      );
      setPackageOpen(true);
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function savePackage(values: PackageValues) {
    const endpoint = packageMeta[packageKind].endpoint;
    if (packageKind === "vehicle" && !editingPackage && !values.modelDefinitionId) {
      void message.error("请选择车型代码。新增车型包必须关联车型主数据。");
      return;
    }

    const body = buildPackagePayload(packageKind, values);
    try {
      if (editingPackage) {
        await apiFetch(`/${endpoint}/${editingPackage.id}`, { body: JSON.stringify(body), method: "PATCH" });
        void message.success(`${packageMeta[packageKind].title}已更新`);
      } else {
        await apiFetch(`/${endpoint}`, { body: JSON.stringify(body), method: "POST" });
        void message.success(`${packageMeta[packageKind].title}已创建`);
      }
      setPackageOpen(false);
      packageForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function setPackageStatus(kind: PackageKind, row: PackageRow, active: boolean) {
    try {
      await apiFetch(`/${packageMeta[kind].endpoint}/${row.id}/${active ? "activate" : "deactivate"}`, { method: "POST" });
      void message.success(active ? "已启用" : "已停用");
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function deletePackage(kind: PackageKind, row: PackageRow) {
    try {
      await apiFetch(`/${packageMeta[kind].endpoint}/${row.id}`, { method: "DELETE" });
      void message.success("已删除");
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function openPlanModal(plan?: SubscriptionPlan) {
    try {
      await loadPlanDependencies();
    } catch (error) {
      void message.error(getErrorMessage(error));
      return;
    }
    setEditingPlan(plan ?? null);
    planForm.setFieldsValue(
      plan
        ? {
            baseMonthlyFeeAmountYuan:
              plan.baseMonthlyFeeAmount === undefined || plan.baseMonthlyFeeAmount === null
                ? null
                : plan.baseMonthlyFeeAmount / 100,
            benefitPackageId: plan.benefitPackageId ?? null,
            effectiveFrom: dayjs(plan.effectiveFrom),
            effectiveTo: plan.effectiveTo ? dayjs(plan.effectiveTo) : null,
            energyPackageId: plan.energyPackageId,
            maxPeriodMonths: plan.maxPeriodMonths,
            mileagePackageId: plan.mileagePackageId,
            minPeriodMonths: plan.minPeriodMonths,
            monthlyFeeCapRate: plan.monthlyFeeCapRate ?? null,
            monthlyFeeMode: plan.monthlyFeeMode,
            monthlyFeeRate: plan.monthlyFeeRate,
            planName: plan.planName,
            productId: plan.productId,
            productVersionId: plan.productVersionId,
            remark: plan.remark ?? null,
            vehiclePackageId: plan.vehiclePackageId
          }
        : {
            effectiveFrom: dayjs(),
            maxPeriodMonths: 36,
            minPeriodMonths: 12,
            monthlyFeeMode: "MANUAL_QUOTE",
            monthlyFeeRate: 0.035,
            planName: "ET5标准订阅套餐"
          }
    );
    setPlanOpen(true);
  }

  async function savePlan(values: PlanValues) {
    const body = {
      baseMonthlyFeeAmount: toCents(values.baseMonthlyFeeAmountYuan),
      benefitPackageId: values.benefitPackageId ?? null,
      effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
      effectiveTo: values.effectiveTo ? values.effectiveTo.format("YYYY-MM-DD") : null,
      energyPackageId: values.energyPackageId,
      maxPeriodMonths: values.maxPeriodMonths,
      mileagePackageId: values.mileagePackageId,
      minPeriodMonths: values.minPeriodMonths,
      monthlyFeeCapRate: values.monthlyFeeCapRate ?? null,
      monthlyFeeMode: values.monthlyFeeMode,
      monthlyFeeRate: values.monthlyFeeRate,
      planName: values.planName,
      productId: values.productId,
      productVersionId: values.productVersionId,
      remark: values.remark,
      vehiclePackageId: values.vehiclePackageId
    };
    try {
      if (editingPlan) {
        await apiFetch<SubscriptionPlan>(`/subscription-plans/${editingPlan.id}`, {
          body: JSON.stringify(body),
          method: "PATCH"
        });
        void message.success("订阅套餐已更新");
      } else {
        await apiFetch<SubscriptionPlan>("/subscription-plans", {
          body: JSON.stringify(body),
          method: "POST"
        });
        void message.success("订阅套餐已创建");
      }
      setPlanOpen(false);
      planForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function setPlanStatus(plan: SubscriptionPlan, active: boolean) {
    try {
      await apiFetch<SubscriptionPlan>(`/subscription-plans/${plan.id}/${active ? "activate" : "deactivate"}`, {
        method: "POST"
      });
      void message.success(active ? "订阅套餐已启用" : "订阅套餐已停用");
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function deletePlan(plan: SubscriptionPlan) {
    try {
      await apiFetch<SubscriptionPlan>(`/subscription-plans/${plan.id}`, { method: "DELETE" });
      void message.success("订阅套餐已删除");
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  const productColumns: ColumnsType<Product> = [
    { dataIndex: "productNo", title: "产品编号", width: 160 },
    { dataIndex: "name", title: "产品名称", width: 220 },
    { dataIndex: "productType", render: () => labelOf(PRODUCT_TYPE_LABELS, "SUBSCRIPTION"), title: "产品类型", width: 130 },
    { dataIndex: "status", render: (value: string) => <Tag color={statusColors[value]}>{labelOf(STATUS_LABELS, value)}</Tag>, title: "状态", width: 100 },
    { dataIndex: "activeVersion", render: (value?: ProductVersion | null) => value?.versionNo ?? "暂无生效版本", title: "当前生效版本", width: 140 },
    { render: (_, record) => record.versions?.length ?? 0, title: "版本数量", width: 100 },
    {
      render: (_, record) => (
        <Space>
          <ActionButton
            onClick={() => openVersionModal(undefined, record)}
            permission="product_version:create"
            permissions={permissions}
            size="small"
          >
            新建版本
          </ActionButton>
          <ActionButton
            icon={<EditOutlined />}
            onClick={() => openProductModal(record)}
            permission="product:update"
            permissions={permissions}
            size="small"
          >
            编辑
          </ActionButton>
          <ActionButton
            icon={<PoweroffOutlined />}
            onClick={() => setProductStatus(record, record.status !== "ACTIVE")}
            permission="product:activate"
            permissions={permissions}
            size="small"
          >
            {record.status === "ACTIVE" ? "停用" : "启用"}
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 260
    }
  ];

  const versionRows = products.flatMap((product) =>
    product.versions.map((version) => ({ ...version, product: { id: product.id, name: product.name, productNo: product.productNo, status: product.status } }))
  );
  const versionColumns: ColumnsType<ProductVersion> = [
    { dataIndex: ["product", "productNo"], title: "产品编号", width: 160 },
    { dataIndex: ["product", "name"], title: "产品名称", width: 220 },
    { dataIndex: "versionNo", title: "版本号", width: 120 },
    { dataIndex: "status", render: (value: string) => <Tag color={statusColors[value]}>{labelOf(PRODUCT_VERSION_STATUS_LABELS, value)}</Tag>, title: "状态", width: 110 },
    { dataIndex: "effectiveFrom", title: "生效日期", width: 120 },
    { dataIndex: "effectiveTo", render: (value?: string | null) => value ?? "-", title: "失效日期", width: 120 },
    {
      render: (_, record) => (
        <Space>
          <ActionButton
            icon={<EditOutlined />}
            onClick={() => openVersionModal(record)}
            permission="product_version:update"
            permissions={permissions}
            size="small"
          >
            编辑
          </ActionButton>
          <ActionButton
            icon={<CheckOutlined />}
            onClick={() => transitionVersion(record, "approve")}
            permission="product_version:approve"
            permissions={permissions}
            size="small"
          >
            审批
          </ActionButton>
          <ActionButton
            availability={
              subscriptionPlans.length > 0
                ? canActivateProductVersion(record, subscriptionPlans, permissions)
                : actionAvailability({
                    permission: "product_version:activate",
                    permissions
                  })
            }
            onClick={() => transitionVersion(record, "activate")}
            size="small"
          >
            激活
          </ActionButton>
          <ActionButton
            allowed={record.status === "ACTIVE"}
            disabledReason="当前产品版本未激活"
            onClick={() => transitionVersion(record, "deactivate")}
            permission="product_version:activate"
            permissions={permissions}
            size="small"
          >
            停用
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 280
    }
  ];
  const planColumns: ColumnsType<SubscriptionPlan> = [
    { dataIndex: "planNo", title: "套餐编号", width: 170 },
    { dataIndex: "planName", title: "套餐名称", width: 180 },
    { dataIndex: ["product", "productNo"], title: "产品编号", width: 150 },
    { dataIndex: ["product", "name"], title: "产品名称", width: 180 },
    { dataIndex: ["productVersion", "versionNo"], title: "产品版本", width: 110 },
    { render: (_, record) => packageModelDisplayName(record.vehiclePackage), title: "车型", width: 140 },
    { render: (_, record) => record.vehiclePackage.packageName, title: "车辆使用费", width: 170 },
    { render: (_, record) => record.mileagePackage.packageName, title: "里程包", width: 150 },
    { render: (_, record) => record.energyPackage.packageName, title: "补能包", width: 150 },
    { render: (_, record) => record.benefitPackage?.packageName ?? "-", title: "权益包", width: 150 },
    { dataIndex: "monthlyFeeMode", render: (value: string) => monthlyFeeModeLabels[value] ?? value, title: "车辆基础月费模式", width: 150 },
    { dataIndex: "monthlyFeeRate", render: formatRate, title: "月费率", width: 100 },
    { render: (_, record) => `${record.minPeriodMonths} - ${record.maxPeriodMonths} 个月`, title: "订阅周期", width: 140 },
    { dataIndex: "status", render: (value: string) => <Tag color={statusColors[value]}>{labelOf(STATUS_LABELS, value)}</Tag>, title: "状态", width: 100 },
    { dataIndex: "effectiveFrom", title: "生效日期", width: 120 },
    { dataIndex: "effectiveTo", render: (value?: string | null) => value ?? "-", title: "失效日期", width: 120 },
    {
      render: (_, record) => (
        <Space>
          <Button icon={<EyeOutlined />} onClick={() => setPlanDetail(record)} size="small">详情</Button>
          <ActionButton
            allowed={record.status !== "ACTIVE"}
            disabledReason="当前套餐已启用，请先停用后再编辑"
            icon={<EditOutlined />}
            onClick={() => openPlanModal(record)}
            permission="subscription_plan:update"
            permissions={permissions}
            size="small"
          >
            编辑
          </ActionButton>
          <ActionButton
            availability={
              record.status === "ACTIVE"
                ? actionAvailability({
                    allowed: true,
                    permission: "subscription_plan:deactivate",
                    permissions
                  })
                : canActivateSubscriptionPlan(record, permissions)
            }
            onClick={() => setPlanStatus(record, record.status !== "ACTIVE")}
            size="small"
          >
            {record.status === "ACTIVE" ? "停用" : "启用"}
          </ActionButton>
          <ActionButton
            danger
            icon={<DeleteOutlined />}
            onClick={() => deletePlan(record)}
            permission="subscription_plan:delete"
            permissions={permissions}
            size="small"
          >
            删除
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 310
    }
  ];

  function canAccessTab(tab: ProductCenterTabKey) {
    return !me || permissions.has(productCenterTabPermissions[tab]);
  }

  function isTabDisabled(tab: ProductCenterTabKey) {
    return Boolean(me) && activeTab !== tab && !canAccessTab(tab);
  }

  function renderTabContent(tab: ProductCenterTabKey, content: ReactNode) {
    if (activeTab === tab && tabError) {
      return <Alert showIcon message={tabError} type={tabError.includes("403") ? "warning" : "error"} />;
    }
    return content;
  }

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={4} style={{ margin: 0 }}>产品中心</Typography.Title>
          <Space>
            {activeTab === "products" ? (
              <ActionButton
                icon={<PlusOutlined />}
                onClick={() => openProductModal()}
                permission="product:create"
                permissions={permissions}
                type="primary"
              >
                新增订阅产品
              </ActionButton>
            ) : null}
            {activeTab === "versions" ? (
              <ActionButton
                icon={<PlusOutlined />}
                onClick={() => openVersionModal()}
                permission="product_version:create"
                permissions={permissions}
                type="primary"
              >
                新增产品版本
              </ActionButton>
            ) : null}
            {activeTab === "subscription-plans" ? (
              <ActionButton
                icon={<PlusOutlined />}
                onClick={() => openPlanModal()}
                permission="subscription_plan:create"
                permissions={permissions}
                type="primary"
              >
                新增订阅套餐
              </ActionButton>
            ) : null}
            {packageKindFromTab(activeTab) ? (
              <ActionButton
                icon={<PlusOutlined />}
                onClick={() => openPackageModal(packageKindFromTab(activeTab) ?? "vehicle")}
                permission={packagePermission(packageKindFromTab(activeTab) ?? "vehicle", "create")}
                permissions={permissions}
                type="primary"
              >
                {packageMeta[packageKindFromTab(activeTab) ?? "vehicle"].createText}
              </ActionButton>
            ) : null}
          </Space>
        </Space>

        <Tabs
          activeKey={activeTab}
          onChange={(key) => router.push(`/products?tab=${key}`)}
          items={[
            {
              children: renderTabContent(
                "products",
                <Table columns={productColumns} dataSource={products} loading={loading} rowKey="id" scroll={{ x: 1200 }} />
              ),
              disabled: isTabDisabled("products"),
              key: "products",
              label: "订阅产品"
            },
            {
              children: renderTabContent(
                "versions",
                <Table columns={versionColumns} dataSource={versionRows} loading={loading} rowKey="id" scroll={{ x: 1300 }} />
              ),
              disabled: isTabDisabled("versions"),
              key: "versions",
              label: "产品版本"
            },
            {
              children: renderTabContent(
                "vehicle-packages",
                packageTable("vehicle", vehiclePackages, openPackageModal, setPackageStatus, deletePackage, loading, permissions)
              ),
              disabled: isTabDisabled("vehicle-packages"),
              key: "vehicle-packages",
              label: "车型包"
            },
            {
              children: renderTabContent(
                "mileage-packages",
                packageTable("mileage", mileagePackages, openPackageModal, setPackageStatus, deletePackage, loading, permissions)
              ),
              disabled: isTabDisabled("mileage-packages"),
              key: "mileage-packages",
              label: "里程包"
            },
            {
              children: renderTabContent(
                "energy-packages",
                packageTable("energy", energyPackages, openPackageModal, setPackageStatus, deletePackage, loading, permissions)
              ),
              disabled: isTabDisabled("energy-packages"),
              key: "energy-packages",
              label: "补能包"
            },
            {
              children: renderTabContent(
                "benefit-packages",
                packageTable("benefit", benefitPackages, openPackageModal, setPackageStatus, deletePackage, loading, permissions)
              ),
              disabled: isTabDisabled("benefit-packages"),
              key: "benefit-packages",
              label: "权益包"
            },
            {
              children: renderTabContent(
                "subscription-plans",
                <Table columns={planColumns} dataSource={subscriptionPlans} loading={loading} rowKey="id" scroll={{ x: 2100 }} />
              ),
              disabled: isTabDisabled("subscription-plans"),
              key: "subscription-plans",
              label: "订阅套餐"
            }
          ]}
        />
      </Space>

      <Modal okText="保存" onCancel={() => setProductOpen(false)} onOk={() => productForm.submit()} open={productOpen} title={editingProduct ? "编辑订阅产品" : "新增订阅产品"}>
        <Form<ProductValues> form={productForm} layout="vertical" onFinish={saveProduct}>
          <Form.Item label="产品名称" name="name" rules={[{ required: true, message: "请输入产品名称" }]}><Input /></Form.Item>
          <Form.Item label="说明" name="description"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>

      <Modal okText="保存" onCancel={() => setVersionOpen(false)} onOk={() => versionForm.submit()} open={versionOpen} title={editingVersion ? "编辑产品版本" : "新增产品版本"}>
        <Form<VersionValues> form={versionForm} layout="vertical" onFinish={saveVersion}>
          <Form.Item label="产品编号 / 产品名称" name="productId" rules={[{ required: true, message: "请选择产品" }]}>
            <Select disabled={Boolean(editingVersion) || versionProductLocked} options={productOptions} placeholder="请选择产品" />
          </Form.Item>
          <Form.Item label="版本号" name="versionNo" rules={[{ required: true, message: "请输入版本号" }]}><Input /></Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}><DatePicker style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="失效日期" name="effectiveTo"><DatePicker allowClear style={{ width: "100%" }} /></Form.Item>
        </Form>
      </Modal>

      <Modal okText="保存" onCancel={() => setPackageOpen(false)} onOk={() => packageForm.submit()} open={packageOpen} title={editingPackage ? `编辑${packageMeta[packageKind].title}` : packageMeta[packageKind].createText} width={640}>
        <Form<PackageValues> form={packageForm} layout="vertical" onFinish={savePackage}>
          <Form.Item label="产品编号 / 产品名称" name="productId" rules={[{ required: true, message: "请选择产品" }]}>
            <Select options={productOptions} onChange={() => packageForm.setFieldValue("productVersionId", undefined)} />
          </Form.Item>
          <Form.Item label="产品版本" name="productVersionId" rules={[{ required: true, message: "请选择产品版本" }]}>
            <Select options={(selectedPackageProduct?.versions ?? []).map((version) => ({ label: version.versionNo, value: version.id }))} />
          </Form.Item>
          <Form.Item label={`${packageMeta[packageKind].title}名称`} name="packageName" rules={[{ required: true, message: "请输入名称" }]}><Input /></Form.Item>
          {packageKind === "vehicle" && editingPackage && !editingPackage.modelDefinitionId ? (
            <Alert
              showIcon
              style={{ marginBottom: 16 }}
              message="当前车型包仍使用兼容车型，建议补充车型代码主数据。"
              type="warning"
            />
          ) : null}
          {packageFields(packageKind, vehicleModelDefinitionOptions, syncPackageLegacyVehicleModel, !editingPackage)}
          <Form.Item label="备注" name="remark"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>

      <Modal
        okText="保存"
        onCancel={() => setPlanOpen(false)}
        onOk={() => planForm.submit()}
        open={planOpen}
        title={editingPlan ? "编辑订阅套餐" : "新增订阅套餐"}
        width={760}
      >
        <Form<PlanValues> form={planForm} layout="vertical" onFinish={savePlan}>
          <Form.Item label="产品" name="productId" rules={[{ required: true, message: "请选择产品" }]}>
            <Select
              disabled={Boolean(editingPlan)}
              options={productOptions}
              onChange={() =>
                planForm.setFieldsValue({
                  benefitPackageId: null,
                  energyPackageId: undefined,
                  mileagePackageId: undefined,
                  productVersionId: undefined,
                  vehiclePackageId: undefined
                })
              }
            />
          </Form.Item>
          <Form.Item label="产品版本" name="productVersionId" rules={[{ required: true, message: "请选择产品版本" }]}>
            <Select
              disabled={Boolean(editingPlan)}
              options={(selectedPlanProduct?.versions ?? []).map((version) => ({
                label: `${version.versionNo} / ${labelOf(PRODUCT_VERSION_STATUS_LABELS, version.status)}`,
                value: version.id
              }))}
              onChange={() =>
                planForm.setFieldsValue({
                  benefitPackageId: null,
                  energyPackageId: undefined,
                  mileagePackageId: undefined,
                  vehiclePackageId: undefined
                })
              }
            />
          </Form.Item>
          <Form.Item label="套餐名称" name="planName" rules={[{ required: true, message: "请输入套餐名称" }]}>
            <Input />
          </Form.Item>
          <Form.Item label="车辆使用费 / 车型包" name="vehiclePackageId" rules={[{ required: true, message: "请选择车辆使用费" }]}>
            <Select
              options={planVehicleOptions.map((row) => ({
                label: `${row.packageName} / ${packageModelDisplayName(row)} / ${formatRate(row.monthlyFeeRate)} / ${labelOf(STATUS_LABELS, row.status)}`,
                value: row.id
              }))}
            />
          </Form.Item>
          <Form.Item label="里程包" name="mileagePackageId" rules={[{ required: true, message: "请选择里程包" }]}>
            <Select
              options={planMileageOptions.map((row) => ({
                label: `${row.packageName} / ${row.monthlyMileageKm ?? "-"}km / ${labelOf(STATUS_LABELS, row.status)}`,
                value: row.id
              }))}
            />
          </Form.Item>
          <Form.Item label="补能包" name="energyPackageId" rules={[{ required: true, message: "请选择补能包" }]}>
            <Select
              options={planEnergyOptions.map((row) => ({
                label: `${row.packageName} / ${row.monthlyEnergyKwh ?? "-"}kWh / ${row.monthlyEnergyCount ?? "-"}次 / ${labelOf(STATUS_LABELS, row.status)}`,
                value: row.id
              }))}
            />
          </Form.Item>
          <Form.Item label="权益包" name="benefitPackageId">
            <Select
              allowClear
              options={planBenefitOptions.map((row) => ({
                label: `${row.packageName} / ${labelOf(BENEFIT_TYPE_LABELS, row.benefitType)} / ${labelOf(STATUS_LABELS, row.status)}`,
                value: row.id
              }))}
            />
          </Form.Item>
          <Descriptions
            bordered
            column={2}
            size="small"
            style={{ marginBottom: 16 }}
            items={[
              { label: "车型", children: packageModelDisplayName(selectedPlanVehiclePackage) },
              { label: "月费率", children: formatRate(selectedPlanVehiclePackage?.monthlyFeeRate) },
              {
                label: "采购价区间",
                children: `${formatYuan(selectedPlanVehiclePackage?.minPurchasePriceAmount)} - ${formatYuan(selectedPlanVehiclePackage?.maxPurchasePriceAmount)}`
              },
              {
                label: "周期范围",
                children: selectedPlanVehiclePackage
                  ? `${selectedPlanVehiclePackage.minPeriodMonths ?? "-"} - ${selectedPlanVehiclePackage.maxPeriodMonths ?? "-"} 个月`
                  : "-"
              },
              { label: "里程额度", children: selectedPlanMileagePackage ? `${selectedPlanMileagePackage.monthlyMileageKm ?? "-"} km/月` : "-" },
              { label: "超里程费", children: formatYuan(selectedPlanMileagePackage?.overMileageFeeAmount) },
              {
                label: "补能额度",
                children: selectedPlanEnergyPackage
                  ? `${selectedPlanEnergyPackage.monthlyEnergyKwh ?? "-"} kWh / ${selectedPlanEnergyPackage.monthlyEnergyCount ?? "-"} 次`
                  : "-"
              },
              { label: "权益说明", children: selectedPlanBenefitPackage?.description ?? selectedPlanBenefitPackage?.packageName ?? "-" }
            ]}
          />
          <Form.Item label="车辆基础月费模式" name="monthlyFeeMode" rules={[{ required: true, message: "请选择车辆基础月费模式" }]}>
            <Select
              options={Object.entries(monthlyFeeModeLabels).map(([value, label]) => ({ label, value }))}
            />
          </Form.Item>
          <Form.Item label="月费率" name="monthlyFeeRate" rules={[{ required: true, message: "请输入月费率" }]}>
            <InputNumber max={1} min={0} precision={6} step={0.001} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="车辆基础费上限率" name="monthlyFeeCapRate">
            <InputNumber max={1} min={0} precision={6} step={0.001} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="固定金额（元）" name="baseMonthlyFeeAmountYuan">
            <InputNumber min={0} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="最短周期（月）" name="minPeriodMonths" rules={[{ required: true, message: "请输入最短周期" }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="最长周期（月）" name="maxPeriodMonths" rules={[{ required: true, message: "请输入最长周期" }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="失效日期" name="effectiveTo">
            <DatePicker allowClear style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal footer={null} onCancel={() => setPlanDetail(null)} open={Boolean(planDetail)} title="订阅套餐详情" width={760}>
        {planDetail ? (
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "套餐编号", children: planDetail.planNo },
              { label: "套餐名称", children: planDetail.planName },
              { label: "产品", children: `${planDetail.product.productNo} / ${planDetail.product.name}` },
              { label: "产品版本", children: planDetail.productVersion.versionNo },
              { label: "车辆使用费", children: `${planDetail.vehiclePackage.packageName} / ${packageModelDisplayName(planDetail.vehiclePackage)}` },
              { label: "里程包", children: `${planDetail.mileagePackage.packageName} / ${planDetail.mileagePackage.monthlyMileageKm ?? "-"} km` },
              { label: "补能包", children: `${planDetail.energyPackage.packageName} / ${planDetail.energyPackage.monthlyEnergyKwh ?? "-"} kWh` },
              { label: "权益包", children: planDetail.benefitPackage?.packageName ?? "-" },
              { label: "车辆基础月费模式", children: monthlyFeeModeLabels[planDetail.monthlyFeeMode] ?? planDetail.monthlyFeeMode },
              { label: "月费率", children: formatRate(planDetail.monthlyFeeRate) },
              { label: "订阅周期", children: `${planDetail.minPeriodMonths} - ${planDetail.maxPeriodMonths} 个月` },
              { label: "状态", children: <Tag color={statusColors[planDetail.status]}>{labelOf(STATUS_LABELS, planDetail.status)}</Tag> },
              { label: "生效日期", children: planDetail.effectiveFrom },
              { label: "失效日期", children: planDetail.effectiveTo ?? "-" },
              { label: "备注", children: planDetail.remark ?? "-" }
            ]}
          />
        ) : null}
      </Modal>
    </ProtectedShell>
  );
}

function defaultPackageValues(kind: PackageKind): Partial<PackageValues> {
  const base = { priceAmountYuan: 0 };
  if (kind === "vehicle") {
    return { ...base, maxPeriodMonths: 36, minPeriodMonths: 12, modelDefinitionId: null, monthlyFeeRate: 0.035, vehicleModel: null };
  }
  if (kind === "mileage") {
    return { ...base, monthlyMileageKm: 1500, overMileageFeeAmountYuan: 1 };
  }
  if (kind === "energy") {
    return { ...base, monthlyEnergyCount: 10, monthlyEnergyKwh: 300 };
  }
  return { ...base, benefitType: "WASH_CAR", benefitCount: 1 };
}

function packageKindFromTab(tab: string): PackageKind | null {
  return Object.entries(packageMeta).find(([, meta]) => meta.tab === tab)?.[0] as PackageKind | null;
}

function packagePermission(kind: PackageKind, action: "activate" | "create" | "delete" | "update") {
  return `${kind}_package:${action}`;
}

function buildPackagePayload(kind: PackageKind, values: PackageValues) {
  const base = {
    packageName: values.packageName,
    productId: values.productId,
    productVersionId: values.productVersionId,
    remark: values.remark
  };
  if (kind === "vehicle") {
    const payload: Record<string, unknown> = {
      ...base,
      brand: values.brand,
      configName: values.configName,
      maxPeriodMonths: values.maxPeriodMonths,
      maxPurchasePriceAmount: toCents(values.maxPurchasePriceAmountYuan),
      minPeriodMonths: values.minPeriodMonths,
      minPurchasePriceAmount: toCents(values.minPurchasePriceAmountYuan),
      monthlyFeeRate: values.monthlyFeeRate,
      vehicleModelName: values.vehicleModelName
    };
    if (values.modelDefinitionId) {
      payload.modelDefinitionId = values.modelDefinitionId;
    }
    return payload;
  }
  if (kind === "mileage") {
    return {
      ...base,
      monthlyMileageKm: values.monthlyMileageKm,
      overMileageFeeAmount: toCents(values.overMileageFeeAmountYuan),
      priceAmount: toCents(values.priceAmountYuan)
    };
  }
  if (kind === "energy") {
    return {
      ...base,
      monthlyEnergyCount: values.monthlyEnergyCount,
      monthlyEnergyKwh: values.monthlyEnergyKwh,
      priceAmount: toCents(values.priceAmountYuan),
      serviceDescription: values.serviceDescription,
      stationScope: values.stationScope
    };
  }
  return {
    ...base,
    benefitCount: values.benefitCount,
    benefitType: values.benefitType,
    description: values.description,
    priceAmount: toCents(values.priceAmountYuan)
  };
}

function packageFields(
  kind: PackageKind,
  modelDefinitionOptions: Array<{ label: string; value: string }>,
  onModelDefinitionChange: (value?: string) => void,
  requireModelDefinition = false
) {
  if (kind === "vehicle") {
    return (
      <>
        <Form.Item
          extra="新增车型包必须关联车型主数据；仅展示已映射 legacy 车型的启用主数据。"
          label="车型代码（主数据）"
          name="modelDefinitionId"
          rules={
            requireModelDefinition
              ? [{ required: true, message: "请选择车型代码。新增车型包必须关联车型主数据。" }]
              : undefined
          }
        >
          <Select
            options={modelDefinitionOptions}
            onChange={(value?: string) => onModelDefinitionChange(value)}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item
          extra="兼容车型由车型代码自动带出，主要用于历史兼容。"
          label="兼容车型（legacy）"
          name="vehicleModel"
        >
          <Select disabled options={vehicleOptions} />
        </Form.Item>
        <Form.Item label="车型包展示名" name="vehicleModelName"><Input /></Form.Item>
        <Form.Item label="品牌" name="brand"><Input /></Form.Item>
        <Form.Item label="车系" name="series"><Input /></Form.Item>
        <Form.Item label="配置名称" name="configName"><Input /></Form.Item>
        <Form.Item label="月费率" name="monthlyFeeRate" rules={[{ required: true, message: "请输入月费率" }]}><InputNumber max={1} min={0} precision={6} step={0.001} style={{ width: "100%" }} /></Form.Item>
        <Form.Item label="最短周期（月）" name="minPeriodMonths" rules={[{ required: true, message: "请输入最短周期" }]}><InputNumber min={1} style={{ width: "100%" }} /></Form.Item>
        <Form.Item label="最长周期（月）" name="maxPeriodMonths" rules={[{ required: true, message: "请输入最长周期" }]}><InputNumber min={1} style={{ width: "100%" }} /></Form.Item>
        <Form.Item label="最低采购价（元）" name="minPurchasePriceAmountYuan"><InputNumber min={0} precision={2} style={{ width: "100%" }} /></Form.Item>
        <Form.Item label="最高采购价（元）" name="maxPurchasePriceAmountYuan"><InputNumber min={0} precision={2} style={{ width: "100%" }} /></Form.Item>
      </>
    );
  }
  if (kind === "mileage") {
    return (
      <>
        <Form.Item label="月里程额度（km）" name="monthlyMileageKm" rules={[{ required: true, message: "请输入月里程额度" }]}><InputNumber min={0} style={{ width: "100%" }} /></Form.Item>
        <Form.Item label="超里程单价（元/km）" name="overMileageFeeAmountYuan" rules={[{ required: true, message: "请输入超里程单价" }]}><InputNumber min={0} precision={2} style={{ width: "100%" }} /></Form.Item>
        <Form.Item label="价格（元）" name="priceAmountYuan"><InputNumber min={0} precision={2} style={{ width: "100%" }} /></Form.Item>
      </>
    );
  }
  if (kind === "energy") {
    return (
      <>
        <Form.Item label="月补能额度（kWh）" name="monthlyEnergyKwh"><InputNumber min={0} style={{ width: "100%" }} /></Form.Item>
        <Form.Item label="月补能次数" name="monthlyEnergyCount"><InputNumber min={0} style={{ width: "100%" }} /></Form.Item>
        <Form.Item label="价格（元）" name="priceAmountYuan"><InputNumber min={0} precision={2} style={{ width: "100%" }} /></Form.Item>
        <Form.Item label="补能场站范围" name="stationScope"><Input.TextArea rows={2} /></Form.Item>
        <Form.Item label="补能服务说明" name="serviceDescription"><Input.TextArea rows={2} /></Form.Item>
      </>
    );
  }
  return (
    <>
      <Form.Item label="权益类型" name="benefitType" rules={[{ required: true, message: "请选择权益类型" }]}><Select options={benefitOptions} /></Form.Item>
      <Form.Item label="权益次数" name="benefitCount"><InputNumber min={0} style={{ width: "100%" }} /></Form.Item>
      <Form.Item label="价格（元）" name="priceAmountYuan"><InputNumber min={0} precision={2} style={{ width: "100%" }} /></Form.Item>
      <Form.Item label="权益说明" name="description"><Input.TextArea rows={3} /></Form.Item>
    </>
  );
}

function packageTable(
  kind: PackageKind,
  rows: PackageRow[],
  openPackageModal: (kind: PackageKind, row?: PackageRow) => void,
  setPackageStatus: (kind: PackageKind, row: PackageRow, active: boolean) => void,
  deletePackage: (kind: PackageKind, row: PackageRow) => void,
  loading: boolean,
  permissions: ReadonlySet<string>
) {
  const columns: ColumnsType<PackageRow> = [
    { dataIndex: "packageNo", title: `${packageMeta[kind].title}编号`, width: 170 },
    { dataIndex: "packageName", title: `${packageMeta[kind].title}名称`, width: 180 },
    { dataIndex: ["product", "productNo"], title: "产品编号", width: 150 },
    { dataIndex: ["product", "name"], title: "产品名称", width: 200 },
    { dataIndex: ["productVersion", "versionNo"], title: "产品版本", width: 120 },
    ...packageSpecificColumns(kind),
    { dataIndex: "status", render: (value: string) => <Tag color={statusColors[value]}>{labelOf(STATUS_LABELS, value)}</Tag>, title: "状态", width: 100 },
    {
      render: (_, record) => (
        <Space>
          <ActionButton
            icon={<EditOutlined />}
            onClick={() => openPackageModal(kind, record)}
            permission={packagePermission(kind, "update")}
            permissions={permissions}
            size="small"
          >
            编辑
          </ActionButton>
          <ActionButton
            onClick={() => setPackageStatus(kind, record, record.status !== "ACTIVE")}
            permission={packagePermission(kind, "activate")}
            permissions={permissions}
            size="small"
          >
            {record.status === "ACTIVE" ? "停用" : "启用"}
          </ActionButton>
          <ActionButton
            danger
            icon={<DeleteOutlined />}
            onClick={() => deletePackage(kind, record)}
            permission={packagePermission(kind, "delete")}
            permissions={permissions}
            size="small"
          >
            删除
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 230
    }
  ];
  return <Table columns={columns} dataSource={rows} loading={loading} rowKey="id" scroll={{ x: 1500 }} />;
}

function packageSpecificColumns(kind: PackageKind): ColumnsType<PackageRow> {
  if (kind === "vehicle") {
    return [
      { render: (_, record) => record.modelDefinition?.modelCode ?? "-", title: "车型代码", width: 120 },
      { render: (_, record) => packageModelDisplayName(record), title: "车型显示名", width: 150 },
      { render: (_, record) => labelOf(VEHICLE_MODEL_LABELS, record.vehicleModel), title: "legacy 车型", width: 110 },
      { dataIndex: "monthlyFeeRate", render: formatRate, title: "月费率", width: 100 },
      { render: (_, record) => `${record.minPeriodMonths ?? "-"} - ${record.maxPeriodMonths ?? "-"} 个月`, title: "订阅周期", width: 140 }
    ];
  }
  if (kind === "mileage") {
    return [
      { dataIndex: "monthlyMileageKm", title: "月里程", width: 100 },
      { dataIndex: "overMileageFeeAmount", render: formatYuan, title: "超里程单价", width: 130 },
      { dataIndex: "priceAmount", render: formatYuan, title: "价格", width: 100 }
    ];
  }
  if (kind === "energy") {
    return [
      { dataIndex: "monthlyEnergyKwh", title: "补能额度", width: 110 },
      { dataIndex: "monthlyEnergyCount", title: "补能次数", width: 110 },
      { dataIndex: "priceAmount", render: formatYuan, title: "价格", width: 100 }
    ];
  }
  return [
    { dataIndex: "benefitType", render: (value: string) => labelOf(BENEFIT_TYPE_LABELS, value), title: "权益类型", width: 120 },
    { dataIndex: "benefitCount", title: "权益次数", width: 100 },
    { dataIndex: "priceAmount", render: formatYuan, title: "价格", width: 100 }
  ];
}
