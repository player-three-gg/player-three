// HTML/CSS templates for the README art, one per banner `type` in banners.json. Every template returns a `.stage`
// element; render.mjs captures it. Layout units are CSS pixels (captured at the entry's device scale factor).
// Comic/arcade look: skewed plates with thick ink outlines and offset shadows, two-tone fills under a light top band,
// Bangers display type with an ink stroke, Special Elite typewriter captions and hazard stripes.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Shared stylesheet; `p` is the entry's palette (see `palettes` in banners.json). */
export function css(p, fonts) {
  return `
@font-face { font-family: Bangers; src: url(${fonts.bangers}) format('woff2'); }
@font-face { font-family: Elite; src: url(${fonts.elite}) format('woff2'); }
:root { --ink: ${p.ink}; --tab0: ${p.tab[0]}; --tab1: ${p.tab[1]}; --tab2: ${p.tab[2]}; --plate0: ${p.plate[0]}; --plate1: ${p.plate[1]};
  --plate2: ${p.plate[2]}; --slip0: ${p.slip[0]}; --slip1: ${p.slip[1]}; --num: ${p.number}; --title: ${p.title}; --lift: ${p.titleShadow};
  --sub: ${p.subtitle}; --hazard: ${p.hazard}; --cream: ${p.cream}; }
* { box-sizing: border-box; margin: 0; }
html, body { background: transparent; }
.stage { position: relative; overflow: visible; }
.hazard { position: absolute; background: repeating-linear-gradient(-55deg, var(--ink) 0 18px, var(--hazard) 18px 36px); border: 4px solid var(--ink); }
.plate { position: absolute; transform: skewX(-14deg); border: 7px solid var(--ink); box-shadow: 10px 10px 0 var(--ink); }
.plate > .unskew { transform: skewX(14deg); height: 100%; display: flex; align-items: center; }
.plate-c { background: linear-gradient(180deg, var(--plate0) 0 10%, var(--plate1) 10% 62%, var(--plate2) 62%); }
.tab-c { background: linear-gradient(180deg, var(--tab0) 0 10%, var(--tab1) 10% 64%, var(--tab2) 64%); }
.slip-c { background: linear-gradient(180deg, var(--slip0) 0 10%, var(--slip1) 10%); }
.bang { font-family: Bangers; letter-spacing: 0.04em; line-height: 1; white-space: nowrap; }
.outline { -webkit-text-stroke: 3px var(--ink); paint-order: stroke fill; }
.elite { font-family: Elite; white-space: nowrap; }
`;
}

/** A section plate: number tab, title plate with icon, subtitle slip, hazard stripes trailing right. */
export function header(e, { icon }) {
  return `<div class="stage" style="width:1200px;height:170px">
    <div class="hazard" style="left:760px;top:58px;width:420px;height:46px;transform:skewX(-14deg)"></div>
    <div class="plate plate-c" style="left:120px;top:22px;width:820px;height:112px">
      <div class="unskew" style="padding-left:58px;gap:22px">
        ${icon(e.icon, { size: 64, color: 'var(--ink)', stroke: 2.4 })}
        <span class="bang" data-fit="650" style="font-size:74px;color:var(--title);text-shadow:3px 3px 0 var(--lift)">${esc(e.title)}</span>
      </div>
    </div>
    <div class="plate tab-c" style="left:22px;top:12px;width:150px;height:132px">
      <div class="unskew" style="justify-content:center"><span class="bang outline" style="font-size:78px;color:var(--num)">${esc(e.number)}</span></div>
    </div>
    <div class="plate slip-c" style="left:590px;top:112px;width:470px;height:48px;border-width:5px;box-shadow:6px 6px 0 var(--ink)">
      <div class="unskew" style="justify-content:center"><span class="elite" data-fit="420" style="font-size:24px;color:var(--sub);letter-spacing:0.06em">${esc(e.subtitle)}</span></div>
    </div>
  </div>`;
}

/** The big call-to-action: a hazard-framed tab-coloured plate with a play triangle, title and caption. */
export function button(e) {
  return `<div class="stage" style="width:1100px;height:250px">
    <div class="hazard" style="left:40px;top:24px;width:1020px;height:200px;transform:skewX(-14deg)"></div>
    <div class="plate tab-c" style="left:80px;top:40px;width:940px;height:168px">
      <div class="unskew" style="justify-content:center;gap:34px">
        <svg width="104" height="104" viewBox="0 0 24 24"><path d="M6 3.5v17l14-8.5z" fill="var(--hazard)" stroke="var(--ink)" stroke-width="1.6" stroke-linejoin="round"/></svg>
        <div style="display:flex;flex-direction:column;align-items:flex-start;gap:6px">
          <span class="bang outline" style="font-size:124px;color:var(--num);text-shadow:6px 6px 0 var(--ink)">${esc(e.title)}</span>
          <span class="elite" data-fit="780" style="font-size:30px;color:var(--cream);letter-spacing:0.08em">${esc(e.subtitle)}</span>
        </div>
      </div>
    </div>
  </div>`;
}

/** A wrapping strip of small skewed feature badges. Each item is { label, tone: plate | tab | slip }. */
export function badges(e) {
  return `<div class="stage" style="display:flex;flex-wrap:wrap;gap:14px 26px;width:1240px;padding:8px 20px 14px">
    ${e.items.map(({ label, tone }) => `<div class="plate ${tone}-c" style="position:relative;height:52px;border-width:5px;box-shadow:5px 5px 0 var(--ink)">
      <div class="unskew" style="padding:0 22px;justify-content:center"><span class="bang ${tone === 'slip' ? '' : 'outline'}" style="font-size:31px;color:${tone === 'plate' ? 'var(--title)' : 'var(--num)'};${tone === 'plate' ? '-webkit-text-stroke:0' : ''}">${esc(label)}</span></div>
    </div>`).join('')}
  </div>`;
}

