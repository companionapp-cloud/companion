// A live read-out of the viewport numbers viewportFit.ts works from, for checking the keyboard
// fit on a real iPhone or iPad (no simulator reproduces Safari's keyboard and toolbars). Open the
// app with `?debug=viewport` once; it sticks (Home Screen launches drop the query string) until
// `?debug=off`. A red line marks the visible area's bottom edge as the browser reports it: with
// the keyboard up, anything the system draws over or below that line is chrome the page can't see.

const KEY = "companion.debug.viewport";

function enabled(): boolean {
  try {
    const flag = new URLSearchParams(window.location.search).get("debug");
    if (flag === "viewport") localStorage.setItem(KEY, "1");
    else if (flag === "off") localStorage.removeItem(KEY);
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function installViewportDebug(): void {
  const vv = window.visualViewport;
  if (!vv || !enabled()) return;

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;z-index:2147483647;left:8px;right:8px;top:calc(env(safe-area-inset-top,0px) + 4px);" +
    "padding:4px 8px;border-radius:6px;background:rgba(17,17,16,.82);color:#fff;pointer-events:none;" +
    "font:500 11px/15px ui-monospace,Menlo,monospace;white-space:pre-wrap";
  const line = document.createElement("div");
  line.style.cssText = "position:fixed;z-index:2147483647;left:0;right:0;height:2px;background:#e5484d;pointer-events:none";
  // env() only resolves in CSS, so a probe carries the safe-area insets into computed style.
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)";
  document.body.append(probe, line, panel);

  const px = (n: number) => Math.round(n * 10) / 10;
  const render = () => {
    const probeStyle = getComputedStyle(probe);
    const root = document.getElementById("root")?.getBoundingClientRect();
    const fitted = document.documentElement.classList.contains("vv-fit");
    panel.textContent =
      `inner ${window.innerWidth}×${window.innerHeight}  client ${document.documentElement.clientHeight}  scrollY ${px(window.scrollY)}\n` +
      `vv ${px(vv.width)}×${px(vv.height)} @${px(vv.offsetTop)} page ${px(vv.pageTop)} scale ${px(vv.scale)}\n` +
      `safe top ${probeStyle.paddingTop} bottom ${probeStyle.paddingBottom}  fit ${fitted ? "on" : "off"}` +
      (root ? `  root ${px(root.top)}→${px(root.bottom)}` : "");
    line.style.top = `${vv.offsetTop + vv.height - 2}px`;
  };
  vv.addEventListener("resize", render);
  vv.addEventListener("scroll", render);
  window.addEventListener("resize", render);
  document.addEventListener("focusin", () => setTimeout(render, 0));
  render();
}
