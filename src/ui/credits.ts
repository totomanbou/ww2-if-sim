import { el } from "./dom";

/** A link opening in a new tab. */
function link(href: string, text: string): HTMLElement {
  return el("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
}

/**
 * "About this simulator": what it is, the data sources with their licenses, and the program's license. The map is
 * derived from historical-basemaps (GPL-3.0), so the attribution and the license notice must be visible to users.
 */
export function creditsPanel(): HTMLElement {
  return el("details", { class: "panel credits" },
    el("summary", {}, "このシミュレーターについて・出典"),
    el("p", {}, "1939年9月1日から始まる第二次世界大戦を、国ごとの設定を変えて観察する架空戦記シミュレーターです。" +
      "結果は簡略化したモデルと乱数によるもので、史実の再現や特定の国・人物の評価を意図したものではありません。"),
    el("h3", {}, "地図・地形データ"),
    el("ul", {},
      el("li", {}, link("https://github.com/aourednik/historical-basemaps", "historical-basemaps"),
        "(André Ourednik)の world_1938。GPL-3.0。国境と所有国の元データ。"),
      el("li", {}, link("https://www.naturalearthdata.com/", "Natural Earth"),
        "の陸地・小島・地域・河川データ。パブリックドメイン。"),
      el("li", {}, link("https://www.geoboundaries.org/", "geoBoundaries"),
        "のウクライナ境界(地形難易度の指定のみに使用)。ODbL 1.0。境界の元データは © ",
        link("https://www.openstreetmap.org/copyright", "OpenStreetMap contributors"), "。"),
    ),
    el("h3", {}, "ライセンス"),
    el("p", {}, "このプログラムと地図データは ",
      link("https://www.gnu.org/licenses/gpl-3.0.html", "GNU General Public License v3.0"),
      " で公開しています。無保証です。ソースコード: ",
      link("https://github.com/totomanbou/ww2-if-sim", "github.com/totomanbou/ww2-if-sim"), "。"),
  );
}
