// UI clip audit: paste this whole function into Playwright's browser_evaluate (or DevTools) on any page.
// Run it at 375x812 and 1440x900 at minimum (plus the widths the page breaks at), in every state that changes text
// length, BEFORE calling a UI change done. Then still take one screenshot and look at it.
// Reports: elements spilling out of a clipping parent, borders or text cut by a rounded corner, text overflowing its
// box, inputs/selects/buttons whose text does not fit, text cut hard at the edge of a scroll strip with no fade,
// and horizontal page overflow. Background fills clipped by a rounded parent are by design and are not reported.
// Mark overlays that are clipped on purpose (chart markers, tooltips) with a data-audit-skip attribute.
// Verified 2026-10-21: catches a planted cut corner border, overflowing text, a spill-out, and a scroll strip
// without a fade; false positives fixed for top-border-only footers and rounded split boxes.
() => {
  const SKIP = el => el.closest("canvas, iframe, svg, [data-audit-skip]");
  const out = {w: innerWidth, overflowX: document.documentElement.scrollWidth - innerWidth, clipped: [], corners: [], text: [], inputs: []};
  const name = el => (el.id ? "#" + el.id : el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : ""));
  const textRects = el => { const rs = []; el.childNodes.forEach(n => { if (n.nodeType === 3 && n.textContent.trim()) { const g = document.createRange(); g.selectNodeContents(n); rs.push(...g.getClientRects()); } }); return rs; };
  const inArc = (x, y, box, rr) => { const cs = [[box.l, box.t, 1, 1], [box.r, box.t, -1, 1], [box.l, box.b, 1, -1], [box.r, box.b, -1, -1]];
    return cs.some(([cx, cy, sx, sy]) => { const dx = (x - cx) * sx, dy = (y - cy) * sy; if (dx < 0 || dy < 0 || dx >= rr || dy >= rr) return false; return Math.hypot(rr - dx, rr - dy) > rr + 0.75; }); };
  const all = [...document.querySelectorAll("body *")].filter(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && !SKIP(el); });
  for (const el of all) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {     // nearest clipping ancestor
      const ac = getComputedStyle(a), ox = ac.overflowX, oy = ac.overflowY;
      if (ox === "visible" && oy === "visible") continue;
      const ar = a.getBoundingClientRect(), bl = a.clientLeft, bt = a.clientTop;
      const box = {l: ar.left + bl, t: ar.top + bt, r: ar.left + bl + a.clientWidth, b: ar.top + bt + a.clientHeight};
      const hidX = ox === "hidden" || ox === "clip", hidY = oy === "hidden" || oy === "clip";
      if ((hidX && (r.left < box.l - 1 || r.right > box.r + 1)) || (hidY && (r.top < box.t - 1 || r.bottom > box.b + 1)))
        out.clipped.push(`${name(el)} spills out of ${name(a)} L${Math.round(box.l - r.left)} R${Math.round(r.right - box.r)} T${Math.round(box.t - r.top)} B${Math.round(r.bottom - box.b)}`);
      const rr = (parseFloat(ac.borderTopLeftRadius) || 0) - bl;
      if (rr > 2 && (hidX || hidY)) {
        const er = parseFloat(cs.borderTopLeftRadius) || 0, b = s => parseFloat(cs["border" + s + "Width"]) > 0;
        const corners = [[r.left, r.top, b("Top") || b("Left")], [r.right, r.top, b("Top") || b("Right")], [r.left, r.bottom, b("Bottom") || b("Left")], [r.right, r.bottom, b("Bottom") || b("Right")]];
        if (corners.some(([x, y, has]) => has && er < rr - 0.75 && inArc(x, y, box, rr))) out.corners.push(`${name(el)}: border cut by rounded corner of ${name(a)}`);
        for (const t of textRects(el)) if ([[t.left, t.top], [t.right, t.top], [t.left, t.bottom], [t.right, t.bottom]].some(([x, y]) => inArc(x, y, box, rr))) { out.corners.push(`${name(el)}: text cut by rounded corner of ${name(a)}`); break; }
      }
      break;
    }
    if ((cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.textOverflow === "ellipsis") && el.scrollWidth > el.clientWidth + 1 && el.children.length === 0 && el.textContent.trim())
      out.text.push(`${name(el)} text overflows (${el.scrollWidth} > ${el.clientWidth}): "${el.textContent.trim().slice(0, 40)}"`);
    for (const t of textRects(el)) {
      let sc = null; for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === "auto" || o === "scroll") { sc = a; break; } }
      const scr = sc && sc.getBoundingClientRect(), edgeR = scr ? Math.min(scr.right, innerWidth) : innerWidth, edgeL = scr ? Math.max(scr.left, 0) : 0;
      if (t.right > edgeR + 1 || t.left < edgeL - 1) {
        const masked = sc && (getComputedStyle(sc).maskImage || getComputedStyle(sc).webkitMaskImage || "none") !== "none";
        if (!sc) out.text.push(`${name(el)} text runs off screen`);
        else if (!masked && sc.tagName !== "TABLE") out.text.push(`${name(el)} cut hard at the edge of scroll strip ${name(sc)} (add a mask-image fade)`);
        break;
      }
    }
    if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "BUTTON") {
      const c = document.createElement("canvas").getContext("2d"); c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const txt = el.tagName === "SELECT" ? (el.selectedOptions[0]?.text || "") : el.tagName === "INPUT" ? (el.value || el.placeholder || "") : el.innerText.trim().split("\n")[0];
      const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (el.tagName === "SELECT" ? 18 : 0);
      if (txt && (el.tagName !== "BUTTON" || cs.whiteSpace === "nowrap" || el.scrollWidth > el.clientWidth + 1) && c.measureText(txt).width > inner + 1)
        out.inputs.push(`${name(el)} "${txt.slice(0, 30)}" needs ${Math.round(c.measureText(txt).width)}px, has ${Math.round(inner)}px`);
    }
  }
  for (const k of ["clipped", "corners", "text", "inputs"]) out[k] = [...new Set(out[k])].slice(0, 30);
  return out;
}