/**
 * Rows of cards, each row led by a label plate. A row is { label, tone: plate | slip, cards: [{ icon, title,
 * subtitle }] }; `plate` rows are the bright palette cards, `slip` rows the dark ones (perforated bottom edge).
 */
export function cardGrid(e, { icon }) {
  const rowH = 158, cardW = 239, cardH = 116, pitch = 268, left = 206;
  return `<div class="stage" style="width:${left + pitch * Math.max(...e.rows.map((r) => r.cards.length)) + 20}px;height:${rowH * e.rows.length + 10}px">
    ${e.rows.map((row, r) => {
      const top = 4 + r * rowH, dark = row.tone === 'slip';
      return `<div class="plate ${dark ? 'slip-c' : 'tab-c'}" style="left:16px;top:${top + 25}px;width:172px;height:66px;border-width:6px;box-shadow:8px 8px 0 var(--ink)">
          <div class="unskew" style="justify-content:center"><span class="bang outline" data-fit="140" style="font-size:44px;color:var(--cream)">${esc(row.label)}</span></div>
        </div>
        ${row.cards.map((c, i) => `<div class="plate ${dark ? 'slip-c' : 'plate-c'}" style="left:${left + i * pitch}px;top:${top}px;width:${cardW}px;height:${cardH}px;border-width:6px;box-shadow:8px 8px 0 var(--ink)${dark ? ';border-bottom-width:0' : ''}">
          ${dark ? '<div style="position:absolute;left:0;right:0;bottom:0;height:7px;background:repeating-linear-gradient(90deg, var(--ink) 0 9px, var(--slip0) 9px 18px);border-bottom:6px solid var(--ink);box-sizing:content-box;transform:translateY(6px)"></div>' : ''}
          <div class="unskew" style="flex-direction:column;justify-content:center;gap:4px">
            ${icon(c.icon, { size: 30, color: dark ? 'var(--plate1)' : 'var(--ink)', stroke: 2.2 })}
            <span class="bang" data-fit="${cardW - 30}" style="font-size:34px;color:${dark ? 'var(--plate1)' : 'var(--title)'}">${esc(c.title)}</span>
            <div style="display:flex;flex-direction:column;align-items:center">${[].concat(c.subtitle).map((line) => `<span class="elite" data-fit="${cardW - 34}" style="font-size:15px;line-height:1.1;color:${dark ? 'var(--cream)' : 'var(--title)'};letter-spacing:0.02em">${esc(line)}</span>`).join('')}</div>
          </div>
        </div>`).join('')}`;
    }).join('')}
  </div>`;
}

/**
 * Fixed-size social images. `layout: preview` is the repository social preview (logo over a dark radial field between
 * hazard bands, a caption slip and the site); `layout: card` is the Open Graph card (the backdrop still under a dark
 * gradient, logo, tagline lines, a facts line and the site).
 */
export function social(e, { asset }) {
  const [w, h] = e.size;
  if (e.layout === 'preview') {
    const band = (top, height) => `<div style="position:absolute;left:0;right:0;top:${top}px;height:${height}px;background:repeating-linear-gradient(-55deg, var(--hazard) 0 22px, var(--ink) 22px 44px)"></div>`;
    return `<div class="stage" style="width:${w}px;height:${h}px;overflow:hidden;background:radial-gradient(ellipse 62% 70% at 50% 42%, ${e.glow} 0%, var(--ink) 100%)">
      ${band(24, 22)}${band(563, 40)}
      <img src="${asset(e.logo)}" style="position:absolute;left:${(w - 560) / 2}px;top:80px;width:560px">
      <div class="plate slip-c" style="left:172px;top:424px;width:936px;height:66px;border-width:0;box-shadow:none">
        <div class="unskew" style="justify-content:center"><span class="elite" data-fit="900" style="font-size:30px;color:var(--cream);letter-spacing:0.01em">${esc(e.caption)}</span></div>
      </div>
      <div class="bang" style="position:absolute;left:0;right:0;top:508px;text-align:center;font-size:44px;color:var(--hazard);letter-spacing:0.02em">${esc(e.site)}</div>
    </div>`;
  }
  return `<div class="stage" style="width:${w}px;height:${h}px;overflow:hidden;background:var(--ink)">
    <img src="${asset(e.background)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
    <div style="position:absolute;inset:0;background:linear-gradient(90deg, rgba(18,6,0,0.96) 0%, rgba(18,6,0,0.9) 38%, rgba(18,6,0,0.35) 66%, rgba(18,6,0,0.05) 100%)"></div>
    <div style="position:absolute;left:0;right:0;top:0;height:7px;background:var(--hazard)"></div>
    <img src="${asset(e.logo)}" style="position:absolute;left:38px;top:38px;width:660px">
    <div class="bang" style="position:absolute;left:48px;top:318px;font-size:52px;color:var(--cream);letter-spacing:0.03em;-webkit-text-stroke:2px var(--ink);paint-order:stroke fill;text-shadow:4px 4px 0 var(--ink)">${esc(e.tagline[0])}</div>
    <div class="elite" style="position:absolute;left:48px;top:388px;font-size:30px;color:${e.accent}">${esc(e.tagline[1])}</div>
    <div style="position:absolute;left:44px;top:456px;width:466px;height:2px;background:var(--plate2)"></div>
    <div class="elite" style="position:absolute;left:48px;top:482px;font-size:22px;color:var(--cream)">${esc(e.facts)}</div>
    <div class="bang" style="position:absolute;left:48px;top:548px;font-size:38px;color:var(--hazard);letter-spacing:0.05em">${esc(e.site)}</div>
  </div>`;
}
