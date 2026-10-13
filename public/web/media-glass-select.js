// Three-way liquid-glass selector. Controlled: pass value and onChange.
// Values are "movie" | "both" | "tv".

const MEDIA_GLASS_OPTIONS = [
  { value: "movie", label: "Movies", icon: "film" },
  { value: "both", label: "Both", icon: "both" },
  { value: "tv", label: "TV Shows", icon: "tv" },
];

function circlePath(cx, cy, r) {
  return `M ${cx - r} ${cy}a ${r} ${r} 0 1 0 ${r * 2} 0a ${r} ${r} 0 1 0 ${-r * 2} 0`;
}

function filmShapes(h, withTail) {
  const cx = 32;
  const cy = 30;
  const holes = [[cx, cy, 2.5]];
  for (let i = 0; i < 5; i += 1) {
    const angle = ((-90 + i * 72) * Math.PI) / 180;
    holes.push([cx + Math.cos(angle) * 13.1, cy + Math.sin(angle) * 13.1, 4.85]);
  }
  const disc = [circlePath(cx, cy, 23.4), ...holes.map(([x, y, r]) => circlePath(x, y, r))].join("");
  const shapes = [h("path", { d: disc, fill: "currentColor", fillRule: "evenodd" })];
  if (withTail) {
    shapes.push(
      h("path", {
        d: "M47.4 44.6c2.4-.4 6.6.8 8.6 3.6 1.6 2.2 1.2 4.6-1.2 5.4-2.8.9-6.4-.6-8.2-3.2-1.6-2.2-1.8-4.8-.4-5.6.6-.3.8-.3 1.2-.2z",
        fill: "currentColor",
      })
    );
  }
  return shapes;
}

function tvShapes(h) {
  const frame = [
    "M18 22H46A12 12 0 0 1 58 34V50A12 12 0 0 1 46 62H18A12 12 0 0 1 6 50V34A12 12 0 0 1 18 22Z",
    "M22 31H42A6 6 0 0 1 48 37V47A6 6 0 0 1 42 53H22A6 6 0 0 1 16 47V37A6 6 0 0 1 22 31Z",
  ].join("");
  return [
    h("path", { d: frame, fill: "currentColor", fillRule: "evenodd" }),
    h("path", {
      d: "M22 6L32 21.5M42 6L32 21.5",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "5.5",
      strokeLinecap: "round",
    }),
  ];
}

function mediaGlassIcon(h, name) {
  if (name === "both") {
    return h(
      "svg",
      { viewBox: "4 0 100 68", "aria-hidden": "true" },
      h("g", { transform: "translate(42,3) scale(0.98)" }, tvShapes(h)),
      h("g", { transform: "translate(6,2) scale(0.96)" }, filmShapes(h, false))
    );
  }
  if (name === "tv") {
    return h("svg", { viewBox: "2 2 60 64", "aria-hidden": "true" }, tvShapes(h));
  }
  return h("svg", { viewBox: "0 0 64 68", "aria-hidden": "true" }, filmShapes(h, true));
}

function mediaGlassIndex(value) {
  const index = MEDIA_GLASS_OPTIONS.findIndex((option) => option.value === value);
  return index === -1 ? 1 : index;
}

