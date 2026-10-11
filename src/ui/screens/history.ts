// S8 History: past scans newest first (date + subject), tap to open,
// swipe left to delete one; Validation summary; Delete all my data.
import { deleteAllMyData } from "../../data/deleteAll";
import { deleteScan, listScans } from "../../data/scans";
import type { ScanDoc } from "../../types";
import { errorMessage, type AppContext } from "../context";
import { button, h, listRow, screen, setChildren, topBar } from "../dom";
import { formatDate } from "../format";

const SWIPE_OPEN_PX = 60;

function scanRow(scan: ScanDoc, onOpen: () => void, onDelete: () => void): HTMLElement {
  const del = h("button", { class: "swipe-delete", type: "button" }, "Delete");
  const content = h("button", { class: "history-item", type: "button" },
    h("span", { class: "h-date" }, formatDate(scan.createdAt)),
    h("span", { class: "h-label" }, scan.subjectLabel || "me"),
    h("span", { class: "chev", "aria-hidden": "true" }, "›"),
  );
  const row = h("div", { class: "history-row" }, del, content);

  let startX = 0;
  let dx = 0;
  let dragging = false;
  let open = false;
  const setOffset = (px: number): void => {
    content.style.transform = px ? `translateX(${px}px)` : "";
  };
  content.addEventListener("pointerdown", (e) => {
    startX = e.clientX;
    dx = 0;
    dragging = true;
  });
  content.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dx = e.clientX - startX + (open ? -96 : 0);
    if (Math.abs(e.clientX - startX) > 8) setOffset(Math.min(0, Math.max(-120, dx)));
  });
  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    open = dx < -SWIPE_OPEN_PX;
    setOffset(open ? -96 : 0);
  };
  content.addEventListener("pointerup", end);
  content.addEventListener("pointercancel", end);
  content.addEventListener("click", () => {
    if (Math.abs(dx) > 8) return; // it was a swipe
    if (open) {
      open = false;
      setOffset(0);
      return;
    }
    onOpen();
  });
  del.addEventListener("click", () => {
    if (confirm(`Delete the scan from ${formatDate(scan.createdAt)}?`)) onDelete();
  });
  return row;
}

export function render(root: HTMLElement, ctx: AppContext): () => void {
  let alive = true;
  const uid = ctx.user?.uid;
  const { root: el, body } = screen("screen-history");
  const list = h("div", { class: "history-list" }, h("p", { class: "muted" }, "Loading..."));
  const status = h("p", { class: "error", role: "alert" });
  status.hidden = true;

  const confirmBox = h("div", { class: "card confirm" });
  confirmBox.hidden = true;

  body.append(
    topBar("History", () => ctx.dispatch({ type: "BACK" })),
    h("p", { class: "muted small subtitle" }, "Swipe a scan left to delete it."),
    h("div", { class: "card list" }, list),
    status,
    h("div", { class: "card list" },
      listRow("Validation summary", () => ctx.dispatch({ type: "OPEN_VALIDATION_SUMMARY" }), "Accuracy vs tape"),
      listRow("Delete all my data", () => {
        confirmBox.hidden = false;
      }, undefined, "danger"),
    ),
    confirmBox,
  );
  root.appendChild(el);

  const yes = button("Delete everything", () => {
    if (!uid) return;
    yes.disabled = true;
    yes.textContent = "Deleting...";
    deleteAllMyData(uid)
      .then(() => {
        ctx.scanCache.clear();
        // Server data, session, outbox and deviceId are gone: start fresh.
        location.reload();
      })
      .catch((e: unknown) => {
        if (!alive) return;
        yes.disabled = false;
        yes.textContent = "Delete everything";
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        status.textContent = offline
          ? "Connect to the internet to delete your data."
          : `Connect to the internet to delete your data. (${errorMessage(e)})`;
        status.hidden = false;
      });
  }, "btn danger");
  setChildren(
    confirmBox,
    h("p", null, "Delete all scans, devices and settings? This cannot be undone."),
    h("div", { class: "btn-row" }, button("Cancel", () => (confirmBox.hidden = true), "btn ghost"), yes),
  );

  function draw(scans: ScanDoc[]): void {
    if (scans.length === 0) {
      setChildren(list, h("p", { class: "muted empty" }, "No scans yet."));
      return;
    }
    setChildren(
      list,
      scans.map((s) =>
        scanRow(
          s,
          () => s.id && ctx.dispatch({ type: "OPEN_SCAN", scanId: s.id }),
          () => {
            if (!uid || !s.id) return;
            deleteScan(uid, s.id)
              .then(() => {
                ctx.scanCache.delete(s.id!);
                if (alive) draw(scans.filter((x) => x !== s));
              })
              .catch((e: unknown) => {
                status.textContent = `Could not delete: ${errorMessage(e)}`;
                status.hidden = false;
              });
          },
        ),
      ),
    );
  }

  if (uid) {
    listScans(uid)
      .then((scans) => {
        if (!alive) return;
        for (const s of scans) if (s.id) ctx.scanCache.set(s.id, s);
        draw(scans);
      })
      .catch((e: unknown) => {
        if (alive) setChildren(list, h("p", { class: "error" }, `Could not load scans: ${errorMessage(e)}`));
      });
  }

  return () => {
    alive = false;
  };
}
