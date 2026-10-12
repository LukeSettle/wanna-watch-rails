// Three-way liquid-glass selector. Controlled: pass value and onChange.
// Values are "movie" | "both" | "tv".

const MEDIA_GLASS_OPTIONS = [
  { value: "movie", label: "Movies" },
  { value: "both", label: "Both" },
  { value: "tv", label: "TV Shows" },
];

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
  const tintId = `mgs-tint-${uid}`;

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
          { className: "mgs-sheen", viewBox: "0 0 160 48", preserveAspectRatio: "none" },
          h(
            "defs",
            null,
            h(
              "linearGradient",
              { id: tintId, x1: "0", y1: "0", x2: "1", y2: "1" },
              h("stop", { offset: "0%", stopColor: "#8ec5ff", stopOpacity: "0.72" }),
              h("stop", { offset: "48%", stopColor: "#c4b5fd", stopOpacity: "0.55" }),
              h("stop", { offset: "100%", stopColor: "#67e8f9", stopOpacity: "0.38" })
            ),
            h(
              "linearGradient",
              { id: sheenId, x1: "0", y1: "0", x2: "0", y2: "1" },
              h("stop", { offset: "0%", stopColor: "#ffffff", stopOpacity: "0.92" }),
              h("stop", { offset: "42%", stopColor: "#ffffff", stopOpacity: "0.18" }),
              h("stop", { offset: "100%", stopColor: "#ffffff", stopOpacity: "0" })
            )
          ),
          h("rect", { x: "0", y: "0", width: "160", height: "48", fill: `url(#${tintId})` }),
          h("rect", { x: "0", y: "0", width: "160", height: "24", fill: `url(#${sheenId})` }),
          h("ellipse", { cx: "80", cy: "6", rx: "54", ry: "7", fill: "rgba(255,255,255,0.55)" })
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
        option.label
      );
    })
  );
}

window.MediaGlassSelect = MediaGlassSelect;
window.MEDIA_GLASS_OPTIONS = MEDIA_GLASS_OPTIONS;
