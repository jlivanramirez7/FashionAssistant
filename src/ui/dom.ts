// Tiny DOM builder (no UI framework in v1).

type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;
export type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "class") {
        el.className = String(v);
      } else if (v === true) {
        el.setAttribute(k, "");
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: (Child | Child[])[]): void {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

/** Replace all children of `el`. */
export function setChildren(el: Element, ...children: (Child | Child[])[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Screen skeleton: optional header, scrolling body, bottom action area. */
export function screen(className: string): { root: HTMLElement; body: HTMLElement; actions: HTMLElement } {
  const body = h("div", { class: "screen-body" });
  const actions = h("div", { class: "screen-actions" });
  const root = h("section", { class: `screen ${className}` }, body, actions);
  return { root, body, actions };
}

export function button(label: string, onClick: () => void, cls = "btn"): HTMLButtonElement {
  const b = h("button", { class: cls, type: "button" }, label);
  b.addEventListener("click", onClick);
  return b;
}

export function linkButton(label: string, onClick: () => void): HTMLButtonElement {
  return button(label, onClick, "link");
}
