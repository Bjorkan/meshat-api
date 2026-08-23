export type IataEntry = {
  code: string;
  name: string | null;
  type: "primary" | "secondary";
  primary_code: string;
};

// Source: the operator-maintained Swedish mapping in meshcore-mqtt-broker/config.yaml.
const primary: Record<string, { name: string; secondary?: string[] }> = {
  BLE: {
    name: "Borlänge, Falun och Dalarna",
    secondary: ["MXX", "SCR", "IDB"],
  },
  GOT: {
    name: "Göteborg Landvetter och Västra Götaland",
    secondary: ["GSE", "THN", "LDK", "KVB"],
  },
  GVX: { name: "Gävle, Sandviken och Gästrikland", secondary: ["HUV", "SOO"] },
  HAD: { name: "Halmstad och Halland" },
  JKG: { name: "Jönköping och södra Vätternområdet" },
  KLR: {
    name: "Kalmar och sydöstra Småland",
    secondary: ["HLF", "OSK", "VVK"],
  },
  KSD: { name: "Karlstad och Värmland", secondary: ["TYF", "HFS"] },
  LLA: {
    name: "Luleå och Norrbottenskusten",
    secondary: ["KRN", "GEV", "AJR", "PJA"],
  },
  LPI: { name: "Linköping och Östergötland", secondary: ["NRK"] },
  MMX: { name: "Malmö Sturup och södra Skåne", secondary: ["AGH", "KID"] },
  NYO: { name: "Stockholm Skavsta, Nyköping och Sörmland", secondary: ["EKT"] },
  ORB: { name: "Örebro och Närke", secondary: ["KSK"] },
  OSD: { name: "Östersund, Åre och Jämtland", secondary: ["EVG"] },
  RNB: { name: "Ronneby, Karlskrona och Blekinge" },
  SDL: { name: "Sundsvall, Timrå och Medelpad", secondary: ["OER", "KRF"] },
  STO: { name: "Stockholmsområdet", secondary: ["ARN", "BMA"] },
  UME: {
    name: "Umeå och Västerbottenskusten",
    secondary: ["SFT", "VHM", "HMV", "LYC", "SQO"],
  },
  VBY: { name: "Visby och Gotland" },
  VST: { name: "Västerås och Mälardalen" },
  VXO: { name: "Växjö och Kronoberg" },
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
