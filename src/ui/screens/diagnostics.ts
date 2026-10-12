// Troubleshooting: the "Save troubleshooting data" toggle and the saved
// reports (one per scan). Each report can be copied as text (to paste into
// a chat / bug report), downloaded as a .zip (report + photos, replayable
// with replay.html) or deleted.
import {
  deleteDiagReport,
  diagBundleUrl,
  diagFrameUrl,
  getDiagReport,
  getDiagReportText,
  listDiagReports,
} from "../../data/diagnostics";
import { pendingFrameUploads } from "../../diagnostics/recorder";
import { diagnosticsEnabled, setDiagnosticsEnabled } from "../../diagnostics/settings";
import type { DiagReport } from "../../types";
import { errorMessage, type AppContext } from "../context";
import { button, copyText, h, screen, setChildren, topBar } from "../dom";
import { formatDate } from "../format";

const OUTCOME_LABEL: Record<DiagReport["outcome"], string> = {
  "in-progress": "In progress",
  results: "Measured",
  retake: "Asked to retake",
  error: "Error",
};

export function render(root: HTMLElement, ctx: AppContext): () => void {
  let alive = true;
  const { root: el, body } = screen("screen-diagnostics");

  const toggle = h("input", { type: "checkbox" });
  toggle.checked = diagnosticsEnabled();
  toggle.addEventListener("change", () => setDiagnosticsEnabled(toggle.checked));

  const uploading = h("p", { class: "notice", role: "status" });
  uploading.hidden = true;
  const list = h("div", { class: "diag-list" }, h("p", { class: "muted" }, "Loading reports..."));

  body.append(
    topBar("Troubleshooting", () => ctx.dispatch({ type: "BACK" })),
    h("section", { class: "card" },
      h("label", { class: "check" }, toggle, h("span", null, "Save troubleshooting data")),
      h("p", { class: "hint-text" },
        "When on, each scan uploads its photos, the per-frame pipeline results and the on-screen feedback to your account. " +
          "After a failed scan, open its report below and tap Copy report to share it.",
      ),
    ),
    uploading,
    list,
  );
  root.appendChild(el);

  const poll = setInterval(() => {
    const n = pendingFrameUploads();
    uploading.hidden = n === 0;
    uploading.textContent = `Uploading ${n} photo${n === 1 ? "" : "s"} from your last scan...`;
  }, 1000);

  function detail(report: DiagReport, row: HTMLElement): HTMLElement {
    const id = report.id!;
    const status = h("p", { class: "muted small", role: "status" }, "Loading report...");
    const text = h("textarea", { class: "diag-text", readonly: true, rows: 12, "aria-label": "Report text" });
    const thumbs = h("div", { class: "diag-thumbs" });
    let loaded = "";

    Promise.all([getDiagReport(id), getDiagReportText(id)])
      .then(([full, txt]) => {
        if (!alive) return;
        loaded = txt;
        text.value = txt;
        status.textContent = "";
        const last = full.attempts[full.attempts.length - 1];
        setChildren(
          thumbs,
          (last?.frames ?? []).map((f) =>
            h("a", { href: diagFrameUrl(id, f.id), target: "_blank", rel: "noopener", title: `${f.view} #${f.index}` },
              h("img", { src: diagFrameUrl(id, f.id), alt: `${f.view} ${f.index}`, loading: "lazy" }),
            ),
          ),
        );
      })
      .catch((e: unknown) => {
        if (alive) status.textContent = `Could not load the report: ${errorMessage(e)}`;
      });

    const copyBtn = button("Copy report", () => {
      if (!loaded) return;
      copyText(loaded)
        .then(() => (status.textContent = "Copied. Paste it into your message."))
        .catch(() => {
          text.select();
          status.textContent = "Copy failed - the text is selected, copy it manually.";
        });
    }, "btn primary small");
    const zip = h("a", { class: "btn secondary small", href: diagBundleUrl(id), download: `fa-report-${id}.zip` }, "Download .zip");
    const del = button("Delete", () => {
      if (!confirm("Delete this troubleshooting report and its photos?")) return;
      deleteDiagReport(id)
        .then(() => row.remove())
        .catch((e: unknown) => alert(`Could not delete: ${errorMessage(e)}`));
    }, "btn danger small");

    return h("div", { class: "diag-detail" },
      status,
      thumbs,
      text,
      h("div", { class: "diag-actions" }, copyBtn, zip, del),
    );
  }

  function reportRow(report: DiagReport): HTMLElement {
    let open: HTMLElement | null = null;
    const row = h("section", { class: "card diag-row" });
    const head = h("button", { class: "diag-head", type: "button" },
      h("span", { class: "diag-date" }, formatDate(report.createdAt)),
      h("span", { class: `diag-outcome ${report.outcome}` }, OUTCOME_LABEL[report.outcome] ?? report.outcome),
      h("span", { class: "diag-summary muted small" }, `${report.attempts} run${report.attempts === 1 ? "" : "s"} - ${report.summary}`),
    );
    head.addEventListener("click", () => {
      if (open) {
        open.remove();
        open = null;
        return;
      }
      open = detail(report, row);
      row.appendChild(open);
    });
    row.appendChild(head);
    return row;
  }

  listDiagReports()
    .then((reports) => {
      if (!alive) return;
      if (!reports.length) {
        setChildren(list, h("p", { class: "muted" }, "No reports yet. Turn the toggle on, then run a scan."));
        return;
      }
      setChildren(list, reports.filter((r) => r.id).map(reportRow));
    })
    .catch((e: unknown) => {
      if (alive) setChildren(list, h("p", { class: "error" }, `Could not load reports: ${errorMessage(e)}`));
    });

  return () => {
    alive = false;
    clearInterval(poll);
  };
}
