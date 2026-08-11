import { areaList } from "@vant/area-data";

export interface ChinaRegionOption {
  children?: ChinaRegionOption[];
  label: string;
  value: string;
}

const cityEntries = Object.entries(areaList.city_list);
const districtEntries = Object.entries(areaList.county_list);

export const CHINA_REGION_OPTIONS: ChinaRegionOption[] = Object.entries(
  areaList.province_list
).map(([provinceCode, provinceName]) => ({
  children: cityEntries
    .filter(([cityCode]) => cityCode.slice(0, 2) === provinceCode.slice(0, 2))
    .map(([cityCode, cityName]) => ({
      children: districtEntries
        .filter(([districtCode]) => districtCode.slice(0, 4) === cityCode.slice(0, 4))
        .map(([, districtName]) => ({ label: districtName, value: districtName })),
      label: cityName,
      value: cityName
    })),
  label: provinceName,
  value: provinceName
}));
