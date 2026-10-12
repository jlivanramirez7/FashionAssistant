// Troubleshooting: the "Save troubleshooting data" toggle and the saved
// reports (one per scan). One tap copies a report as text (to paste into a
// chat / bug report); each report can also be downloaded as a .zip (report
// + photos, replayable with replay.html) or deleted.
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
import { button, copyTextFrom, h, screen, setChildren, topBar } from "../dom";
import { formatDateTime } from "../format";

const OUTCOME_LABEL: Record<DiagReport["outcome"], string> = {
  "in-progress": "In progress",
  results: "Measured",
  retake: "Asked to retake",
  error: "Error",
};

/** Report texts fetched ahead so Copy is instant. */
const PREFETCH = 3;

export function render(root: HTMLElement, ctx: AppContext): () => void {
  let alive = true;
  const { root: el, body, actions } = screen("screen-diagnostics");

  const toggle = h("input", { type: "checkbox" });
  toggle.checked = diagnosticsEnabled();
  toggle.addEventListener("change", () => setDiagnosticsEnabled(toggle.checked));

  const uploading = h("p", { class: "notice", role: "status" });
  uploading.hidden = true;
  const toast = h("p", { class: "notice diag-toast", role: "status" });
  toast.hidden = true;
  const list = h("div", { class: "diag-list" }, h("p", { class: "muted" }, "Loading reports..."));

  body.append(
    topBar("Troubleshooting", () => ctx.dispatch({ type: "BACK" })),
    h("section", { class: "card" },
      h("label", { class: "check" }, toggle, h("span", null, "Save troubleshooting data")),
      h("p", { class: "hint-text" },
        "When on, each scan uploads its photos, the per-frame pipeline results and the on-screen feedback to your account. " +
          "After a failed scan, tap Copy latest report and paste it into your message. Each report shows when it was made and the app version.",
      ),
    ),
    uploading,
    toast,
    list,
  );
  root.appendChild(el);

  const poll = setInterval(() => {
    const n = pendingFrameUploads();
    uploading.hidden = n === 0;
    uploading.textContent = `Uploading ${n} photo${n === 1 ? "" : "s"} from your last scan...`;
  }, 1000);

  // ---------------------------------------------------------------- copy

  const texts = new Map<string, Promise<string>>();
  function textFor(id: string): Promise<string> {
    let t = texts.get(id);
    if (!t) {
      t = getDiagReportText(id);
      t.catch(() => texts.delete(id)); // retry on the next tap
      texts.set(id, t);
    }
    return t;
  }

  let toastTimer = 0;
  function say(msg: string): void {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), 4000);
  }

  /** One tap: fetch (if needed) and copy the report text. */
  function copyReport(id: string, btn: HTMLButtonElement): void {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Copying...";
    copyTextFrom(textFor(id))
      .then(() => {
        btn.textContent = "Copied ✓";
        say("Report copied. Paste it into your message.");
      })
      .catch((e: unknown) => {
        btn.textContent = label;
        say(`Could not copy: ${errorMessage(e)}. Open the report and copy the text manually.`);
      })
      .finally(() => {
        btn.disabled = false;
        window.setTimeout(() => {
          if (alive) btn.textContent = label;
        }, 2500);
      });
  }

  // ---------------------------------------------------------------- rows

  function detail(report: DiagReport, row: HTMLElement): HTMLElement {
    const id = report.id!;
    const status = h("p", { class: "muted small", role: "status" }, "Loading report...");
    const text = h("textarea", { class: "diag-text", readonly: true, rows: 12, "aria-label": "Report text" });
    const thumbs = h("div", { class: "diag-thumbs" });

    Promise.all([getDiagReport(id), textFor(id)])
      .then(([full, txt]) => {
        if (!alive) return;
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

    const zip = h("a", { class: "btn secondary small", href: diagBundleUrl(id), download: `fa-report-${id}.zip` }, "Download .zip");
    const del = button("Delete", () => {
      if (!confirm("Delete this troubleshooting report and its photos?")) return;
      deleteDiagReport(id)
        .then(() => row.remove())
        .catch((e: unknown) => alert(`Could not delete: ${errorMessage(e)}`));
    }, "btn danger small");

    return h("div", { class: "diag-detail" }, status, thumbs, text, h("div", { class: "diag-actions" }, zip, del));
  }

  function reportRow(report: DiagReport): HTMLElement {
    const id = report.id!;
    let open: HTMLElement | null = null;
    const row = h("section", { class: "card diag-row" });
    const head = h("button", { class: "diag-head", type: "button", "aria-expanded": "false" },
      h("span", { class: "diag-date" }, formatDateTime(report.createdAt)),
      h("span", { class: `diag-outcome ${report.outcome}` }, OUTCOME_LABEL[report.outcome] ?? report.outcome),
      h("span", { class: "diag-summary muted small" },
        `v${report.appVersion} - ${report.attempts} run${report.attempts === 1 ? "" : "s"} - ${report.summary}`,
      ),
    );
    head.addEventListener("click", () => {
      if (open) {
        open.remove();
        open = null;
      } else {
        open = detail(report, row);
        row.appendChild(open);
      }
      head.setAttribute("aria-expanded", String(!!open));
    });
    const copyBtn: HTMLButtonElement = button("Copy", () => copyReport(id, copyBtn), "btn secondary small diag-copy");
    copyBtn.setAttribute("aria-label", `Copy the report from ${formatDateTime(report.createdAt)}`);
    row.appendChild(h("div", { class: "diag-bar" }, head, copyBtn));
    return row;
  }

  listDiagReports()
    .then((reports) => {
      if (!alive) return;
      const withId = reports.filter((r) => r.id);
      if (!withId.length) {
        setChildren(list, h("p", { class: "muted" }, "No reports yet. Turn the toggle on, then run a scan."));
        return;
      }
      for (const r of withId.slice(0, PREFETCH)) void textFor(r.id!).catch(() => undefined);
      setChildren(list, withId.map(reportRow));
      const latest: HTMLButtonElement = button("Copy latest report", () => copyReport(withId[0].id!, latest), "btn primary");
      setChildren(actions, latest);
    })
    .catch((e: unknown) => {
      if (alive) setChildren(list, h("p", { class: "error" }, `Could not load reports: ${errorMessage(e)}`));
    });

  return () => {
    alive = false;
    clearInterval(poll);
    clearTimeout(toastTimer);
  };
}
