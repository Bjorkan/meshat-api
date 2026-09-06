export type IataEntry = {
  code: string;
  name: string | null;
  type: "primary" | "secondary";
  primary_code: string;
};

// Codes/aliases: meshcore-mqtt-broker/config.yaml. Public county labels:
// operator-provided list, 2026-09-06. STO covers both Stockholm and Uppsala.
const primary: Record<string, { name: string; secondary?: string[] }> = {
  BLE: {
    name: "Dalarna",
    secondary: ["MXX", "SCR", "IDB"],
  },
  GOT: {
    name: "Västra Götalands län",
    secondary: ["GSE", "THN", "LDK", "KVB"],
  },
  GVX: { name: "Gävleborgs län", secondary: ["HUV", "SOO"] },
  HAD: { name: "Hallands län" },
  JKG: { name: "Jönköpings län" },
  KLR: {
    name: "Kalmar län",
    secondary: ["HLF", "OSK", "VVK"],
  },
  KSD: { name: "Värmlands län", secondary: ["TYF", "HFS"] },
  LLA: {
    name: "Norrbottens län",
    secondary: ["KRN", "GEV", "AJR", "PJA"],
  },
  LPI: { name: "Östergötlands län", secondary: ["NRK"] },
  MMX: { name: "Skåne län", secondary: ["AGH", "KID"] },
  NYO: { name: "Södermanlands län", secondary: ["EKT"] },
  ORB: { name: "Örebro län", secondary: ["KSK"] },
  OSD: { name: "Jämtlands län", secondary: ["EVG"] },
  RNB: { name: "Blekinge" },
  SDL: { name: "Västernorrlands län", secondary: ["OER", "KRF"] },
  STO: { name: "Stockholms län och Uppsala län", secondary: ["ARN", "BMA"] },
  UME: {
    name: "Västerbottens län",
    secondary: ["SFT", "VHM", "HMV", "LYC", "SQO"],
  },
  VBY: { name: "Gotland" },
  VST: { name: "Västmanlands län" },
  VXO: { name: "Kronobergs län" },
};

export const iataEntries: IataEntry[] = Object.entries(primary)
  .flatMap(([code, value]) => [
    { code, name: value.name, type: "primary" as const, primary_code: code },
    ...(value.secondary ?? []).map((secondary) => ({
      code: secondary,
      name: null,
      type: "secondary" as const,
      primary_code: code,
    })),
  ])
  .sort((left, right) => left.code.localeCompare(right.code));

export function getIata(code: string) {
  return iataEntries.find((entry) => entry.code === code.trim().toUpperCase());
}