function MediaGlassSelect({ value = "both", onChange, labelledBy }) {
  const h = React.createElement;
  const trackRef = React.useRef(null);
  const pillRef = React.useRef(null);
  const dragRef = React.useRef(null);
  const suppressClickRef = React.useRef(false);
  const uid = React.useId().replace(/:/g, "");
  const index = mediaGlassIndex(value);
  const sheenId = `mgs-sheen-${uid}`;

  const placePill = (position) => {
    const pill = pillRef.current;
    if (!pill) return;
    pill.classList.add("is-dragging");
    pill.style.setProperty("--i", String(position));
  };

  React.useLayoutEffect(() => {
    if (dragRef.current?.active) return;
    const pill = pillRef.current;
    if (!pill) return;
    pill.classList.remove("is-dragging");
    pill.style.setProperty("--i", String(index));
  }, [index]);

  const indexFromClient = (clientX) => {
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = rect.width ? (clientX - rect.left) / rect.width : 0;
    return Math.max(0, Math.min(2, ratio * 3 - 0.5));
  };

  const commit = (nextIndex) => {
    const next = MEDIA_GLASS_OPTIONS[nextIndex].value;
    const pill = pillRef.current;
    if (pill) pill.classList.remove("is-dragging");
    requestAnimationFrame(() => {
      pill?.style.setProperty("--i", String(nextIndex));
      if (next !== value) onChange?.(next);
    });
  };

  const onPointerDown = (event) => {
    if (event.button != null && event.button !== 0) return;
    trackRef.current.setPointerCapture(event.pointerId);
    dragRef.current = { active: true, moved: false, startX: event.clientX };
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag?.active) return;
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < 6) return;
    drag.moved = true;
    placePill(indexFromClient(event.clientX));
  };

  const onPointerUp = (event) => {
    const drag = dragRef.current;
    if (!drag?.active) return;
    dragRef.current = null;
    suppressClickRef.current = drag.moved;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    const tapped = Math.max(0, Math.min(2, Math.floor(ratio * 3)));
    const dragged = Math.max(0, Math.min(2, Math.round(indexFromClient(event.clientX))));
    commit(drag.moved ? dragged : tapped);
  };

  const onPointerCancel = () => {
    if (!dragRef.current?.active) return;
    dragRef.current = null;
    placePill(index, true);
  };

  const onKeyDown = (event) => {
    const current = mediaGlassIndex(value);
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = Math.min(2, current + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 2;
    else return;
    event.preventDefault();
    commit(next);
    const nextValue = MEDIA_GLASS_OPTIONS[next].value;
    requestAnimationFrame(() => {
      trackRef.current?.querySelector(`[data-value="${nextValue}"]`)?.focus();
    });
  };

  const onClick = (event) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const button = event.target.closest("[data-value]");
    if (!button) return;
    commit(mediaGlassIndex(button.dataset.value));
  };

  return h(
    "div",
    {
      className: "mgs",
      ref: trackRef,
      role: "radiogroup",
      "aria-labelledby": labelledBy,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onKeyDown,
      onClick,
    },
    h(
      "div",
      { className: "mgs-pill", ref: pillRef, style: { "--i": index }, "aria-hidden": "true" },
      h(
        "div",
        { className: "mgs-pill-glass" },
        h(
          "svg",
          { className: "mgs-sheen", viewBox: "0 0 160 110", preserveAspectRatio: "none" },
          h(
            "defs",
            null,
            h(
              "linearGradient",
              { id: sheenId, x1: "0", y1: "0", x2: "0", y2: "1" },
              h("stop", { offset: "0%", stopColor: "#ffffff", stopOpacity: "0.95" }),
              h("stop", { offset: "34%", stopColor: "#ffffff", stopOpacity: "0.28" }),
              h("stop", { offset: "62%", stopColor: "#ffffff", stopOpacity: "0" })
            )
          ),
          h("ellipse", { cx: "80", cy: "10", rx: "58", ry: "18", fill: "rgba(255,255,255,0.72)" }),
          h("rect", { x: "0", y: "0", width: "160", height: "52", fill: `url(#${sheenId})` })
        )
      )
    ),
    MEDIA_GLASS_OPTIONS.map((option) => {
      const selected = option.value === MEDIA_GLASS_OPTIONS[index].value;
      return h(
        "button",
        {
          key: option.value,
          type: "button",
          className: "mgs-option",
          role: "radio",
          "aria-checked": selected ? "true" : "false",
          tabIndex: selected ? 0 : -1,
          "data-value": option.value,
        },
        h("span", { className: "mgs-icon", "aria-hidden": "true" }, mediaGlassIcon(h, option.icon)),
        h("span", { className: "mgs-label" }, option.label)
      );
    })
  );
}

window.MediaGlassSelect = MediaGlassSelect;
window.MEDIA_GLASS_OPTIONS = MEDIA_GLASS_OPTIONS;
