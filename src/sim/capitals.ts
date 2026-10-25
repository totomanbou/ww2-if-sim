/** Names corresponding to the fixed capital coordinates in data/border-fixes.json. */
export const CAPITAL_NAMES: Readonly<Record<string, string>> = {
  GER: "ベルリン", ITA: "ローマ", JAP: "東京", UK: "ロンドン", FRA: "パリ", USA: "ワシントンD.C.",
  SOV: "モスクワ", CHN: "重慶", NEI: "バタヴィア", IND: "ニューデリー", POL: "ワルシャワ", CAN: "オタワ",
  AST: "キャンベラ", NZL: "ウェリントン", SAF: "プレトリア", HOL: "アムステルダム", BEL: "ブリュッセル",
  LUX: "ルクセンブルク", DEN: "コペンハーゲン", NOR: "オスロ", SWE: "ストックホルム", FIN: "ヘルシンキ",
  EST: "タリン", LAT: "リガ", LIT: "カウナス", IRE: "ダブリン", SPA: "マドリード", POR: "リスボン",
  SWI: "ベルン", HUN: "ブダペスト", ROM: "ブカレスト", BUL: "ソフィア", YUG: "ベオグラード",
  GRE: "アテネ", TUR: "アンカラ", SLO: "ブラチスラヴァ", IRN: "テヘラン", AFG: "カブール",
  SAU: "リヤド", YEM: "サナア", SIA: "バンコク", NEP: "カトマンズ", BHU: "ティンプー",
  MON: "ウランバートル", TIB: "ラサ", LBR: "モンロビア", MEX: "メキシコシティ", CUB: "ハバナ",
  HAI: "ポルトープランス", DOM: "サントドミンゴ", GUA: "グアテマラシティ", HON: "テグシガルパ",
  ELS: "サンサルバドル", NIC: "マナグア", COS: "サンホセ", PAN: "パナマシティ", COL: "ボゴタ",
  VEN: "カラカス", ECU: "キト", PER: "リマ", BOL: "ラパス", CHL: "サンティアゴ",
  ARG: "ブエノスアイレス", URU: "モンテビデオ", PAR: "アスンシオン", BRA: "リオデジャネイロ",
};

export function capitalName(tag: string): string { return CAPITAL_NAMES[tag] ?? `${tag}の首都`; }
